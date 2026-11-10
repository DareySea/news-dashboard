// Календарь с двумя подразделами: «Работа» (свои события + Google Календарь) и «Праздники» (РБК).
// Использует $, esc, fmt, api, current и calendarOn из index.html.
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const KIND_ORDER = { official: 0, russia: 1, prof: 2, intl: 3, fun: 4 };
const KIND_LABEL = { official: 'Государственный праздник', russia: 'Россия', prof: 'Профессиональный', intl: 'Международный', fun: 'Шуточный' };
const KIND_SHORT = { official: 'Государственные', russia: 'Россия', prof: 'Профессиональные', intl: 'Международные', fun: 'Шуточные' };

let calMonth = new Date(); calMonth.setDate(1); calMonth.setHours(0, 0, 0, 0);
let calScope = localStorage.calScope === 'holidays' ? 'holidays' : 'work';
let calEvents = [], calGoogle = {};
let holKinds = new Set(JSON.parse(localStorage.holKinds || 'null') || Object.keys(KIND_ORDER));
// месяцы, которые уже загружали: при переключении рисуем сразу, а свежие данные подтягиваем следом
const calCache = new Map();
const cacheKey = () => calScope + ':' + ymd(calMonth);

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = d => d.toTimeString().slice(0, 5);
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const gridStart = month => { const s = new Date(month); s.setDate(1 - (month.getDay() + 6) % 7); return s; }; // с понедельника

// scope: 'work' | 'holidays' | false (закрыть календарь)
function showCalendar(scope) {
  calendarOn = !!scope;
  if (scope && typeof tvOn !== 'undefined' && tvOn) showTv(false); localStorage.view = scope ? 'calendar' : 'ws';
  if (scope) { calScope = scope; localStorage.calScope = scope; }
  $('calView').hidden = !scope; $('wsHeader').hidden = !!scope; $('feed').hidden = !!scope;
  $('calView').dataset.scope = calScope; dayDlg.dataset.scope = calScope;
  document.querySelectorAll('#calNav button').forEach(b => b.setAttribute('aria-current', !!scope && b.dataset.scope === calScope));
  document.querySelectorAll('#wsList button').forEach(b => b.setAttribute('aria-current', !scope && b.dataset.id === current));
  if (scope) loadCalendar();
}

// события, которые идут в этот день (включая многодневные)
function eventsOn(d) {
  const a = new Date(d), b = new Date(d); b.setDate(b.getDate() + 1);
  return calEvents.filter(e => ((e.start < b && e.end > a) || +e.start === +a) && (e.source !== 'holiday' || holKinds.has(e.kind)));
}
const sortForCell = evs => [...evs].sort((a, b) => (KIND_ORDER[a.kind] ?? -1) - (KIND_ORDER[b.kind] ?? -1) || a.start - b.start);

async function loadCalendar() {
  const key = cacheKey(), start = gridStart(calMonth), end = new Date(start); end.setDate(start.getDate() + 42);
  if (calCache.has(key)) { ({ events: calEvents, google: calGoogle } = calCache.get(key)); render(); }
  else { $('calGrid').classList.add('loading'); renderTitle(); }
  try {
    const r = await api(`/api/calendar?scope=${calScope}&from=${start.toISOString()}&to=${end.toISOString()}`);
    const data = { events: r.events.map(e => ({ ...e, start: new Date(e.start), end: new Date(e.end) })), google: r.google || {} };
    calCache.set(key, data);
    if (key !== cacheKey()) return; // пока грузили, пользователь уже перелистнул
    ({ events: calEvents, google: calGoogle } = data);
  } catch (e) { if (key !== cacheKey()) return; calEvents = []; calGoogle = { error: e.message }; }
  $('calGrid').classList.remove('loading');
  render();
  prefetch(1); prefetch(-1);
}

