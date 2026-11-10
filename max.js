// Чтение каналов MAX через браузер с отдельным профилем. Вход по QR: кнопка «Войти в MAX» в дашборде (или node max.js login на Windows)
// shortcut: читаем страницу web.max.ru по её разметке (data-message-markup, capsuleSeparator, meta) — если MAX переделает интерфейс, парсер придётся поправить
const path = require('node:path');

const PROFILE = process.env.MAX_PROFILE || path.join(__dirname, 'max-profile');
// на Windows — установленный Edge, на сервере (Linux) — Chromium из playwright (npx playwright-core install chromium)
const CHANNEL = process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
const launch = headless => require('playwright-core').chromium.launchPersistentContext(PROFILE, {
  channel: CHANNEL || undefined, headless, viewport: { width: 1280, height: 900 }, locale: 'ru-RU',
});

// ссылки max.ru/ria, web.max.ru/ria, web.max.ru/-680… → https://web.max.ru/…
const maxUrl = s => { const m = String(s).trim().match(/^(?:https?:\/\/)?(?:web\.)?max\.ru\/([\w-]+)\/?$/i); return m && `https://web.max.ru/${m[1]}`; };

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// «Сегодня» / «Вчера» / «9 ноября» / «9 ноября 2025» + «16:06» → ISO (местное время)
function maxDate(date, time, now = new Date()) {
  const d = new Date(now); d.setSeconds(0, 0);
  const m = String(date || 'Сегодня').trim().toLowerCase().match(/^(\d{1,2}) ([а-я]+)(?: (\d{4}))?/);
  if (/^вчера/.test(date?.toLowerCase())) d.setDate(d.getDate() - 1);
  else if (m && MONTHS.includes(m[2])) {
    d.setFullYear(m[3] ? +m[3] : d.getFullYear(), MONTHS.indexOf(m[2]), +m[1]);
    if (!m[3] && d > now) d.setFullYear(d.getFullYear() - 1); // «28 декабря», увиденное в январе
  }
  const [h, mi] = (time || '').split(':');
  if (h) d.setHours(+h, +mi);
  return d.toISOString();
}

// пост мессенджера → заголовок и текст: первая строка, а если она длинная — первое предложение
function splitPost(text) {
  const [first = '', ...rest] = text.split('\n').map(s => s.trim()).filter(Boolean);
  const end = first.length > 160 ? first.slice(40, 220).search(/[.!?…](\s|$)/) : -1;
  if (end < 0) return { title: first.slice(0, 250), text: rest.join('\n') };
  return { title: first.slice(0, 40 + end + 1), text: [first.slice(40 + end + 1).trim(), ...rest].filter(Boolean).join('\n') };
}

const hash = s => { let h = 5381; for (const c of s) h = (h * 33 + c.codePointAt(0)) >>> 0; return h.toString(36); };

// выполняется в странице: сообщения открытого канала по порядку, с датой из разделителей
function extract() {
  const main = document.querySelector('main');
  const name = (main.querySelector('h2')?.textContent || '').replace(/^Окно чата с /, '').trim();
  const rows = []; let date = null;
  const items = [...main.querySelectorAll('[data-index]')].sort((a, b) => a.dataset.index - b.dataset.index);
  for (const it of items) {
    const sep = it.querySelector('[class*="capsuleSeparator"]');
    if (sep) date = sep.textContent.trim();
    for (const m of it.querySelectorAll('[role="listitem"]')) {
      const text = m.querySelector('[data-message-markup]')?.innerText.trim();
      const time = (m.querySelector('[class*="meta"]')?.textContent.match(/\d{1,2}:\d{2}/g) || []).pop();
      const views = m.querySelector('[class*="views"]')?.textContent.trim();
      if (text) rows.push({ text, time, date, views });
    }
  }
  // сообщения выше первого разделителя: дата неизвестна, берём ближайшую (лучше, чем «сегодня»)
  const firstDate = rows.find(r => r.date)?.date;
  for (const r of rows) r.date ??= firstDate;
  return { name, rows };
}

let ctxP = null, queue = Promise.resolve();
const getCtx = () => ctxP ??= launch(true).then(c => { c.on('close', () => { ctxP = null; }); return c; }, e => {
  ctxP = null;
  throw new Error(/ProcessSingleton|already in use|lock/i.test(e.message) ? 'профиль MAX занят: закройте окно входа' : e.message.split('\n')[0]);
});

async function readChannel(url) {
  const ctx = await getCtx();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const qr = page.getByText('Войдите в MAX по QR-коду');
  await page.locator('[data-message-markup]').first().or(qr).waitFor({ timeout: 25000 })
    .catch(() => { throw new Error('канал не открылся: нет такого канала или он закрыт'); });
  if (await qr.isVisible()) throw new Error('нет входа в MAX — нажмите «Войти в MAX» и отсканируйте QR-код');
  await page.waitForTimeout(1500); // даём ленте дорисоваться
  const { name, rows } = await page.evaluate(extract);
  const chat = page.url().split('#')[0];
  return rows.map(r => {
    return { ...splitPost(r.text), link: `${chat}#${hash(r.text)}`, date: maxDate(r.date, r.time), views: r.views, source: 'MAX · ' + name };
  });
}

// одна вкладка на все каналы, по очереди: так меньше похоже на робота и не путаются страницы
function fetchMax(url) {
  const run = queue.then(() => readChannel(url));
  queue = run.catch(() => {});
  return run;
}

// Вход по QR из дашборда: отдельная вкладка в том же профиле держит страницу входа,
// дашборд раз в несколько секунд забирает снимок QR-кода, пока вход не состоится.
let loginPage = null;
async function loginState() {
  const ctx = await getCtx();
  if (!loginPage || loginPage.isClosed()) {
    loginPage = await ctx.newPage();
    await loginPage.goto('https://web.max.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await loginPage.waitForTimeout(3000); // QR сначала показывается размытым, пока генерируется
  }
  const qr = loginPage.getByText('Войдите в MAX по QR-коду'), chats = loginPage.getByRole('complementary', { name: 'Чаты' });
  await qr.or(chats).first().waitFor({ timeout: 25000 });
  if (await chats.isVisible().catch(() => false)) { await loginPage.close(); loginPage = null; return { loggedIn: true }; }
  // QR-код нарисован прямо над надписью «Войдите в MAX по QR-коду» — снимаем только этот участок (~30 КБ вместо всей страницы)
  const b = await qr.boundingBox();
  const clip = b && { x: Math.max(0, b.x + b.width / 2 - 150), y: Math.max(0, b.y - 290), width: 300, height: 285 };
  const shot = await loginPage.screenshot({ type: 'png', ...(clip ? { clip } : {}) });
  return { loggedIn: false, qr: 'data:image/png;base64,' + shot.toString('base64') };
}
const cancelLogin = async () => { if (loginPage && !loginPage.isClosed()) await loginPage.close(); loginPage = null; };

if (require.main === module && process.argv[2] === 'login') {
  (async () => {
    const ctx = await launch(false);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://web.max.ru/');
    console.log('Войдите в MAX по QR-коду в открывшемся окне, затем закройте окно.');
    await new Promise(r => ctx.on('close', r));
  })();
}

module.exports = { fetchMax, loginState, cancelLogin, maxUrl, maxDate, extract, splitPost };
