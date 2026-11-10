// node test.js — самопроверка парсеров
const assert = require('node:assert');
const { parseFeed, parseTelegram, parseLinks, matches, validWorkspaces } = require('./server.js');

const rss = parseFeed(`<rss><channel><title>Лента</title><item><title><![CDATA[Путин провёл &laquo;совещание&raquo;]]></title>
<link>https://ex.ru/1</link><description>&lt;p&gt;Первый абзац.&lt;/p&gt;&lt;p&gt;Второй.&lt;/p&gt;</description>
<pubDate>Fri, 06 Nov 2026 10:00:00 +0300</pubDate></item></channel></rss>`);
assert.deepStrictEqual(rss, [{ title: 'Путин провёл «совещание»', text: 'Первый абзац.\nВторой.', link: 'https://ex.ru/1', date: '2026-11-06T07:00:00.000Z' }]);

const atom = parseFeed(`<feed><entry><title>Заголовок</title><link href="https://ex.ru/a"/><summary>Текст</summary><updated>2026-11-06T10:00:00Z</updated></entry></feed>`);
assert.strictEqual(atom[0].link, 'https://ex.ru/a');

const tg = parseTelegram(`<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="tass_agency/123">
<div class="tgme_widget_message_text js-message_text" dir="auto"><b>Срочно</b>: заголовок<br/><br/>Подробности тут.</div>
<span class="tgme_widget_message_views">9.79K</span><time datetime="2026-11-06T10:00:00+00:00" class="time">10:00</time></div></div>`);
assert.deepStrictEqual(tg, [{ title: 'Срочно: заголовок', text: 'Подробности тут.', link: 'https://t.me/tass_agency/123', date: '2026-11-06T10:00:00.000Z', views: 9790 }]);

const links = parseLinks(`<a href="/news/1">Правительство утвердило новую программу развития регионов</a><a href="/x">Коротко</a>
<a href="https://other.ru/z">Чужой домен с очень длинным заголовком новости для теста</a>`, 'https://gov.ru/');
assert.deepStrictEqual(links.map(l => l.link), ['https://gov.ru/news/1']);

assert.ok(matches({ title: 'Выборы в регионах', text: '' }, ['выбор']));
assert.ok(!matches({ title: 'Погода', text: '' }, ['выбор']));
assert.ok(matches({ title: 'Погода', text: '' }, []));
assert.ok(matches({ title: 'Погода', text: 'Анонс', full: 'Абзац 1\nВ третьем абзаце про выборы' }, ['выбор']));
assert.throws(() => validWorkspaces([{ name: 'x', sources: ['file:///etc/passwd'] }]));
assert.deepStrictEqual(validWorkspaces([{ id: 'a', name: 'A', sources: ['@ch'], reportTimes: ['09:00', '25:00'] }])[0].reportTimes, ['09:00']);
const { parseViews, popular } = require('./server.js');
assert.deepStrictEqual(['9.79K', '32,4K', '1,2M', '845', '', undefined].map(parseViews), [9790, 32400, 1200000, 845, undefined, undefined]);
const d = '2026-11-10T05:00:00.000Z';
const pop = popular([
  { title: 'Анапа получила статус курорта федерального значения', text: '', source: 'interfax.ru', date: d },
  { title: 'Анапу наделили статусом курорта федерального значения', text: '', source: 'tass.ru', date: d },
  { title: 'Синоптик рассказал о погоде в выходные', text: '', source: 'ria.ru', date: d },
  ...[['Открыт новый мост через Волгу', 100], ['Курс рубля укрепился к доллару', 200], ['Сборная выиграла финал турнира', 300],
    ['Минздрав одобрил вакцину от гриппа', 400], ['Землетрясение произошло на Камчатке', 5000]].map(([title, views]) => ({ title, text: '', source: '@ch', date: d, views })),
]);
assert.deepStrictEqual(pop.map(g => [g.sources, g.items.length]), [[2, 2], [1, 1]]); // сюжет у двух агентств + самый просматриваемый пост
assert.strictEqual(pop[1].views, 5000);

