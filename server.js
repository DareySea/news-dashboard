// Дашборд мониторинга новостей. Без зависимостей: node server.js → http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const REPORTS = path.join(__dirname, 'reports');
const MAX_ITEMS = 1000; // на рабочую область
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const DEFAULT = {
  workspaces: [
    { id: 'news', name: 'Новостные агентства', interval: 10, keywords: [], reportTimes: ['09:00', '18:00'],
      sources: ['https://tass.ru/rss/v2.xml', 'https://ria.ru/export/rss2/archive/index.xml', 'https://www.interfax.ru/rss.asp'] },
    { id: 'gov', name: 'Госорганы', interval: 30, keywords: [], reportTimes: ['10:00'],
      sources: ['http://kremlin.ru/events/president/news/feed', 'http://government.ru/all/rss/'] },
    { id: 'tg', name: 'Телеграм-каналы', interval: 5, keywords: [], reportTimes: [],
      sources: ['@tass_agency', '@rian_ru'] },
  ],
  items: {}, state: {},
};

let db;
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { db = structuredClone(DEFAULT); }
function save() { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); }

// ---------- парсинг ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const strip = s => s.replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
// CDATA → сущности → теги → сущности (в RSS HTML часто экранирован), абзацы сохраняем как \n
function clean(s = '') {
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(strip(decode(s))).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
const toISO = s => { const d = new Date(clean(s)); return isNaN(d) ? null : d.toISOString(); };

function parseFeed(xml) {
  return (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []).map(b => {
    const tag = n => (b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')) || [])[1] || '';
    return {
      title: clean(tag('title')).replace(/\n/g, ' '),
      text: clean(tag('yandex:full-text') || tag('content:encoded') || tag('description') || tag('summary') || tag('content')),
      link: clean(tag('link')) || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || clean(tag('guid')),
      date: toISO(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date')),
    };
  });
}

function parseTelegram(html) {
  return html.split('class="tgme_widget_message_wrap').slice(1).map(p => {
    const post = (p.match(/data-post="([^"]+)"/) || [])[1];
    const text = clean((p.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    if (!post || !text) return null;
    return { ...require('./max.js').splitPost(text), link: 'https://t.me/' + post,
      date: toISO((p.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || ''),
      views: parseViews((p.match(/tgme_widget_message_views">([^<]+)/) || [])[1]) };
  }).filter(Boolean);
}

// shortcut: для сайтов без RSS берём ссылки с длинным текстом (≥40 симв.) того же домена — только заголовки; если у сайта есть RSS, лучше указать его
function parseLinks(html, base) {
  const host = new URL(base).host, seen = new Set(), out = [];
  for (const m of html.matchAll(/<a\s[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = clean(m[2]).replace(/\n/g, ' ');
    let link; try { link = new URL(decode(m[1]), base); } catch { continue; }
    if (title.length < 40 || link.host !== host || seen.has(link.href)) continue;
    seen.add(link.href); out.push({ title, text: '', link: link.href, date: null });
  }
  return out.slice(0, 60);
}

async function fetchText(url, timeout = 20000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ru,en' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const cs = (r.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1]
    || buf.subarray(0, 2048).toString('latin1').match(/(?:encoding|charset)=["']?([\w-]+)/i)?.[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

// MAX подключается лениво: без playwright-core остальной дашборд работает
const max = () => require('./max.js');
async function fetchSource(src) {
  if (/^https:\/\/web\.max\.ru\//.test(src)) return (await max().fetchMax(src)).map(i => ({ ...i, views: parseViews(i.views) }));
  const tg = src.match(/^@(\w+)$|t\.me\/(?:s\/)?(\w+)/);
  if (tg) {
    const ch = tg[1] || tg[2];
    return parseTelegram(await fetchText(`https://t.me/s/${ch}`)).map(i => ({ ...i, source: '@' + ch }));
  }
  const body = await fetchText(src);
  const items = isFeed(body) ? parseFeed(body) : parseLinks(body, src);
  return items.map(i => ({ ...i, source: new URL(src).host.replace(/^www\./, '') }));
}
// «9.79K», «32,4K», «1,2M», «845» → число просмотров
const parseViews = s => { const m = String(s || '').replace(',', '.').match(/([\d.]+)\s*([KkMmКкМм])?/); return m ? Math.round(+m[1] * ({ k: 1e3, к: 1e3, m: 1e6, м: 1e6 }[m[2]?.toLowerCase()] || 1)) : undefined; };
const isFeed = body => /<(rss|feed|rdf:RDF)[\s>]/i.test(body);

// ---------- проверка источника: пользователь вставляет ссылку, мы ищем, как её мониторить ----------
// shortcut: типовые адреса лент российских и WordPress-сайтов; если сайт прячет RSS по другому адресу — пользователь вставит ссылку на ленту сам
const FEED_GUESSES = ['/rss', '/rss/', '/feed', '/feed/', '/rss.xml', '/feed.xml', '/index.rss', '/rss/all', '/rss.php', '/rss.asp',
  '/rss/index.xml', '/rss/v2.xml', '/news/rss', '/news/rss/', '/export/rss2/index.xml', '/all/rss/'];
async function checkSource(raw) {
  const s = String(raw).trim();
  const tg = s.match(/^@(\w+)$|^(?:https?:\/\/)?t\.me\/(?:s\/)?(\w+)/);
  if (tg) return verdict('@' + (tg[1] || tg[2]), 'telegram', await fetchSource('@' + (tg[1] || tg[2])));
  const mx = max().maxUrl(s);
  if (mx) {
    try { const items = await max().fetchMax(mx); return verdict(items[0]?.link.split('#')[0] || mx, 'max', items); }
    catch (e) { return { source: mx, ok: false, kind: 'error', message: 'MAX: ' + e.message }; }
  }
  // без протокола пробуем https, затем http (kremlin.ru, government.ru отвечают только по http)
  const tries = /^https?:\/\//i.test(s) ? [s, s.replace(/^https:/i, 'http:')] : ['https://' + s, 'http://' + s];
  let url, body, err;
  for (const t of new Set(tries)) {
    url = new URL(t).href;
    try { body = await fetchText(url, 10000); break; } catch (e) { err = e; }
  }
  if (body && isFeed(body)) return verdict(url, 'rss', parseFeed(body));
  // RSS, объявленный в <head>, и типовые адреса; пробуем их, даже если сама страница закрыта — ленты часто открыты
  const declared = [...(body || '').matchAll(/<link\b[^>]*>/gi)].map(m => m[0])
    .filter(t => /rel=["']?alternate/i.test(t) && /(rss|atom)\+xml/i.test(t) && !/comment/i.test(t))
    .map(t => t.match(/href=["']([^"']+)/i)?.[1]).filter(Boolean);
  const linked = [...(body || '').matchAll(/<a\s[^>]*href=["']([^"'#]*(?:rss|feed)[^"'#]*)["']/gi)].map(m => m[1]);
  const abs = list => [...new Set(list.map(h => { try { return new URL(decode(h), url).href; } catch { return null; } }).filter(Boolean))];
  // сначала то, что указал сам сайт, потом догадки — меньше запросов, сайты госорганов режут частые обращения
  for (const cands of [abs([...declared, ...linked]).slice(0, 8), abs(FEED_GUESSES)]) {
    const feeds = await Promise.all(cands.map(c => fetchText(c, 8000).then(b => isFeed(b) ? parseFeed(b) : null, () => null)));
    const k = feeds.findIndex(f => f?.length);
    if (k >= 0) return verdict(cands[k], 'rss', feeds[k]);
  }
  if (!body) return { source: tries[0], ok: false, kind: 'error', message: `Сайт не открывается (${err.cause?.code || err.message}) — защита от ботов или неверный адрес` };
  return verdict(url, 'html', parseLinks(body, url));
}
function verdict(source, kind, items) {
  const n = items.length;
  const message = !n && kind === 'telegram' ? 'Канал не найден, закрытый или без публичной веб-версии'
    : !n ? 'Новости не найдены: страница, вероятно, собирается скриптом или закрыта защитой. Попробуйте ссылку на раздел новостей'
    : kind === 'rss' ? `RSS-лента найдена: ${n} материалов, заголовки и текст`
    : kind === 'telegram' ? `Телеграм-канал: ${n} сообщений`
    : kind === 'max' ? `Канал MAX: ${n} сообщений`
    : `RSS нет — будут собираться только заголовки (${n} найдено)`;
  return { source, kind, ok: n > 0, message, sample: items.slice(0, 3).map(i => i.title) };
}

// ---------- мониторинг ----------
const busy = new Map(); // id → идущее обновление, повторный вызов ждёт его
const refresh = ws => busy.get(ws.id) || (busy.set(ws.id, doRefresh(ws).finally(() => busy.delete(ws.id))), busy.get(ws.id));
async function doRefresh(ws) {
  {
    const st = db.state[ws.id] ??= {};
    const list = db.items[ws.id] ??= [];
    const known = new Map(list.map(i => [i.link, i]));
    const res = await Promise.allSettled(ws.sources.map(fetchSource));
    st.errors = {};
    const now = new Date().toISOString();
    res.forEach((r, k) => {
      if (r.status === 'rejected') return void (st.errors[ws.sources[k]] = String(r.reason?.cause?.code || r.reason?.message || r.reason));
      for (const it of r.value) {
        if (!it.link || !it.title) continue;
        const old = known.get(it.link);
        if (old) { if (it.views > (old.views || 0)) old.views = it.views; continue; } // просмотры растут — обновляем
        const item = { ...it, date: it.date || now, found: now };
        known.set(it.link, item);
        list.push(item);
      }
    });
    list.sort((a, b) => b.date.localeCompare(a.date)).splice(MAX_ITEMS);
    if (ws.keywords.length) await fetchFullTexts(list);
    st.lastFetch = Date.now();
    save();
  }
}

// Полный текст статьи нужен для поиска по ключевым словам: в RSS обычно только первый абзац.
// shortcut: не больше 60 статей за обновление (сначала свежие), по 4 параллельно — остальные догрузятся в следующие обновления
async function fetchFullTexts(list) {
  const todo = list.filter(i => !('full' in i) && /^https?:\/\//.test(i.link) && !/^https:\/\/(t\.me|web\.max\.ru)\//.test(i.link)).slice(0, 60);
  for (let k = 0; k < todo.length; k += 4) {
    await Promise.all(todo.slice(k, k + 4).map(async i => {
      // '' = пробовали, не вышло (сайт закрыт или страница строится скриптом) — больше не запрашиваем
      i.full = await article(i.link).catch(() => null) || '';
    }));
  }
}

// подстрочный поиск без учёта регистра по заголовку, анонсу и полному тексту: «выбор» найдёт «выборы», «выборах»
const matches = (it, kws) => !kws.length || kws.some(k => (it.title + ' ' + it.text + ' ' + (it.full || '')).toLowerCase().includes(k.toLowerCase()));
const filtered = ws => (db.items[ws.id] || []).filter(i => matches(i, ws.keywords));

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = d => new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---------- популярность ----------
// Один сюжет у нескольких источников = заметная новость. Склеиваем по общим основам слов в заголовках.
const STOP = new Set(['заяви', 'сообщ', 'котор', 'может', 'будет', 'также', 'после', 'более', 'время', 'стало', 'назва', 'расск', 'приня',
  'проти', 'новых', 'новые', 'новый', 'росси', 'облас', 'челов', 'жител', 'район', 'город']);
const stems = t => new Set((t.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{4,}/g) || []).map(w => w.slice(0, 5)).filter(w => !STOP.has(w)));
function stories(items) {
  const groups = [];
  for (const it of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const s = stems(it.title);
    const g = groups.find(g => { let k = 0; for (const w of s) if (g.stems.has(w)) k++; return k >= 3 && k / Math.min(s.size, g.stems.size) >= 0.5; });
    if (g) g.items.push(it); else groups.push({ stems: s, items: [it] });
  }
  return groups.map(g => ({ items: g.items, sources: new Set(g.items.map(i => i.source)).size, views: Math.max(0, ...g.items.map(i => i.views || 0)) }));
}
// shortcut: «много просмотров» = верхние 20% постов своего канала за период; свежие посты к отчёту ещё не набрали просмотров,
// а старые сравниваются по числу на момент последнего показа в ленте канала — для утреннего дайджеста этого достаточно
function hotPosts(items) {
  const hot = new Set(), bySrc = {};
  for (const i of items) if (i.views) (bySrc[i.source] ??= []).push(i);
  for (const list of Object.values(bySrc)) {
    if (list.length < 5) continue;
    const cut = list.map(i => i.views).sort((a, b) => b - a)[Math.floor(list.length * 0.2)];
    for (const i of list) if (i.views > cut) hot.add(i);
  }
  return hot;
}
function popular(items) {
  const hot = hotPosts(items);
  return stories(items).filter(g => g.sources >= 2 || g.items.some(i => hot.has(i)))
    // сюжет одного канала открываем самым просматриваемым постом, сюжет нескольких источников — самым ранним
    .map(g => g.sources > 1 ? g : { ...g, items: [...g.items].sort((a, b) => (b.views || 0) - (a.views || 0)) })
    .sort((a, b) => b.sources - a.sources || b.views - a.views);
}

const fmtViews = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const reportItem = (i, extra = '') => `<li><small>${fmt(i.date)} · ${esc(i.source)}${i.views ? ' · 👁 ' + fmtViews(i.views) : ''}</small><br>
<a href="${esc(i.link)}"><b>${esc(i.title)}</b></a><br>${esc(i.text.split('\n')[0])}${extra}</li>`;

function makeReport(ws) {
  const st = db.state[ws.id] ??= {};
  const since = st.lastReportAt || Date.now() - 864e5;
  const period = (db.items[ws.id] || []).filter(i => Date.parse(i.found) > since);
  const { popular: wantPop, keywords: wantKw } = ws.report || {};
  let body = '', total = 0;
  if (wantPop) {
    const groups = popular(period);
    total += groups.length;
    body += `<h2>Популярное — ${groups.length}</h2><p class="note">Сюжеты, о которых написали несколько источников, и посты каналов с наибольшим числом просмотров.</p><ol>
${groups.map(g => { const [lead, ...rest] = g.items;
      const others = [...new Map(rest.filter(i => i.source !== lead.source).map(i => [i.source, i])).values()]; // по одной ссылке на источник
      return reportItem(lead, g.sources > 1 ? `<br><small>Сюжет в ${g.sources} источниках, также: ${others.map(i => `<a href="${esc(i.link)}">${esc(i.source)}</a>`).join(', ')}</small>` : ''); }).join('\n')}</ol>`;
  }
  if (wantKw) {
    const shown = new Set(wantPop ? popular(period).flatMap(g => g.items) : []);
    const kw = ws.keywords.length ? period.filter(i => matches(i, ws.keywords) && !shown.has(i)) : [];
    total += kw.length;
    body += `<h2>По ключевым словам — ${kw.length}</h2><p class="note">${ws.keywords.length ? esc(ws.keywords.join(', ')) + (wantPop ? '. Без новостей, уже попавших в «Популярное».' : '') : 'Ключевые слова не заданы в настройках области.'}</p><ol>
${kw.map(i => reportItem(i)).join('\n')}</ol>`;
  }
  if (!wantPop && !wantKw) {
    const all = period.filter(i => matches(i, ws.keywords));
    total = all.length;
    body = `<p class="note">${ws.keywords.length ? 'Ключевые слова: ' + esc(ws.keywords.join(', ')) : 'Все новости области'}</p><ol>${all.map(i => reportItem(i)).join('\n')}</ol>`;
  }
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 5).replace(':', '-')}`;
  const file = `${ws.id}_${stamp}.html`;
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, file), `<!doctype html><meta charset="utf-8"><title>${esc(ws.name)} — ${stamp}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2em auto;padding:0 1em}li{margin:0 0 1em}small,.note{color:#666}h2{margin-top:1.6em}</style>
<h1>${esc(ws.name)}</h1><p>Отчёт за период ${fmt(since)} — ${fmt(now)}. Всего новостей за период: ${period.length}, в отчёте: ${total}.</p>
${body}`);
  st.lastReportAt = now.getTime();
  save();
  return file;
}

async function tick() {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes(), day = now.toDateString();
  for (const ws of db.workspaces) {
    const st = db.state[ws.id] ??= {};
    // отчёт догоняется в течение 10 минут, если в нужную минуту шло обновление
    const due = ws.reportTimes.filter(t => { const [h, m] = t.split(':'); const d = mins - (h * 60 + +m); return d >= 0 && d <= 10 && st['rep' + t] !== day; });
    try {
      if (due.length || Date.now() - (st.lastFetch || 0) >= ws.interval * 60000) await refresh(ws);
      for (const t of due) { st['rep' + t] = day; makeReport(ws); }
    } catch (e) { console.error(ws.name, e); }
  }
}

// ---------- статья целиком для диалогового окна ----------
async function article(url) {
  if (/^https:\/\/(t\.me|web\.max\.ru)\//.test(url)) return null; // у мессенджеров текст уже есть в ленте
  const html = await fetchText(url);
  const scope = (html.match(/<article[\s>][\s\S]*?<\/article>/i) || [html])[0];
  // <p> — большинство сайтов; div.article__text — РИА
  const ps = [...scope.matchAll(/<p[\s>][\s\S]*?<\/p>|<div class="article__text"[^>]*>[\s\S]*?<\/div>/gi)].map(m => clean(m[0]).replace(/\n/g, ' ')).filter(t => t.length > 40);
  return ps.join('\n') || null;
}

// ---------- календарь: свои события + Google Календарь по секретному iCal-адресу (только чтение) ----------
db.calendar ??= { events: [], ics: '' };

function icsDate(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m.map(x => x && /^\d+$/.test(x) ? +x : x);
  if (h === undefined) return { date: new Date(y, mo - 1, d), allDay: true };
  // shortcut: время с TZID считаем местным временем компьютера — верно, пока календарь и компьютер в одном часовом поясе
  return { date: z ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s), allDay: false };
}

function parseIcs(text) {
  const evs = [];
  for (const block of text.replace(/\r?\n[ \t]/g, '').split('BEGIN:VEVENT').slice(1)) {
    const props = {};
    for (const line of block.split('END:VEVENT')[0].split(/\r?\n/)) {
      const m = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/);
      if (m) (props[m[1]] ??= []).push(m[2]);
    }
    const get = k => props[k]?.[0], txt = s => (s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
    const start = icsDate(get('DTSTART'));
    if (!start) continue;
    const end = icsDate(get('DTEND'))?.date || new Date(+start.date + (start.allDay ? 864e5 : 0));
    evs.push({ uid: get('UID'), title: txt(get('SUMMARY')) || '(без названия)', note: txt(get('DESCRIPTION')), place: txt(get('LOCATION')),
      start: start.date, end, allDay: start.allDay, rrule: get('RRULE'), cancelled: get('STATUS') === 'CANCELLED',
      recurrence: icsDate(get('RECURRENCE-ID'))?.date, exdates: new Set((props.EXDATE || []).flatMap(v => v.split(',')).map(v => +icsDate(v)?.date)) });
  }
  // изменённые и отменённые повторы (RECURRENCE-ID) заменяют исходное повторение
  for (const o of evs.filter(e => e.recurrence)) evs.find(e => e.uid === o.uid && e.rrule)?.exdates.add(+o.recurrence);
  return evs.filter(e => !e.cancelled);
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// Начала повторений события в окне [from, to).
// shortcut: RRULE поддержан для FREQ=DAILY/WEEKLY/MONTHLY/YEARLY с INTERVAL, COUNT, UNTIL и BYDAY у недельных;
// «каждый второй вторник месяца» (BYDAY у месячных) повторится в то же число — если такие встречи важны, нужен полный разбор RRULE
function occurrences(ev, from, to) {
  const dur = ev.end - ev.start, hit = s => +s + dur > +from && s < to && !ev.exdates.has(+s);
  if (!ev.rrule) return hit(ev.start) ? [ev.start] : [];
  const r = Object.fromEntries(ev.rrule.split(';').map(p => p.split('=')));
  const step = +r.INTERVAL || 1, count = +r.COUNT || Infinity, until = icsDate(r.UNTIL)?.date;
  const byday = r.FREQ === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',').map(d => DAYS.indexOf(d.slice(-2))) : null;
  const out = [];
  for (let k = 0, n = 0; k < 20000; k++) {
    const base = new Date(ev.start);
    if (r.FREQ === 'DAILY') base.setDate(base.getDate() + k * step);
    else if (r.FREQ === 'WEEKLY') base.setDate(base.getDate() + 7 * k * step);
    else if (r.FREQ === 'MONTHLY') base.setMonth(base.getMonth() + k * step);
    else if (r.FREQ === 'YEARLY') base.setFullYear(base.getFullYear() + k * step);
    else return hit(ev.start) ? [ev.start] : [];
    let starts = [base];
    if (byday) { // дни той же недели, неделя с понедельника
      const mon = new Date(base); mon.setDate(base.getDate() - (base.getDay() + 6) % 7);
      starts = byday.map(d => { const x = new Date(mon); x.setDate(mon.getDate() + (d + 6) % 7); return x; }).sort((a, b) => a - b).filter(x => x >= ev.start);
    }
    for (const s of starts) {
      if ((until && s > until) || n >= count || s >= to) return out;
      n++;
      if (hit(s)) out.push(s);
    }
  }
  return out;
}

let icsCache = { at: 0, url: '', events: [], error: null };
async function googleEvents() {
  const url = db.calendar.ics;
  if (!url) return [];
  if (icsCache.url !== url || Date.now() - icsCache.at > 10 * 60000) {
    try { icsCache = { at: Date.now(), url, events: parseIcs(await fetchText(url)), error: null }; }
    catch (e) { icsCache = { ...icsCache, at: Date.now(), url, error: String(e.cause?.code || e.message) }; }
  }
  return icsCache.events;
}

// scope: 'work' — свои события и Google, 'holidays' — праздники РБК
async function calendarRange(from, to, scope) {
  if (scope === 'holidays') {
    const hidden = new Set(db.calendar.hiddenHolidays || []);
    return loadHolidays().filter(h => !hidden.has(h.id)).map(h => {
      const [y, m, d] = h.date.split('-').map(Number), start = new Date(y, m - 1, d);
      return { id: h.id, source: 'holiday', kind: h.kind, title: h.title, note: '', place: '', allDay: true, start, end: new Date(+start + 864e5 - 1) };
    }).filter(e => e.end >= from && e.start < to);
  }
  const local = db.calendar.events.map(e => {
    const [y, m, d] = e.date.split('-').map(Number), at = t => { const [h, mi] = t.split(':'); return new Date(y, m - 1, d, +h, +mi); };
    const start = e.start ? at(e.start) : new Date(y, m - 1, d);
    return { id: e.id, source: 'local', title: e.title, note: e.note, place: '', allDay: !e.start,
      start, end: e.end ? at(e.end) : new Date(+start + (e.start ? 0 : 864e5 - 1)) };
  }).filter(e => e.end >= from && e.start < to);
  const google = (await googleEvents()).flatMap(ev => occurrences(ev, from, to).map(s => ({ source: 'google', title: ev.title, note: ev.note, place: ev.place,
    allDay: ev.allDay, start: s, end: new Date(+s + (ev.end - ev.start)) })));
  return [...local, ...google].sort((a, b) => a.start - b.start);
}

// праздники РБК из holidays.json (обновить: node holidays.js); перечитываем, если файл обновили
let holidaysCache = { mtime: 0, items: [] };
function loadHolidays() {
  try {
    const f = path.join(__dirname, 'holidays.json'), mtime = fs.statSync(f).mtimeMs;
    if (mtime !== holidaysCache.mtime) holidaysCache = { mtime, items: JSON.parse(fs.readFileSync(f, 'utf8')).items.map(h => ({ ...h, id: 'h:' + h.date + ':' + h.title })) };
  } catch { holidaysCache = { mtime: 0, items: [] }; }
  return holidaysCache.items;
}

function validEvent(e) {
  const title = String(e.title || '').trim().slice(0, 200), time = t => t ? /^([01]\d|2[0-3]):[0-5]\d$/.test(t) && t : '';
  if (!title) throw new Error('у события должно быть название');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || isNaN(new Date(e.date))) throw new Error('неверная дата');
  const start = time(e.start), end = time(e.end);
  if (start === false || end === false) throw new Error('время в формате ЧЧ:ММ');
  if (end && (!start || end < start)) throw new Error('время окончания раньше начала');
  return { id: 'ev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, date: e.date, start, end, note: String(e.note || '').slice(0, 2000) };
}

// ---------- HTTP ----------
function validWorkspaces(arr) {
  if (!Array.isArray(arr)) throw new Error('ожидается массив');
  return arr.map(w => {
    const list = v => (Array.isArray(v) ? v : []).map(s => String(s).trim()).filter(Boolean);
    const ws = { id: String(w.id || '').replace(/\W/g, '') || 'ws' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: String(w.name || 'Без названия').slice(0, 100), sources: list(w.sources), keywords: list(w.keywords),
      interval: Math.max(1, Math.min(1440, parseInt(w.interval) || 15)), reportTimes: list(w.reportTimes).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)),
      report: { popular: !!w.report?.popular, keywords: !!w.report?.keywords } };
    for (const s of ws.sources) if (!/^@\w+$/.test(s) && !/^https?:\/\//.test(s)) throw new Error('источник должен быть URL или @канал: ' + s);
    return ws;
  });
}

const readBody = req => new Promise((ok, fail) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => ok(b)); req.on('error', fail); });

// Вход по паролю: на сервере в интернете задаётся DASH_PASSWORD (дома, без переменной, пароль не спрашивается).
// Логин любой, проверяется только пароль. После 10 неверных попыток за 15 минут с одного адреса — пауза.
const PASSWORD = process.env.DASH_PASSWORD || '';
const failures = new Map(); // адрес → [время неудачных попыток]
function checkAuth(req, res) {
  if (!PASSWORD) return true;
  // сервер слушает только 127.0.0.1, поэтому X-Forwarded-For может прийти лишь от нашего Caddy
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const recent = (failures.get(ip) || []).filter(t => Date.now() - t < 15 * 60000);
  if (recent.length >= 10) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '900' }); res.end('Слишком много попыток входа. Подождите 15 минут.'); return false; }
  const [type, b64] = String(req.headers.authorization || '').split(' ');
  const given = type === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString('utf8').split(':').slice(1).join(':') : null;
  const hash = s => crypto.createHash('sha256').update(s).digest();
  if (given !== null && crypto.timingSafeEqual(hash(given), hash(PASSWORD))) { failures.delete(ip); return true; }
  if (given !== null) failures.set(ip, [...recent, Date.now()]);
  res.writeHead(401, { 'www-authenticate': 'Basic realm="News dashboard", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
  res.end('Нужен пароль от дашборда.');
  return false;
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req, res)) return;
  const u = new URL(req.url, 'http://x');
  const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)); };
  const ws = db.workspaces.find(w => w.id === u.searchParams.get('ws'));
  try {
    // JSON-заголовок вынуждает браузер делать preflight: чужие страницы не смогут дёргать API
    if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') return json({ error: 'нужен content-type: application/json' }, 415);
    if (u.pathname === '/api/max/login' && req.method === 'GET') return json(await max().loginState());
    if (u.pathname === '/api/max/login' && req.method === 'DELETE') { await max().cancelLogin(); return json({ ok: true }); }
    if (u.pathname === '/api/check' && req.method === 'POST') return json(await checkSource(JSON.parse(await readBody(req)).url));
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res); }
    if (['/calendar.js', '/tv.js'].includes(u.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, u.pathname.slice(1))).pipe(res); }
    if (u.pathname === '/api/calendar' && req.method === 'GET') {
      const from = new Date(u.searchParams.get('from')), to = new Date(u.searchParams.get('to'));
      if (isNaN(from) || isNaN(to) || to - from > 100 * 864e5) return json({ error: 'неверный период' }, 400);
      const scope = u.searchParams.get('scope') === 'holidays' ? 'holidays' : 'work';
      const events = await calendarRange(from, to, scope);
      if (scope === 'holidays') return json({ events });
      return json({ events, google: { connected: !!db.calendar.ics, error: db.calendar.ics ? icsCache.error : null, at: icsCache.at || null } });
    }
    if (u.pathname === '/api/calendar/events' && req.method === 'POST') {
      const ev = validEvent(JSON.parse(await readBody(req)));
      db.calendar.events.push(ev); save(); return json(ev);
    }
    if (u.pathname === '/api/calendar/events' && req.method === 'DELETE') {
      const id = u.searchParams.get('id');
      if (id.startsWith('h:')) (db.calendar.hiddenHolidays ??= []).push(id); // праздник скрываем, файл РБК не трогаем
      else db.calendar.events = db.calendar.events.filter(e => e.id !== id);
      save(); return json({ ok: true });
    }
    if (u.pathname === '/api/calendar/google' && req.method === 'PUT') {
      const url = String(JSON.parse(await readBody(req)).url || '').trim();
      if (url) {
        if (!/^https:\/\//.test(url)) return json({ error: 'нужен адрес, начинающийся с https://' }, 400);
        let text;
        try { text = await fetchText(url); } catch (e) { return json({ error: 'календарь не открылся: ' + (e.cause?.code || e.message) }, 400); }
        if (!/BEGIN:VCALENDAR/.test(text)) return json({ error: 'по этому адресу нет календаря в формате iCal' }, 400);
        icsCache = { at: Date.now(), url, events: parseIcs(text), error: null };
      }
      db.calendar.ics = url; save(); return json({ connected: !!url, count: url ? icsCache.events.length : 0 });
    }
    if (u.pathname === '/api/workspaces' && req.method === 'GET')
      return json(db.workspaces.map(w => ({ ...w, lastFetch: db.state[w.id]?.lastFetch, errors: db.state[w.id]?.errors || {}, busy: busy.has(w.id) })));
    if (u.pathname === '/api/workspaces' && req.method === 'PUT') {
      db.workspaces = validWorkspaces(JSON.parse(await readBody(req)));
      for (const id of Object.keys(db.items)) if (!db.workspaces.some(w => w.id === id)) { delete db.items[id]; delete db.state[id]; }
      save(); tick(); return json(db.workspaces);
    }
    if (u.pathname === '/api/items' && ws) return json(filtered(ws));
    if (u.pathname === '/api/refresh' && ws && req.method === 'POST') { await refresh(ws); return json({ ok: true }); }
    if (u.pathname === '/api/report' && ws && req.method === 'POST') { await refresh(ws); return json({ file: makeReport(ws) }); }
    if (u.pathname === '/api/reports') {
      const files = fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter(f => f.endsWith('.html')) : [];
      return json(files.sort((a, b) => b.split('_').slice(1).join().localeCompare(a.split('_').slice(1).join())).slice(0, 100));
    }
    if (u.pathname.startsWith('/reports/')) {
      const f = path.join(REPORTS, path.basename(decodeURIComponent(u.pathname)));
      if (!fs.existsSync(f)) return json({ error: 'нет файла' }, 404);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(f).pipe(res);
    }
    if (u.pathname === '/api/article') {
      const url = u.searchParams.get('url');
      // только ссылки из собранной ленты — сервер не ходит по произвольным адресам
      if (!Object.values(db.items).some(l => l.some(i => i.link === url))) return json({ error: 'неизвестная ссылка' }, 400);
      return json({ text: await article(url) });
    }
    json({ error: 'not found' }, 404);
  } catch (e) { json({ error: e.message }, 400); }
});

if (require.main === module) {
  // слушаем только этот компьютер; на сервере наружу дашборд открывает Caddy (HTTPS)
  server.listen(PORT, '127.0.0.1', () => console.log(`Дашборд: http://localhost:${PORT}${PASSWORD ? ' (вход по паролю)' : ''}`));
  setInterval(tick, 60000); tick();
}
module.exports = { parseIcs, occurrences, validEvent, checkSource, parseViews, popular, clean, parseFeed, parseTelegram, parseLinks, matches, validWorkspaces };
