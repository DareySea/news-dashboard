// ТВ: прямой эфир основных российских каналов через их официальные плееры.
// hls — открытый поток ВГТРК (адрес из player-api.smotrim.ru), играет прямо в дашборде;
// page — страница эфира канала внутри дашборда (сайт это разрешает);
// window — канал запрещает показ на чужих сайтах (плеер «Медиавитрины»/1tv пишет «использовать запрещено» даже внутри страницы канала), открываем его эфир отдельным окном.
// shortcut: адреса проверены в ноябре 2026; если канал сменит плеер или адрес эфира, поправить строку здесь
const TV_CHANNELS = [
  { id: '1tv', name: 'Первый канал', type: 'window', site: 'https://www.1tv.ru/live' },
  { id: 'russia1', name: 'Россия 1', type: 'hls', src: 'https://live.smotrim.ru/vgtrk/0/russia1-hd/index.m3u8', site: 'https://smotrim.ru/channel/1' },
  { id: 'russia24', name: 'Россия 24', type: 'hls', src: 'https://live.smotrim.ru/vgtrk/0/russia24-hd/index.m3u8', site: 'https://smotrim.ru/channel/3' },
  { id: 'kultura', name: 'Россия К', type: 'hls', src: 'https://live.smotrim.ru/vgtrk/0/kultura-hd/index.m3u8', site: 'https://smotrim.ru/channel/4' },
  { id: 'ntv', name: 'НТВ', type: 'page', src: 'https://www.ntv.ru/air/', site: 'https://www.ntv.ru/air/' },
  { id: '5tv', name: 'Пятый канал', type: 'window', site: 'https://www.5-tv.ru/live/' },
  { id: 'rentv', name: 'РЕН ТВ', type: 'window', site: 'https://ren.tv/live' },
  { id: 'tvc', name: 'ТВ Центр', type: 'window', site: 'https://www.tvc.ru/live' },
  { id: 'matchtv', name: 'Матч ТВ', type: 'window', site: 'https://matchtv.ru/video/channel/matchtv' },
  { id: 'iz', name: 'Известия', type: 'window', site: 'https://iz.ru/live' },
];
// одно окно на все «оконные» каналы: повторное нажатие переключает канал в нём же
const openTvWindow = c => window.open(c.site, 'dashboard-tv', `popup,width=${Math.min(1200, screen.availWidth - 80)},height=${Math.min(760, screen.availHeight - 80)}`)?.focus();
let tvOn = localStorage.view === 'tv';
let tvChannel = TV_CHANNELS.find(c => c.id === localStorage.tvChannel) || TV_CHANNELS[0];

function showTv(on) {
  if (on) showCalendar(false);
  tvOn = on;
  if (on) localStorage.view = 'tv'; else if (localStorage.view === 'tv') localStorage.view = 'ws';
  $('tvView').hidden = !on;
  if (on) { $('wsHeader').hidden = true; $('feed').hidden = true; }
  else if (!calendarOn) { $('wsHeader').hidden = false; $('feed').hidden = false; }
  $('tvBtn').setAttribute('aria-current', on);
  if (on) document.querySelectorAll('#wsList button, #calNav button').forEach(b => b.setAttribute('aria-current', false));
  on ? playChannel(tvChannel) : ($('tvPlayer').innerHTML = ''); // уходим из раздела — эфир останавливаем
}

function playChannel(c) {
  tvChannel = c; localStorage.tvChannel = c.id;
  $('tvTitle').textContent = c.name;
  $('tvSite').href = c.site;
  $('tvList').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.id === c.id));
  const box = $('tvPlayer');
  box.classList.toggle('page', c.type === 'page');
  if (c.type === 'window') {
    box.innerHTML = `<div class="tv-msg"><p><b>${esc(c.name)}</b> не разрешает показывать свой эфир на других сайтах.</p>
      <button type="button" class="primary" id="tvOpenWin">▶ Смотреть в отдельном окне</button></div>`;
    $('tvOpenWin').onclick = () => openTvWindow(c);
  } else if (c.type === 'hls') {
    if (!document.createElement('video').canPlayType('application/vnd.apple.mpegurl')) {
      box.innerHTML = `<div class="tv-msg">Этот браузер не умеет показывать прямой эфир ${esc(c.name)} сам. <a href="${esc(c.site)}" target="_blank" rel="noopener">Смотреть на сайте канала ↗</a></div>`;
      return;
    }
    box.innerHTML = `<video controls autoplay playsinline src="${esc(c.src)}" aria-label="Прямой эфир: ${esc(c.name)}"></video>`;
    box.querySelector('video').onerror = () => {
      box.innerHTML = `<div class="tv-msg">Эфир ${esc(c.name)} не загрузился. <a href="${esc(c.site)}" target="_blank" rel="noopener">Смотреть на сайте канала ↗</a></div>`;
    };
  } else {
    box.innerHTML = `<iframe src="${esc(c.src)}" title="Прямой эфир: ${esc(c.name)}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  }
}

$('tvList').innerHTML = TV_CHANNELS.map(c => `<button type="button" data-id="${c.id}" aria-pressed="false"${c.type === 'window' ? ' title="Откроется в отдельном окне"' : ''}>${esc(c.name)}${c.type === 'window' ? ' ↗' : ''}</button>`).join('');
$('tvList').onclick = e => { const b = e.target.closest('button'); if (b) playChannel(TV_CHANNELS.find(c => c.id === b.dataset.id)); };
$('tvBtn').onclick = () => showTv(true);
if (tvOn) showTv(true);