// календарь: iCal из Google с повторами, исключениями и перенесённым повтором
const { parseIcs, occurrences, validEvent } = require('./server.js');
const ics = parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Планёрка', 'DTSTART;TZID=Europe/Moscow:20261102T100000', 'DTEND;TZID=Europe/Moscow:20261102T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', 'EXDATE;TZID=Europe/Moscow:20261104T100000', 'DESCRIPTION:Обсуждаем\\, что в номер\\nи план', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID;TZID=Europe/Moscow:20261109T100000', 'SUMMARY:Планёрка (перенос)', 'DTSTART;TZID=Europe/Moscow:20261109T120000', 'DTEND;TZID=Europe/Moscow:20261109T123000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:День рождения', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'RRULE:FREQ=YEARLY', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Отменено', 'STATUS:CANCELLED', 'DTSTART:20261105T090000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
assert.deepStrictEqual(ics.map(e => e.title), ['Планёрка', 'Планёрка (перенос)', 'День рождения']);
assert.strictEqual(ics[0].note, 'Обсуждаем, что в номер\nи план');
const nov = [new Date(2026, 10, 1), new Date(2026, 11, 1)], day = d => d.getDate() + ' ' + d.getHours();
assert.deepStrictEqual(occurrences(ics[0], ...nov).map(day), ['2 10', '11 10', '16 10', '18 10']); // 4-е исключено, 9-е перенесено, всего 6 по COUNT
assert.deepStrictEqual(occurrences(ics[1], ...nov).map(day), ['9 12']);
assert.deepStrictEqual(occurrences(ics[2], new Date(2027, 10, 1), new Date(2027, 11, 1)).map(day), ['10 0']); // каждый год
assert.throws(() => validEvent({ title: 'x', date: '2026-11-10', start: '12:00', end: '11:00' }));
assert.strictEqual(validEvent({ title: ' Сдать номер ', date: '2026-11-10', start: '', end: '' }).title, 'Сдать номер');

// праздники РБК: что берём и что отсеиваем
const { classify } = require('./holidays.js');
const kinds = {
  'День России': 'official', 'День народного единства': 'official', 'Рождество Христово у восточных христиан': 'official',
  'День российской печати': 'russia', 'День Государственного флага Российской Федерации': 'russia', 'День Бородинского сражения': 'russia',
  'День геолога': 'prof', 'День военного топографа в России': 'russia', 'День работника культуры': 'prof', 'День пограничника': 'prof',
  'Всемирный день свободы печати': 'intl', 'Международный день свекрови': 'intl', 'День английского языка в ООН': 'intl',
  'День памяти прaведного Иова Многострадального': null, 'Крещение Господне': null, 'Начало Успенского поста': null, 'Курбан-байрам': null,
  'День независимости Израиля': null, 'Рождество Христово у западных христиан': null, 'День попкорна': 'fun', 'День человека-паука': 'fun',
};
for (const [t, k] of Object.entries(kinds)) assert.strictEqual(classify(t), k, t);

const { splitPost } = require('./max.js');
const long = 'Российская делегация вылетела в Абу-Даби, где пройдут трехсторонние переговоры. Источник уточнил, что встреча начнётся утром, а состав делегации пока не раскрывается официально.';
assert.deepStrictEqual(splitPost(long), { title: 'Российская делегация вылетела в Абу-Даби, где пройдут трехсторонние переговоры.', text: 'Источник уточнил, что встреча начнётся утром, а состав делегации пока не раскрывается официально.' });
assert.deepStrictEqual(splitPost('Заголовок\nТекст'), { title: 'Заголовок', text: 'Текст' });

const { maxUrl, maxDate } = require('./max.js');
assert.strictEqual(maxUrl('max.ru/ria'), 'https://web.max.ru/ria');
assert.strictEqual(maxUrl('https://web.max.ru/-68062236996957'), 'https://web.max.ru/-68062236996957');
assert.strictEqual(maxUrl('https://max.ru/ria/extra'), null);
const now = new Date(2026, 10, 9, 20, 0);
assert.strictEqual(maxDate('Сегодня', '16:06', now), new Date(2026, 10, 9, 16, 6).toISOString());
assert.strictEqual(maxDate('Вчера', '23:59', now), new Date(2026, 10, 8, 23, 59).toISOString());
assert.strictEqual(maxDate('7 ноября', '09:05', now), new Date(2026, 10, 7, 9, 5).toISOString());
assert.strictEqual(maxDate('28 декабря', '10:00', new Date(2027, 0, 3)), new Date(2026, 11, 28, 10, 0).toISOString());
assert.strictEqual(maxDate('12 августа 2025', '12:44', now), new Date(2025, 7, 12, 12, 44).toISOString());

// checkSource без сети: несуществующий домен .invalid даёт понятную ошибку, а не падение
require('./server.js').checkSource('nothing.invalid').then(r => {
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'error');
  console.log('ok');
});
