// ═══════════════════════════ KEYFALL — админка ═══════════════════════════
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const A = { ov: null, games: [], orders: [], gf: 'all', of: 'all', gq: '', oq: '', fiat: 'USD' };

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'X-KF': '1', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) {
    showLogin();
    throw new Error('Сессия истекла, войдите снова');
  }
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function money(v) {
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: A.fiat, minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v || 0);
  } catch { return `${v} ${A.fiat}`; }
}
const dt = (t) => (t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const parseKeys = (text) => [...new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано'); } catch { toast('Не удалось скопировать', 'error'); }
}

const dlg = {
  el: $('#dlg'), body: $('#dlgBody'),
  open(html) { this.body.innerHTML = html; this.el.hidden = false; $('.dlg-panel', this.el).scrollTop = 0; return this.body; },
  close() { this.el.hidden = true; this.body.innerHTML = ''; },
};

// ───────── вход ─────────
function showLogin(notConfigured = false) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  if (notConfigured) $('#loginErr').textContent = 'Пароль не задан: впишите ADMIN_PASSWORD в .env и перезапустите сервер';
  setTimeout(() => $('#password').focus(), 50);
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    $('#loginErr').textContent = '';
    showApp();
  } catch (err) {
    $('#loginErr').textContent = err.message;
    const card = $('.login-card');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  go(location.hash.slice(1) || 'overview');
}

// ───────── вкладки ─────────
async function go(tab) {
  if (!$(`[data-view="${tab}"]`)) tab = 'overview';
  history.replaceState(null, '', `#${tab}`);
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
  try {
    if (tab === 'overview') await loadOverview();
    if (tab === 'games') { if (!A.ov) await loadOverview(false); await loadGames(); }
    if (tab === 'orders') { if (!A.ov) await loadOverview(false); await loadOrders(); }
    if (tab === 'settings') { await loadOverview(false); renderSettings(); }
  } catch (e) {
    toast(e.message, 'error');
  }
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) go(g.dataset.goto);
  if (e.target.closest('[data-close]')) dlg.close();
  const c = e.target.closest('[data-copy]');
  if (c) copy(c.dataset.copy);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dlg.el.hidden) dlg.close(); });

// ───────── обзор ─────────
async function loadOverview(render = true) {
  const o = (A.ov = await api('/api/admin/overview'));
  A.fiat = o.cfg.fiat;
  $$('[data-shop]').forEach((el) => { el.textContent = o.cfg.shopName; });
  const wb = $('#waitingBadge');
  wb.textContent = o.waiting;
  wb.hidden = !o.waiting;
  if (!render) return;

  $('#appName').textContent = o.app ? `CryptoBot · ${o.app.name} · ${o.cfg.network}` : 'CryptoBot · нет связи, проверьте токен';
  const tiles = [
    { cls: 'hero', label: 'Выручка', value: money(o.revenue), sub: `${o.sold} ${o.sold === 1 ? 'продажа' : 'продаж'} за всё время` },
    { label: 'Продано ключей', value: o.sold },
    { label: 'Роздано бесплатно', value: o.giveaways },
    { label: 'Ключей в наличии', value: o.keys.available, sub: o.keys.reserved ? `+${o.keys.reserved} в брони` : 'свободных' },
    { label: 'Ждут оплаты', value: o.pending, sub: 'открытые счета' },
  ];
  if (o.waiting) tiles.push({ cls: 'alert', label: 'Оплачены без ключа', value: o.waiting, sub: 'Добавьте ключи: они выдадутся сами' });
  $('#tiles').innerHTML = tiles.map((t) => `<div class="tile ${t.cls || ''}"><span>${t.label}</span><b>${t.value}</b>${t.sub ? `<small>${t.sub}</small>` : ''}</div>`).join('');

  renderChart(o.series);
  $('#balance').innerHTML = o.balance === null
    ? '<div class="empty">Нет связи с CryptoBot</div>'
    : o.balance.length
      ? o.balance.map((b) => `<div class="bal"><b>${esc(b.currency_code)}</b><span>${esc(b.available)}${+b.onhold ? `<small>+${esc(b.onhold)} в обработке</small>` : ''}</span></div>`).join('')
      : '<div class="empty">Пока пусто. Деньги от продаж появятся здесь.</div>';

  const { orders } = await api('/api/admin/orders');
  A.orders = orders;
  $('#recent').innerHTML = orders.length
    ? `<div class="table-wrap"><table class="table">${ordersTable(orders.slice(0, 8), true)}</table></div>`
    : '<div class="empty">Заказов пока нет</div>';
}