// соседние месяцы грузим заранее, чтобы стрелки листали без ожидания
function prefetch(shift) {
  const m = new Date(calMonth); m.setMonth(m.getMonth() + shift);
  const key = calScope + ':' + ymd(m);
  if (calCache.has(key)) return;
  const start = gridStart(m), end = new Date(start); end.setDate(start.getDate() + 42);
  api(`/api/calendar?scope=${calScope}&from=${start.toISOString()}&to=${end.toISOString()}`)
    .then(r => calCache.set(key, { events: r.events.map(e => ({ ...e, start: new Date(e.start), end: new Date(e.end) })), google: r.google || {} }))
    .catch(() => {});
}

const renderTitle = () => { $('calTitle').textContent = MONTH_NAMES[calMonth.getMonth()] + ' ' + calMonth.getFullYear(); };

function render() {
  renderTitle();
  if (calScope === 'work') {
    $('calMeta').textContent = calGoogle.error ? 'Google Календарь: ошибка — ' + calGoogle.error
      : calGoogle.connected ? 'Google Календарь подключён' + (calGoogle.at ? ' · обновлён ' + fmt(calGoogle.at) : '') : 'Google Календарь не подключён';
    $('calMeta').classList.toggle('errors', !!calGoogle.error);
    $('googleBtn').textContent = calGoogle.connected ? 'Google Календарь ✓' : 'Подключить Google Календарь';
  } else {
    const inMonth = calEvents.filter(e => e.start.getMonth() === calMonth.getMonth());
    $('holFilters').innerHTML = Object.keys(KIND_ORDER).map(k => `<button type="button" class="${k}" data-kind="${k}" aria-pressed="${holKinds.has(k)}">${KIND_SHORT[k]}<small>${inMonth.filter(e => e.kind === k).length}</small></button>`).join('');
  }
  const today = ymd(new Date()), start = gridStart(calMonth);
  let html = WEEKDAYS.map(d => `<div class="wd" aria-hidden="true">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d), evs = sortForCell(eventsOn(d)), off = evs.some(e => e.kind === 'official');
    html += `<div class="day${d.getMonth() !== calMonth.getMonth() ? ' other' : ''}${key === today ? ' today' : ''}${off ? ' off' : ''}" data-date="${key}" role="button" tabindex="0"
      aria-label="${d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}, ${calScope === 'work' ? 'событий' : 'праздников'}: ${evs.length}">
      <span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map(e => `<span class="chip ${e.source} ${e.kind || ''}" title="${esc(e.title)}">${e.allDay ? '' : hm(e.start) + ' '}${esc(e.title)}</span>`).join('')}
      ${evs.length > 3 ? `<span class="more">ещё ${evs.length - 3}</span>` : ''}</div>`;
  }
  $('calGrid').innerHTML = html;
}

function openDay(key) {
  const date = fromYmd(key), evs = sortForCell(eventsOn(date));
  $('dayTitle').textContent = date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('dayList').innerHTML = evs.length ? evs.map(e => `<li class="${e.source} ${e.kind || ''}">
      ${e.source === 'holiday' ? '🎉' : `<b>${e.allDay ? 'Весь день' : hm(e.start) + (e.end > e.start ? '–' + hm(e.end) : '')}</b>`} ${esc(e.title)}
      ${e.source === 'google' ? '<small class="tag">Google</small>'
        : e.source === 'holiday' ? `<small class="tag">${KIND_LABEL[e.kind]}</small><button type="button" class="link" data-del="${esc(e.id)}">Скрыть</button>`
        : `<button type="button" class="link" data-del="${e.id}">Удалить</button>`}
      ${e.place ? `<div class="sub">📍 ${esc(e.place)}</div>` : ''}
      ${e.note ? `<div class="sub">${esc(e.note).replace(/\n/g, '<br>')}</div>` : ''}</li>`).join('')
    : `<li class="none">${calScope === 'work' ? 'Событий нет' : 'Праздников нет'}</li>`;
  const f = $('evForm'); f.reset(); f.date.value = key;
  if (!dayDlg.open) dayDlg.showModal();
}

const shiftMonth = n => { calMonth.setMonth(calMonth.getMonth() + n); loadCalendar(); };
$('calNav').onclick = e => { const b = e.target.closest('button'); if (b) showCalendar(b.dataset.scope); };
$('calPrev').onclick = () => shiftMonth(-1);
$('calNext').onclick = () => shiftMonth(1);
$('calToday').onclick = () => { calMonth = new Date(); calMonth.setDate(1); calMonth.setHours(0, 0, 0, 0); loadCalendar(); };
$('calAdd').onclick = () => openDay(ymd(new Date()));
$('calGrid').onclick = e => { const d = e.target.closest('.day'); if (d) openDay(d.dataset.date); };
$('calGrid').onkeydown = e => { const d = e.target.closest('.day'); if (d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDay(d.dataset.date); } };
// стрелки ← → листают месяцы, когда фокус не в поле ввода и не открыто окно
document.addEventListener('keydown', e => {
  if (!calendarOn || dayDlg.open || googleDlg.open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowLeft') shiftMonth(-1); else if (e.key === 'ArrowRight') shiftMonth(1);
});
$('holFilters').onclick = e => {
  const k = e.target.closest('button')?.dataset.kind; if (!k) return;
  holKinds.has(k) ? holKinds.delete(k) : holKinds.add(k);
  localStorage.holKinds = JSON.stringify([...holKinds]);
  render();
};

// после изменения данных старые месяцы в кэше устарели
const refreshCalendar = async () => { calCache.clear(); await loadCalendar(); };

$('evForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button.primary');
  btn.disabled = true;
  try {
    await api('/api/calendar/events', { method: 'POST', body: JSON.stringify({ title: f.summary.value, date: f.date.value, start: f.start.value, end: f.end.value, note: f.note.value }) });
    const key = f.date.value;
    calMonth = fromYmd(key); calMonth.setDate(1);
    await refreshCalendar(); openDay(key);
  } catch (err) { alert('Событие не добавлено: ' + err.message); }
  finally { btn.disabled = false; }
});

$('dayList').onclick = async e => {
  const id = e.target.dataset.del; if (!id) return;
  const ev = calEvents.find(x => x.id === id);
  if (!confirm(ev?.source === 'holiday' ? `Скрыть праздник «${ev.title}» из календаря?` : `Удалить событие «${ev?.title}»?`)) return;
  await api('/api/calendar/events?id=' + encodeURIComponent(id), { method: 'DELETE' });
  await refreshCalendar(); openDay($('evForm').date.value);
};

$('googleBtn').onclick = () => { $('gForm').url.value = ''; $('gStatus').textContent = ''; $('gOff').hidden = !calGoogle.connected; googleDlg.showModal(); };
async function setGoogle(url) {
  const s = $('gStatus'); s.className = ''; s.textContent = url ? 'Проверяю календарь…' : '';
  try {
    const r = await api('/api/calendar/google', { method: 'PUT', body: JSON.stringify({ url }) });
    googleDlg.close(); await refreshCalendar();
    if (r.connected) alert(`Google Календарь подключён: событий в календаре — ${r.count}.`);
  } catch (err) { s.className = 'errors'; s.textContent = err.message; }
}
$('gForm').addEventListener('submit', e => { if (e.submitter?.value !== 'save') return; e.preventDefault(); setGoogle(e.target.url.value.trim()); });
$('gOff').onclick = () => confirm('Отключить Google Календарь? Свои события останутся.') && setGoogle('');

if (calendarOn) showCalendar(calScope);
// события Google могли поменяться — обновляем раз в 5 минут, пока календарь открыт
setInterval(() => { if (calendarOn && !dayDlg.open && !googleDlg.open) refreshCalendar(); }, 5 * 60000);