function renderChart(series) {
  const max = Math.max(0, ...series.map((s) => s.revenue));
  const total = series.reduce((s, x) => s + x.revenue, 0);
  const count = series.reduce((s, x) => s + x.count, 0);
  $('#chartTotal').textContent = `${money(total)} · ${count} шт.`;
  const peak = max > 0 ? series.findIndex((s) => s.revenue === max) : -1;
  const chart = $('#chart');
  chart.innerHTML = series.map((s, i) => {
    const h = max ? Math.max((s.revenue / max) * 100, 3) : 0;
    const d = new Date(s.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
    return `<div class="col" data-i="${i}">
      <div class="bar${s.revenue ? '' : ' zero'}" style="height:${s.revenue ? h : 1.5}%;--i:${i}"></div>
      ${i === peak ? `<span class="val" style="bottom:calc(${h}% + 6px)">${money(s.revenue)}</span>` : ''}
      ${i % 2 === 1 ? `<span class="lbl${i % 4 === 1 ? ' show' : ''}">${d}</span>` : ''}
    </div>`;
  }).join('');
  const tip = $('#tip');
  chart.onpointermove = (e) => {
    const col = e.target.closest('.col');
    if (!col) { tip.hidden = true; return; }
    const s = series[col.dataset.i];
    const r = $('.bar', col).getBoundingClientRect();
    tip.innerHTML = `<b>${money(s.revenue)}</b>${new Date(s.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} · ${s.count} шт.`;
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top}px`;
    tip.hidden = false;
  };
  chart.onpointerleave = () => { tip.hidden = true; };
}

// ───────── игры ─────────
async function loadGames() {
  A.games = (await api('/api/admin/games')).games;
  renderGames();
}

function renderGames() {
  const q = A.gq.trim().toLowerCase();
  const list = A.games.filter((g) => {
    if (q && !g.title.toLowerCase().includes(q)) return false;
    if (A.gf === 'sale' || A.gf === 'giveaway') return g.mode === A.gf;
    if (A.gf === 'empty') return g.keys.available === 0;
    return true;
  });
  const box = $('#gamesList');
  if (!A.games.length) {
    box.innerHTML = '<div class="panel empty">Игр пока нет. Нажмите «Добавить игру» и вставьте ссылку из Steam: название, обложка и описание подтянутся сами.</div>';
    return;
  }
  box.innerHTML = list.length ? list.map((g) => `
    <div class="grow-item${g.active ? '' : ' off'}">
      ${g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
      <div>
        <div class="gi-title">${esc(g.title)}</div>
        <div class="badges">
          <span class="badge ${g.mode === 'sale' ? 'sale' : 'give'}">${g.mode === 'sale' ? 'Продажа' : 'Раздача'}</span>
          ${g.featured ? '<span class="badge hot">Хит</span>' : ''}
          ${g.active ? '' : '<span class="badge">Скрыта</span>'}
          ${g.demo ? '<span class="badge demo">Демо</span>' : ''}
        </div>
        ${g.mode === 'sale' ? `<div class="gi-price">${money(g.price)}${g.oldPrice ? ` <s class="muted" style="font-size:12px">${money(g.oldPrice)}</s>` : ''}</div>` : ''}
      </div>
      <div class="gi-stock">
        <div class="${g.keys.available ? '' : 'zero'}"><b>${g.keys.available}</b><span>свободно</span></div>
        <div><b>${g.keys.reserved}</b><span>в брони</span></div>
        <div><b>${g.keys.sold + g.keys.claimed}</b><span>${g.mode === 'sale' ? 'продано' : 'роздано'}</span></div>
      </div>
      <div class="gi-actions">
        <button class="btn btn-acid btn-sm" type="button" data-keys="${esc(g.id)}">+ Ключи</button>
        <button class="btn btn-line btn-sm" type="button" data-edit="${esc(g.id)}">Изменить</button>
      </div>
    </div>`).join('') : '<div class="panel empty">Ничего не найдено</div>';
}

$('#gamesList').addEventListener('click', (e) => {
  const k = e.target.closest('[data-keys]');
  const ed = e.target.closest('[data-edit]');
  if (k) keysDialog(A.games.find((g) => g.id === k.dataset.keys));
  if (ed) gameDialog(A.games.find((g) => g.id === ed.dataset.edit));
});
$('#addGame').addEventListener('click', () => gameDialog());
$('#gameSearch').addEventListener('input', (e) => { A.gq = e.target.value; renderGames(); });
$('#gameFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  A.gf = b.dataset.f;
  $$('#gameFilter button').forEach((x) => x.classList.toggle('on', x === b));
  renderGames();
});

function gameDialog(g = null) {
  const isNew = !g;
  const v = g || { mode: 'sale', active: true, region: 'Весь мир', genres: [] };
  const body = dlg.open(`
    <h2>${isNew ? 'Новая игра' : 'Изменить игру'}</h2>
    <form class="form" id="gForm" autocomplete="off">
      <div class="import">
        <span>⚡ Заполнить из Steam: вставьте ссылку на игру или её AppID</span>
        <input type="text" name="steam" placeholder="https://store.steampowered.com/app/1091500/ или 1091500" value="${esc(v.appId || '')}">
        <button class="btn btn-line" type="button" data-steam>Подтянуть</button>
      </div>
      <div class="mode">
        <label><input type="radio" name="mode" value="sale" ${v.mode === 'sale' ? 'checked' : ''}><b>💰 Продажа</b><small>Оплата через @CryptoBot</small></label>
        <label><input type="radio" name="mode" value="giveaway" ${v.mode === 'giveaway' ? 'checked' : ''}><b>🎁 Раздача</b><small>Бесплатно, 1 ключ в руки</small></label>
      </div>
      <label class="field"><span>Название</span><input type="text" name="title" required maxlength="120" value="${esc(v.title || '')}"></label>
      <div class="row3" data-price>
        <label class="field"><span>Цена, ${esc(A.fiat)}</span><input type="number" name="price" step="0.01" min="0" value="${v.mode === 'sale' && v.price ? v.price : ''}"></label>
        <label class="field"><span>Старая цена <small>(для скидки)</small></span><input type="number" name="oldPrice" step="0.01" min="0" value="${v.oldPrice || ''}"></label>
        <label class="field"><span>Регион активации</span><input type="text" name="region" maxlength="40" value="${esc(v.region || 'Весь мир')}"></label>
      </div>
      <div class="preview">
        <div id="coverPrev"></div>
        <div class="form">
          <label class="field"><span>Обложка</span>
            <div class="copyline"><input type="text" name="cover" placeholder="https://… или загрузите файл" value="${esc(v.cover || '')}"><label class="btn btn-line upl">Файл<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload></label></div>
          </label>
          <label class="field"><span>Фон карточки <small>(необязательно)</small></span><input type="text" name="hero" value="${esc(v.hero || '')}"></label>
        </div>
      </div>
      <label class="field"><span>Жанры через запятую</span><input type="text" name="genres" value="${esc((v.genres || []).join(', '))}"></label>
      <label class="field"><span>Описание</span><textarea name="description" maxlength="2000">${esc(v.description || '')}</textarea></label>
      ${isNew ? `<label class="field"><span>Ключи, по одному в строке <b class="kcount" data-kc></b></span><textarea class="keys" name="keys" placeholder="AAAAA-BBBBB-CCCCC&#10;DDDDD-EEEEE-FFFFF"></textarea><small>Можно добавить и позже кнопкой «+ Ключи».</small></label>` : ''}
      <div class="checks">
        <label class="check"><input type="checkbox" name="featured" ${v.featured ? 'checked' : ''}> Хит: большая карточка вверху каталога</label>
        <label class="check"><input type="checkbox" name="active" ${v.active !== false ? 'checked' : ''}> Показывать на сайте</label>
      </div>
      <div class="dlg-foot">
        ${isNew ? '' : '<button type="button" class="btn btn-danger" data-del style="margin-right:auto">Удалить игру</button>'}
        <button type="button" class="btn btn-line" data-close>Отмена</button>
        <button class="btn btn-acid" type="submit">${isNew ? 'Добавить игру' : 'Сохранить'}</button>
      </div>
    </form>`);
  const f = $('#gForm', body);
  let appId = v.appId || '';

  const preview = () => {
    const url = f.cover.value.trim();
    $('#coverPrev', body).innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<div class="noimg">Нет обложки</div>';
  };
  const syncMode = () => {
    const sale = f.mode.value === 'sale';
    $('[data-price]', body).style.display = sale ? '' : 'none';
    f.price.required = sale;
  };
  preview();
  syncMode();
  f.cover.addEventListener('input', preview);
  $$('input[name=mode]', f).forEach((r) => r.addEventListener('change', syncMode));
  if (f.keys) f.keys.addEventListener('input', () => { const n = parseKeys(f.keys.value).length; $('[data-kc]', body).textContent = n ? `· ${n} шт.` : ''; });

  $('[data-steam]', body).addEventListener('click', async (e) => {
    const raw = f.steam.value.trim();
    const id = raw.match(/app\/(\d+)/)?.[1] || raw.match(/^\d+$/)?.[0];
    if (!id) return toast('Вставьте ссылку вида store.steampowered.com/app/123… или число AppID', 'error');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Загружаю…';
    try {
      const s = await api(`/api/admin/steam/${id}`);
      appId = s.appId;
      f.title.value = s.title;
      f.description.value = s.description;
      f.cover.value = s.cover;
      f.hero.value = s.hero || '';
      f.genres.value = s.genres.join(', ');
      if (s.steamPrice && !f.oldPrice.value) f.oldPrice.value = s.steamPrice;
      preview();
      toast(s.steamPrice ? `Готово! Цена в Steam: $${s.steamPrice}. Укажите свою цену.` : 'Готово! Данные из Steam подставлены.');
      if (f.mode.value === 'sale') f.price.focus();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Подтянуть';
    }
  });

  $('[data-upload]', body).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await fetch('/api/admin/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg', 'X-KF': '1' }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось загрузить');
      f.cover.value = data.url;
      preview();
      toast('Обложка загружена');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const del = $('[data-del]', body);
  del?.addEventListener('click', async () => {
    if (!del.dataset.sure) { del.dataset.sure = 1; del.textContent = 'Точно удалить? Нажмите ещё раз'; return; }
    try {
      await api(`/api/admin/games/${g.id}`, { method: 'DELETE' });
      toast('Игра удалена');
      dlg.close();
      loadGames();
    } catch (err) { toast(err.message, 'error'); }
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      appId,
      mode: f.mode.value,
      title: f.title.value,
      price: f.price.value,
      oldPrice: f.oldPrice.value,
      region: f.region.value,
      cover: f.cover.value,
      hero: f.hero.value,
      genres: f.genres.value,
      description: f.description.value,
      featured: f.featured.checked,
      active: f.active.checked,
      ...(isNew && { keys: f.keys.value }),
    };
    const btn = $('[type=submit]', f);
    btn.disabled = true;
    try {
      const r = await api(isNew ? '/api/admin/games' : `/api/admin/games/${g.id}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) });
      toast(isNew ? `Игра добавлена${r.added ? `, ключей: ${r.added}` : ''}${r.duplicates ? ` (дубликатов пропущено: ${r.duplicates})` : ''}` : 'Сохранено');
      dlg.close();
      loadGames();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function keysDialog(g) {
  if (!g) return;
  const KS = { available: 'свободен', reserved: 'в брони', sold: 'продан', claimed: 'роздан' };
  let keys = [], filter = 'all';
  const body = dlg.open(`
    <h2>Ключи · ${esc(g.title)}</h2>
    <form class="form" id="kForm">
      <label class="field"><span>Добавить ключи, по одному в строке <b class="kcount" data-kc></b></span>
        <textarea class="keys" name="text" placeholder="AAAAA-BBBBB-CCCCC&#10;DDDDD-EEEEE-FFFFF&#10;…"></textarea></label>
      <div class="dlg-foot" style="justify-content:space-between;align-items:center"><small class="muted">Пустые строки и дубликаты пропускаются</small><button class="btn btn-acid" type="submit">Добавить</button></div>
    </form>
    <div class="filters" style="margin:24px 0 0;justify-content:space-between">
      <div class="seg-ctl" id="kFilter"><button data-f="all" class="on">Все</button><button data-f="available">Свободные</button><button data-f="reserved">В брони</button><button data-f="done">Выданные</button></div>
      <button class="btn btn-line btn-sm" type="button" data-export>Скопировать свободные</button>
    </div>
    <div class="klist" id="klist"></div>`);
  const f = $('#kForm', body);
  f.text.addEventListener('input', () => { const n = parseKeys(f.text.value).length; $('[data-kc]', body).textContent = n ? `· ${n} шт.` : ''; });

  const render = () => {
    const list = keys.filter((k) => filter === 'all' || (filter === 'done' ? k.status === 'sold' || k.status === 'claimed' : k.status === filter));
    $('#klist', body).innerHTML = list.length ? list.map((k) => `
      <div class="krow">
        <code>${esc(k.code)}</code>
        <span class="st ${k.status === 'available' ? 'paid' : k.status === 'reserved' ? 'pending' : ''}">${KS[k.status]}</span>
        <button class="icon-btn" type="button" title="Скопировать" data-copy="${esc(k.code)}">⧉</button>
        <button class="icon-btn del" type="button" title="Удалить" data-kdel="${esc(k.id)}" ${k.status === 'available' ? '' : 'disabled'}>✕</button>
      </div>`).join('') : '<div class="empty">Ключей нет</div>';
  };
  const load = async () => { keys = (await api(`/api/admin/games/${g.id}/keys`)).keys; render(); };
  await load();

  $('#kFilter', body).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    $$('#kFilter button', body).forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  $('[data-export]', body).addEventListener('click', () => {
    const free = keys.filter((k) => k.status === 'available').map((k) => k.code);
    if (!free.length) return toast('Свободных ключей нет', 'error');
    copy(free.join('\n'));
  });
  $('#klist', body).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kdel]');
    if (!b) return;
    try {
      await api(`/api/admin/keys/${b.dataset.kdel}`, { method: 'DELETE' });
      keys = keys.filter((k) => k.id !== b.dataset.kdel);
      render();
      loadGames();
    } catch (err) { toast(err.message, 'error'); }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!parseKeys(f.text.value).length) return toast('Вставьте хотя бы один ключ', 'error');
    try {
      const r = await api(`/api/admin/games/${g.id}/keys`, { method: 'POST', body: JSON.stringify({ text: f.text.value }) });
      toast(`Добавлено ключей: ${r.added}${r.duplicates ? `, дубликатов пропущено: ${r.duplicates}` : ''}`);
      f.text.value = '';
      $('[data-kc]', body).textContent = '';
      await load();
      loadGames();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ───────── заказы ─────────
const OS = {
  paid: ['paid', 'Оплачен'], pending: ['pending', 'Ждёт оплаты'], paid_no_key: ['problem', 'Оплачен, нет ключа'],
  failed: ['problem', 'Ошибка счёта'], expired: ['', 'Истёк'], cancelled: ['', 'Отменён'],
};
function statusPill(o) {
  const [cls, text] = OS[o.status] || ['', o.status];
  return `<span class="st ${cls}">${o.type === 'giveaway' && o.status === 'paid' ? 'Выдан' : text}</span>`;
}
function ordersTable(list, compact = false) {
  const head = compact
    ? '<thead><tr><th>Дата</th><th>Игра</th><th class="num">Сумма</th><th>Статус</th></tr></thead>'
    : '<thead><tr><th>Дата</th><th>Заказ</th><th>Игра</th><th class="num">Сумма</th><th>Статус</th><th>Оплачено</th><th>Ключ</th><th></th></tr></thead>';
  const rows = list.map((o) => {
    const game = `<div class="mini">${o.cover ? `<img src="${esc(o.cover)}" alt="">` : ''}<span>${esc(o.title)}${o.demo ? ' <span class="badge demo">демо</span>' : ''}</span></div>`;
    const sum = o.type === 'giveaway' ? '<span class="muted">бесплатно</span>' : money(o.amount);
    if (compact) return `<tr><td>${dt(o.createdAt)}</td><td>${game}</td><td class="num">${sum}</td><td>${statusPill(o)}</td></tr>`;
    return `<tr>
      <td>${dt(o.createdAt)}</td>
      <td><code>${esc(o.id)}</code>${o.invoiceId ? `<br><small class="muted">счёт ${esc(o.invoiceId)}</small>` : ''}</td>
      <td>${game}</td>
      <td class="num">${sum}</td>
      <td>${statusPill(o)}${o.error ? `<br><small class="muted">${esc(o.error)}</small>` : ''}</td>
      <td class="num">${o.paidAmount ? `${esc(o.paidAmount)} ${esc(o.paidAsset)}` : '—'}</td>
      <td>${o.key ? `<button class="keycode masked" type="button" data-reveal="${esc(o.key)}">•••••-•••••</button>` : '—'}</td>
      <td>${o.status === 'pending' && o.invoiceId ? `<button class="btn btn-line btn-sm" type="button" data-check="${esc(o.id)}">Проверить</button>` : ''}</td>
    </tr>`;
  }).join('');
  return head + `<tbody>${rows}</tbody>`;
}

async function loadOrders() {
  A.orders = (await api('/api/admin/orders')).orders;
  renderOrders();
}
function renderOrders() {
  const q = A.oq.trim().toLowerCase();
  const list = A.orders.filter((o) => {
    if (q && !o.id.toLowerCase().includes(q) && !o.title.toLowerCase().includes(q)) return false;
    if (A.of === 'paid') return o.status === 'paid' && o.type === 'sale';
    if (A.of === 'pending') return o.status === 'pending';
    if (A.of === 'giveaway') return o.type === 'giveaway';
    if (A.of === 'problem') return o.status === 'paid_no_key' || o.status === 'failed';
    return true;
  });
  $('#ordersTable').innerHTML = list.length ? ordersTable(list) : '<tbody><tr><td class="empty">Заказов нет</td></tr></tbody>';
}
$('#orderSearch').addEventListener('input', (e) => { A.oq = e.target.value; renderOrders(); });
$('#orderFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  A.of = b.dataset.f;
  $$('#orderFilter button').forEach((x) => x.classList.toggle('on', x === b));
  renderOrders();
});
$('#reloadOrders').addEventListener('click', () => loadOrders().then(() => toast('Обновлено')).catch((e) => toast(e.message, 'error')));
$('#ordersTable').addEventListener('click', async (e) => {
  const r = e.target.closest('[data-reveal]');
  if (r) {
    if (r.classList.contains('masked')) { r.textContent = r.dataset.reveal; r.classList.remove('masked'); } else copy(r.dataset.reveal);
  }
  const c = e.target.closest('[data-check]');
  if (c) {
    c.disabled = true;
    try {
      const o = await api(`/api/admin/orders/${c.dataset.check}/check`, { method: 'POST' });
      toast(`Статус: ${(OS[o.status] || ['', o.status])[1]}`);
      loadOrders();
    } catch (err) { toast(err.message, 'error'); c.disabled = false; }
  }
});

// ───────── настройки ─────────
function renderSettings() {
  const o = A.ov, c = o.cfg;
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  $('#settings').innerHTML = `
    <div class="cards">
      ${kv('Приложение CryptoBot', o.app ? `${esc(o.app.name)} (#${esc(o.app.id)})` : '<span style="color:#ff8ab3">нет связи, проверьте токен</span>')}
      ${kv('Сеть', c.network === 'mainnet' ? 'mainnet (реальные деньги)' : 'testnet (тестовая)')}
      ${kv('Валюта цен', esc(c.fiat))}
      ${kv('Принимаемые монеты', esc(c.assets.join(', ')))}
      ${kv('Бронь ключа на время оплаты', `${c.ttlMin} мин`)}
      ${kv('Раздачи', `1 ключ в ${c.cooldownH} ч на посетителя`)}
      ${kv('Адрес сайта (PUBLIC_URL)', esc(c.publicUrl))}
    </div>
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-h"><h2>Вебхук CryptoBot</h2></div>
      ${c.isPublicHost
        ? `<div class="note ok">Добавьте этот адрес в настройках приложения, тогда оплаты будут засчитываться мгновенно:
            <div class="copyline"><input type="text" readonly value="${esc(c.webhookUrl)}"><button class="btn btn-line" type="button" data-copy="${esc(c.webhookUrl)}">Копировать</button></div>
            <ol class="steps-list"><li>@CryptoBot → Crypto Pay → Мои приложения → ваше приложение</li><li>Вебхуки → Включить вебхуки</li><li>Вставьте адрес выше и сохраните</li></ol></div>`
        : `<div class="note">Сайт сейчас работает на <b>${esc(c.publicUrl)}</b>. Вебхуки CryptoBot работают только с публичным https-адресом. Пока вебхука нет, сервер сам сверяет счета каждые 30 секунд и при открытой странице заказа, так что оплата всё равно засчитается. Когда сайт переедет на домен, впишите его в <code>PUBLIC_URL</code> в файле <code>.env</code>.</div>`}
    </div>
    <div class="panel">
      <div class="panel-h"><h2>Как поменять настройки</h2></div>
      <p class="muted" style="margin:0">Всё, что выше, и пароль от админки задаются в файле <code>.env</code> в папке сайта. После правки перезапустите сервер.</p>
    </div>
    ${o.hasDemo ? `
    <div class="panel" style="margin-top:14px">
      <div class="panel-h"><h2>Демо-данные</h2></div>
      <p class="muted" style="margin:0 0 14px">В магазине есть демо-игры с ненастоящими ключами. Их можно «купить» без оплаты, чтобы посмотреть, как выдаётся ключ. Удалите их перед запуском, настоящие игры и заказы не пострадают.</p>
      <button class="btn btn-danger" type="button" data-clear-demo>Удалить демо-игры и демо-заказы</button>
    </div>` : ''}`;
  const clr = $('[data-clear-demo]');
  clr?.addEventListener('click', async () => {
    if (!clr.dataset.sure) { clr.dataset.sure = 1; clr.textContent = 'Точно удалить? Нажмите ещё раз'; return; }
    try {
      const r = await api('/api/admin/demo/clear', { method: 'POST' });
      toast(`Удалено демо-игр: ${r.removed}`);
      await loadOverview(false);
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ───────── старт ─────────
(async () => {
  const me = await api('/api/admin/me').catch(() => ({}));
  if (me.admin) showApp(); else showLogin(me.configured === false);
})();
