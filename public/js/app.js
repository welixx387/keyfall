// ═══════════════════════════ KEYFALL — витрина ═══════════════════════════
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cssUrl = (u) => `url(${JSON.stringify(String(u || ''))})`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(pointer: fine)').matches;
document.documentElement.classList.add('js');

const S = {
  cfg: { fiat: 'USD', assets: ['USDT', 'TON', 'BTC'], cooldownH: 24, ttlMin: 15, shopName: 'KEYFALL' },
  games: [], stats: {}, genre: 'all', q: '', sort: 'featured',
};
const byId = (id) => S.games.find((g) => g.id === id);

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка сети, попробуйте ещё раз'), { status: res.status, data });
  return data;
}

function money(v) {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency', currency: S.cfg.fiat, minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2,
    }).format(v);
  } catch { return `${v} ${S.cfg.fiat}`; }
}
function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60e3);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, ['день', 'дня', 'дней'])} назад`;
}
const discount = (g) => (g.oldPrice > g.price ? Math.round((1 - g.price / g.oldPrice) * 100) : 0);
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ───────── «Мои ключи» в localStorage ─────────
const mine = {
  K: 'kf_orders',
  all() {
    try { return JSON.parse(localStorage.getItem(this.K)) || []; } catch { return []; }
  },
  put(patch) {
    const list = this.all();
    const i = list.findIndex((x) => x.id === patch.id);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null));
    if (i >= 0) list[i] = { ...list[i], ...clean };
    else list.unshift({ at: Date.now(), ...clean });
    try { localStorage.setItem(this.K, JSON.stringify(list.slice(0, 60))); } catch { /* приватный режим */ }
    updateCount();
  },
};
function updateCount() {
  const n = mine.all().filter((m) => m.key).length;
  const b = $('#myKeysCount');
  b.textContent = n;
  b.hidden = !n;
}

// ───────── модалка ─────────
const modal = {
  el: $('#modal'), body: $('#modalBody'), owner: null, timer: 0, lastFocus: null,
  open(html, owner = null) {
    if (this.owner && this.owner !== owner) this.owner.stop();
    this.owner = owner;
    clearTimeout(this.timer);
    if (this.el.hidden) this.lastFocus = document.activeElement;
    this.body.innerHTML = html;
    this.el.hidden = false;
    this.el.classList.remove('closing');
    $('.modal-panel', this.el).scrollTop = 0;
    syncLock();
    requestAnimationFrame(() => $('.modal-x', this.el).focus({ preventScroll: true }));
    return this.body;
  },
  close() {
    if (this.el.hidden) return;
    this.owner?.stop();
    this.owner = null;
    this.el.classList.add('closing');
    this.timer = setTimeout(() => {
      this.el.hidden = true;
      this.el.classList.remove('closing');
      this.body.innerHTML = '';
      syncLock();
      this.lastFocus?.focus?.({ preventScroll: true });
    }, 240);
  },
};
const drawer = {
  el: $('#drawer'),
  open() {
    this.el.hidden = false;
    this.el.classList.remove('closing');
    syncLock();
    renderMine();
    refreshMine();
  },
  close() {
    if (this.el.hidden) return;
    this.el.classList.add('closing');
    setTimeout(() => { this.el.hidden = true; this.el.classList.remove('closing'); syncLock(); }, 280);
  },
};
function syncLock() { document.body.classList.toggle('locked', !modal.el.hidden || !drawer.el.hidden); }

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 4000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ───────── эффекты ─────────
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const rnd5 = () => Array.from({ length: 5 }, () => CHARS[(Math.random() * CHARS.length) | 0]).join('');

function scramble(el, text, dur = 1000) {
  if (!dur) { el.textContent = text; return Promise.resolve(); }
  const t0 = performance.now();
  return new Promise((done) => {
    (function frame(t) {
      const p = Math.min(1, (t - t0) / dur);
      const n = Math.floor(p * text.length);
      let out = text.slice(0, n);
      for (let i = n; i < text.length; i++) out += /[\s-]/.test(text[i]) ? text[i] : CHARS[(Math.random() * CHARS.length) | 0];
      el.textContent = out;
      if (p < 1) requestAnimationFrame(frame); else done();
    })(t0);
  });
}

function countUp(el, to) {
  if (reduced) { el.textContent = to.toLocaleString('ru-RU'); return; }
  const t0 = performance.now();
  (function f(t) {
    const p = Math.min(1, (t - t0) / 1600);
    el.textContent = Math.round(to * (1 - (1 - p) ** 4)).toLocaleString('ru-RU');
    if (p < 1) requestAnimationFrame(f);
  })(t0);
}

function confetti() {
  if (reduced) return;
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = innerWidth, H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#d4ff3a', '#8b5cff', '#ff3d81', '#35e0ff', '#ffffff'];
  const P = Array.from({ length: 190 }, (_, i) => ({
    x: W / 2 + (Math.random() - 0.5) * 160, y: H * 0.42,
    vx: (Math.random() - 0.5) * 22, vy: -Math.random() * 17 - 5,
    s: Math.random() * 8 + 5, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.35,
    c: colors[i % colors.length],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, W, H);
    for (const p of P) {
      p.vy += 0.45; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (t - t0 < 3400) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// падающие ключи на фоне
function setupFx() {
  if (reduced) return;
  const c = $('#fx'), ctx = c.getContext('2d');
  let W, H;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    c.width = W * dpr; c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);
  const colors = ['212,255,58', '139,92,255', '53,224,255', '255,61,129'];
  const spawn = (initial) => {
    const z = Math.random();
    return { x: Math.random() * W, y: initial ? Math.random() * H : -40, z, s: 7 + z * 15, vy: 0.2 + z * 0.8, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.012, c: colors[(Math.random() * colors.length) | 0], a: 0.07 + z * 0.2 };
  };
  const keys = Array.from({ length: W < 700 ? 12 : 26 }, () => spawn(true));
  let mx = 0, my = 0, running = false;
  addEventListener('pointermove', (e) => { mx = e.clientX / W - 0.5; my = e.clientY / H - 0.5; }, { passive: true });
  function draw(k) {
    const s = k.s;
    ctx.save();
    ctx.translate(k.x - mx * k.z * 40, k.y - my * k.z * 30);
    ctx.rotate(k.r);
    ctx.strokeStyle = `rgba(${k.c},${k.a})`;
    ctx.lineWidth = Math.max(1.2, s / 6.5);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(-s * 0.6, 0, s * 0.42, 0, Math.PI * 2);
    ctx.moveTo(-s * 0.18, 0); ctx.lineTo(s * 1.15, 0);
    ctx.moveTo(s * 0.7, 0); ctx.lineTo(s * 0.7, s * 0.36);
    ctx.moveTo(s * 0.98, 0); ctx.lineTo(s * 0.98, s * 0.28);
    ctx.stroke();
    ctx.restore();
  }
  function frame() {
    if (document.hidden) { running = false; return; }
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      k.y += k.vy; k.r += k.vr;
      if (k.y > H + 50) keys[i] = spawn(false);
      draw(keys[i]);
    }
    requestAnimationFrame(frame);
  }
  const start = () => { if (!running && !document.hidden) { running = true; requestAnimationFrame(frame); } };
  document.addEventListener('visibilitychange', start);
  start();
}

function setupPointer() {
  if (!fine) return;
  let raf = 0, x = 0, y = 0;
  addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      document.documentElement.style.setProperty('--mx', `${x}px`);
      document.documentElement.style.setProperty('--my', `${y}px`);
    });
  }, { passive: true });
}

function setupNav() {
  const nav = $('#nav');
  let lastY = scrollY;
  addEventListener('scroll', () => {
    const y = scrollY;
    nav.classList.toggle('hide', y > lastY && y > 320);
    lastY = y;
  }, { passive: true });
}

function splitDrop() {
  let i = 0;
  $$('[data-drop]').forEach((el) => {
    const text = el.textContent;
    el.textContent = '';
    for (const ch of text) {
      if (ch === ' ') { el.append(' '); i++; continue; }
      const s = document.createElement('span');
      s.className = 'ch';
      s.style.setProperty('--i', i++);
      s.textContent = ch;
      el.append(s);
    }
  });
}

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px' })
  : null;
function reveal(root = document, instant = false) {
  $$('[data-reveal]:not(.in)', root).forEach((el) => (io && !instant ? io.observe(el) : el.classList.add('in')));
}

function setupMagnetic() {
  if (!fine || reduced) return;
  $$('.magnetic').forEach((b) => {
    b.addEventListener('pointermove', (e) => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.22}px, ${(e.clientY - r.top - r.height / 2) * 0.35}px)`;
    });
    b.addEventListener('pointerleave', () => { b.style.transform = ''; });
  });
}

function bindTilt(card) {
  if (!fine || reduced) return;
  const inner = $('.card-in', card);
  card.addEventListener('pointermove', (e) => {
    const r = inner.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    inner.classList.add('tilting');
    inner.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    inner.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
    inner.style.setProperty('--mx', `${x * 100}%`);
    inner.style.setProperty('--my', `${y * 100}%`);
  });
  card.addEventListener('pointerleave', () => {
    inner.classList.remove('tilting');
    inner.style.setProperty('--rx', '0deg');
    inner.style.setProperty('--ry', '0deg');
  });
}

// ───────── hero: колода падающих карт ─────────
function renderDeck() {
  const deck = $('#deck');
  const pick = [...S.games.filter((g) => g.featured), ...S.games.filter((g) => !g.featured)].filter((g) => g.cover).slice(0, 8);
  const fill = (el, g) => {
    $('.kc-art', el).style.backgroundImage = g ? cssUrl(g.hero || g.cover) : '';
    $('.kc-title', el).textContent = g ? g.title : S.cfg.shopName;
    const price = $('.kc-price', el);
    price.textContent = !g ? 'SOON' : g.mode === 'giveaway' ? 'FREE' : money(g.price);
    price.classList.toggle('free', !!g && g.mode === 'giveaway');
    $('.kc-code', el).textContent = `${rnd5()}-${rnd5()}-•••••`;
    if (g?.hero && g.hero !== g.cover) {
      const probe = new Image();
      probe.onerror = () => { $('.kc-art', el).style.backgroundImage = cssUrl(g.cover); };
      probe.src = g.hero;
    }
  };
  deck.innerHTML = '';
  const cards = [0, 1, 2].map((i) => {
    const el = document.createElement('div');
    el.className = 'kc';
    el.dataset.pos = i;
    el.innerHTML = `<div class="kc-art"></div><div class="kc-holo"></div>
      <div class="kc-in">
        <div class="kc-top"><span>STEAM KEY</span><span>GLOBAL</span></div>
        <div class="kc-chip"></div>
        <div class="kc-title"></div>
        <div class="kc-row"><span class="kc-code"></span><span class="kc-price"></span></div>
      </div>`;
    fill(el, pick.length ? pick[i % pick.length] : null);
    deck.append(el);
    return el;
  });
  if (pick.length < 2 || reduced) return;
  let next = 3;
  setInterval(() => {
    if (document.hidden) return;
    const top = cards.find((c) => c.dataset.pos === '0');
    top.classList.add('fall');
    for (const c of cards) if (c !== top) c.dataset.pos = String(+c.dataset.pos - 1);
    const newTop = cards.find((c) => c.dataset.pos === '0');
    const code = $('.kc-code', newTop);
    scramble(code, code.textContent, 900);
    setTimeout(() => {
      top.classList.add('snap');
      top.classList.remove('fall');
      top.dataset.pos = '2';
      fill(top, pick[next++ % pick.length]);
      void top.offsetWidth;
      top.classList.remove('snap');
    }, 980);
  }, 4200);
}

function setupHeroTilt() {
  if (!fine || reduced) return;
  const vis = $('#heroVisual'), deck = $('#deck');
  addEventListener('pointermove', (e) => {
    const r = vis.getBoundingClientRect();
    if (r.bottom < 0) return;
    const x = (e.clientX - (r.left + r.width / 2)) / innerWidth;
    const y = (e.clientY - (r.top + r.height / 2)) / innerHeight;
    deck.style.setProperty('--ry', `${-14 + x * 34}deg`);
    deck.style.setProperty('--rx', `${8 - y * 24}deg`);
    for (const c of deck.children) {
      c.style.setProperty('--hx', `${50 + x * 140}%`);
      c.style.setProperty('--hy', `${50 + y * 140}%`);
    }
  }, { passive: true });
}

// ───────── рендер витрины ─────────
function applyCfg() {
  const c = S.cfg;
  $$('[data-shop-name]').forEach((el) => { el.textContent = c.shopName; });
  document.title = `${c.shopName} — ключи Steam за крипту`;
  $('#assetsLine').textContent = c.assets.slice(0, 4).join(' · ');
  $$('[data-assets]').forEach((el) => { el.textContent = c.assets.join(', '); });
  $('#cooldownH').textContent = c.cooldownH;
  $$('[data-cooldown]').forEach((el) => { el.textContent = c.cooldownH; });
  if (c.supportUrl) {
    const a = $('#supportLink');
    a.href = c.supportUrl;
    a.hidden = false;
    $$('[data-support]').forEach((el) => { el.innerHTML = `<a href="${esc(c.supportUrl)}" target="_blank" rel="noopener">через Telegram</a>`; });
  }
}

function renderStats(animate = true) {
  $$('[data-stat]').forEach((el) => {
    const v = S.stats[el.dataset.stat] || 0;
    el.closest('div').hidden = !v && el.dataset.stat === 'delivered';
    if (animate) countUp(el, v); else el.textContent = v.toLocaleString('ru-RU');
  });
}

function renderTicker(items) {
  const slogans = ['Мгновенная выдача', 'Оплата через @CryptoBot', 'Бесплатные раздачи', 'Ключи Steam', S.cfg.assets.slice(0, 3).join(' · '), 'Цены ниже стора'];
  const a = items.length
    ? items.map((it) => `<span class="tk">${esc(it.title)} <small>${it.type === 'giveaway' ? 'забрали бесплатно' : 'купили'} ${ago(it.at)}</small><span class="star">✦</span></span>`)
    : slogans.map((s) => `<span class="tk">${esc(s)}<span class="star">✦</span></span>`);
  const b = slogans.map((s, i) => `<span class="tk${i % 2 ? ' tk-outline' : ''}">${esc(s)}<span class="star">✦</span></span>`);
  const fillTrack = (el, list) => {
    let half = [];
    while (half.length < 12) half = half.concat(list);
    el.innerHTML = half.join('') + half.join('');
  };
  fillTrack($('#tickerA'), a);
  fillTrack($('#tickerB'), b);
}

function renderDrops(instant = false) {
  const list = S.games.filter((g) => g.mode === 'giveaway');
  const box = $('#drops-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty"><b>Раздач пока нет</b>Новые раздачи появляются регулярно, загляните позже.</div>';
    return;
  }
  box.innerHTML = list.map((g, i) => `
    <article class="ticket" data-id="${esc(g.id)}" data-reveal style="--d:${(i % 3) * 90}ms">
      <div class="ticket-media" data-open><img src="${esc(g.cover)}" alt="" loading="lazy"><span class="free-stamp">FREE</span></div>
      <div class="ticket-body">
        <h3>${esc(g.title)}</h3>
        <div class="ticket-meta"><span>Осталось <b>${g.stock}</b> из ${g.total}</span><span>${g.given} ${plural(g.given, ['забрал', 'забрали', 'забрали'])}</span></div>
        <div class="bar"><i style="--p:${g.total ? (g.stock / g.total).toFixed(3) : 0}"></i></div>
        <button class="hold" type="button" ${g.stock > 0 ? '' : 'disabled'}><span>${g.stock > 0 ? '◉ Зажми и держи' : 'Ключи разобрали'}</span></button>
      </div>
    </article>`).join('');
  $$('.ticket', box).forEach((t) => {
    const g = byId(t.dataset.id);
    $('[data-open]', t).addEventListener('click', () => openGame(g));
    const hold = $('.hold', t);
    bindHold(hold, () => claim(g, hold));
  });
  reveal(box, instant);
}

function renderChips() {
  const genres = [...new Set(S.games.filter((g) => g.mode === 'sale').flatMap((g) => g.genres || []))].slice(0, 8);
  $('#chips').innerHTML = ['all', ...genres]
    .map((g) => `<button class="chip" type="button" role="tab" aria-selected="${S.genre === g}" data-g="${esc(g)}">${g === 'all' ? 'Все игры' : esc(g)}</button>`)
    .join('');
}

function cardHtml(g, i, wide) {
  const sold = g.stock <= 0;
  const d = discount(g);
  const on = Math.min(g.stock, 10);
  const segs = Array.from({ length: 10 }, (_, k) => `<i class="${k < on ? 'on' : ''}"></i>`).join('');
  const stockText = sold ? 'Нет в наличии' : g.stock <= 3 ? `<b>Осталось ${g.stock}!</b>` : `${g.stock} шт.`;
  return `
    <article class="card${wide ? ' wide' : ''}${sold ? ' sold' : ''}" data-id="${esc(g.id)}" data-reveal style="--d:${(i % 4) * 70}ms">
      <div class="card-in" tabindex="0" role="button" aria-label="${esc(g.title)}, ${esc(money(g.price))}">
        <div class="card-media">
          <img src="${esc(g.cover)}" alt="" loading="lazy">
          <div class="card-shine"></div>
          ${g.featured ? '<span class="hot">★ ХИТ</span>' : ''}
          ${d ? `<span class="disc">−${d}%</span>` : ''}
          ${sold ? '<div class="sold-stamp"><span>SOLD OUT</span></div>' : ''}
        </div>
        <div class="card-body">
          <span class="tag-price">${money(g.price)}${g.oldPrice ? `<s>${money(g.oldPrice)}</s>` : ''}</span>
          ${g.genres?.length ? `<div class="tags">${g.genres.slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          <h3>${esc(g.title)}</h3>
          <div class="card-foot">
            <div class="stock${!sold && g.stock <= 3 ? ' low' : ''}"><div class="seg">${segs}</div><span>${stockText}</span></div>
            <span class="go">${ARROW}</span>
          </div>
        </div>
      </div>
    </article>`;
}

function renderGrid(instant = false) {
  const grid = $('#grid');
  const q = S.q.trim().toLowerCase();
  let list = S.games.filter((g) => g.mode === 'sale');
  if (S.genre !== 'all') list = list.filter((g) => g.genres?.includes(S.genre));
  if (q) list = list.filter((g) => g.title.toLowerCase().includes(q));
  const sorters = {
    cheap: (a, b) => a.price - b.price,
    expensive: (a, b) => b.price - a.price,
    discount: (a, b) => discount(b) - discount(a),
    new: (a, b) => b.createdAt - a.createdAt,
  };
  if (sorters[S.sort]) list = list.slice().sort(sorters[S.sort]);
  list = list.slice().sort((a, b) => (b.stock > 0) - (a.stock > 0));
  const allowWide = S.sort === 'featured' && !q && S.genre === 'all';
  grid.innerHTML = list.length
    ? list.map((g, i) => cardHtml(g, i, allowWide && g.featured && g.stock > 0)).join('')
    : `<div class="empty"><b>${S.games.some((g) => g.mode === 'sale') ? 'Ничего не нашлось' : 'Каталог скоро пополнится'}</b>${S.games.some((g) => g.mode === 'sale') ? 'Попробуйте другой запрос или жанр.' : 'Мы уже загружаем новые ключи.'}</div>`;
  $$('.card', grid).forEach(bindTilt);
  reveal(grid, instant);
}

// ───────── зажми-и-держи ─────────
function bindHold(btn, onDone) {
  const DUR = 1300;
  let p = 0, holding = false, last = 0, raf = 0;
  const set = (v) => { p = v; btn.style.setProperty('--p', v.toFixed(3)); };
  const step = (t) => {
    const dt = t - last;
    last = t;
    set(holding ? Math.min(1, p + dt / DUR) : Math.max(0, p - dt / 380));
    if (holding && p >= 1) {
      holding = false;
      btn.classList.remove('holding');
      navigator.vibrate?.(30);
      onDone();
      return;
    }
    if (holding || p > 0) raf = requestAnimationFrame(step);
  };
  const down = (e) => {
    if (btn.disabled || btn.dataset.busy || holding) return;
    e.preventDefault();
    holding = true;
    btn.classList.add('holding');
    if (e.pointerId !== undefined) btn.setPointerCapture?.(e.pointerId);
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(step);
  };
  const up = () => {
    if (!holding) return;
    holding = false;
    btn.classList.remove('holding');
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    if (!btn.dataset.hinted && p < 0.2) { btn.dataset.hinted = 1; toast('Зажмите кнопку и подержите секунду 👆'); }
    e.preventDefault();
  });
}

async function claim(g, btn) {
  const label = $('span', btn);
  const text = label.textContent;
  btn.dataset.busy = 1;
  label.textContent = 'Открываем…';
  try {
    const o = await api(`/api/giveaway/${encodeURIComponent(g.id)}/claim`, { method: 'POST' });
    mine.put({ id: o.id, token: o.token, title: o.title, cover: o.cover, type: 'giveaway', status: o.status, key: o.key });
    showWin(o, { reel: true });
    refreshGames();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    delete btn.dataset.busy;
    label.textContent = text;
    btn.style.setProperty('--p', 0);
  }
}

// ───────── карточка игры ─────────
function openGame(g) {
  if (!g) return;
  const sale = g.mode === 'sale', sold = g.stock <= 0, d = discount(g);
  const body = modal.open(`
    <div class="pm">
      <div class="pm-hero"><div class="bg"></div><img class="pm-cover" src="${esc(g.cover)}" alt=""></div>
      <div class="pm-main">
        <div>
          ${g.genres?.length ? `<div class="tags">${g.genres.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          <h2 class="pm-title">${esc(g.title)}</h2>
          ${g.description ? `<p class="pm-desc">${esc(g.description)}</p>` : ''}
          <ul class="pm-meta">
            <li>Платформа<b>Steam</b></li>
            <li>Регион<b>${esc(g.region || 'Весь мир')}</b></li>
            <li>${sale ? 'В наличии' : 'Осталось'}<b>${g.stock} ${plural(g.stock, ['ключ', 'ключа', 'ключей'])}</b></li>
            <li>Выдача<b>${sale ? 'Сразу после оплаты' : 'Мгновенно'}</b></li>
          </ul>
          ${g.appId ? `<p style="margin:18px 0 0"><a class="btn-ghost" href="https://store.steampowered.com/app/${encodeURIComponent(g.appId)}/" target="_blank" rel="noopener">Страница игры в Steam ↗</a></p>` : ''}
        </div>
        <aside class="buybox">
          ${sale ? `
            <div class="price"><b>${money(g.price)}</b>${d ? `<s>${money(g.oldPrice)}</s><span class="disc">−${d}%</span>` : ''}</div>
            <button class="btn btn-acid" type="button" data-buy ${sold ? 'disabled' : ''}>${sold ? 'Нет в наличии' : `Купить за крипту ${ARROW}`}</button>
            <div class="coins">${S.cfg.assets.map((a) => `<span>${esc(a)}</span>`).join('')}</div>
            <small>Пока вы оплачиваете счёт в @CryptoBot, ключ закреплён за вами (${S.cfg.ttlMin} мин).</small>`
          : `
            <div class="price"><b>Бесплатно</b></div>
            <button class="hold" type="button" ${sold ? 'disabled' : ''}><span>${sold ? 'Ключи разобрали' : '◉ Зажми и держи'}</span></button>
            <small>Один ключ на человека из каждой раздачи. Новый бесплатный ключ можно забрать раз в ${S.cfg.cooldownH} ч.</small>`}
          ${g.demo ? '<div class="demo-note">Демо-товар: ключ ненастоящий, оплата имитируется.</div>' : ''}
        </aside>
      </div>
    </div>`);
  const bg = $('.pm-hero .bg', body);
  bg.style.backgroundImage = cssUrl(g.cover);
  if (g.hero && g.hero !== g.cover) {
    const im = new Image();
    im.onload = () => { bg.style.backgroundImage = cssUrl(g.hero); };
    im.src = g.hero;
  }
  $('[data-buy]', body)?.addEventListener('click', (e) => buy(g, e.currentTarget));
  const hold = $('.hold', body);
  if (hold) bindHold(hold, () => claim(g, hold));
}

async function buy(g, btn) {
  btn.classList.add('loading');
  try {
    const o = await api('/api/orders', { method: 'POST', body: JSON.stringify({ gameId: g.id }) });
    mine.put({ id: o.id, token: o.token, title: o.title, cover: o.cover, type: 'sale', status: o.status });
    showOrder(o.id, o.token, o);
    refreshGames();
  } catch (e) {
    toast(e.message, 'error');
    btn.classList.remove('loading');
  }
}

// ───────── заказ: ожидание оплаты → выдача ─────────
const STATUS = {
  pending: 'Ждёт оплаты', paid: 'Оплачен', expired: 'Время на оплату вышло', cancelled: 'Отменён',
  failed: 'Не удалось создать счёт', paid_no_key: 'Оплачен, ключ скоро будет', missing: 'Заказ не найден',
};

function showOrder(id, token, initial = null) {
  const flow = { stop() { flow.stopped = true; clearTimeout(flow.poller); clearInterval(flow.ticker); } };
  const link = `${location.origin}/?order=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
  let wasPending = false;

  const render = (o) => {
    mine.put({ id: o.id, token, title: o.title, cover: o.cover, type: o.type, status: o.status, key: o.key });
    if (o.status === 'pending') { wasPending = true; return renderPending(o); }
    flow.stop();
    if (o.status === 'paid') return showWin(o, { reel: wasPending });
    if (o.status === 'paid_no_key') return renderState('⏳', 'Оплата получена', 'Ключи этой игры закончились прямо в момент оплаты. Как только мы пополним склад, ключ выдастся автоматически и появится в «Моих ключах».', o);
    if (o.status === 'expired') return renderState('⌛', 'Время на оплату вышло', 'Счёт больше не действует, бронь ключа снята. Оформите заказ заново, если ещё хотите эту игру.', o, true);
    if (o.status === 'cancelled') return renderState('✕', 'Заказ отменён', 'Счёт аннулирован, ключ вернулся в продажу.', o, true);
    return renderState('⚠', 'Не получилось', 'Счёт не был создан. Попробуйте оформить заказ ещё раз.', o, true);
  };

  const renderState = (icon, title, text, o, retry = false) => {
    const body = modal.open(`
      <div class="state">
        <div class="big">${icon}</div>
        <h2>${esc(title)}</h2>
        <p>${esc(text)}</p>
        ${o?.title ? `<p><b>${esc(o.title)}</b> · заказ ${esc(o.id)}</p>` : ''}
        ${retry && o?.gameId && byId(o.gameId) ? '<button class="btn btn-acid" type="button" data-retry>Открыть игру</button>' : ''}
      </div>`);
    $('[data-retry]', body)?.addEventListener('click', () => openGame(byId(o.gameId)));
  };

  const renderPending = (o) => {
    if ($(`.pay[data-order="${CSS.escape(o.id)}"]`, modal.body)) return;
    const body = modal.open(`
      <div class="pay" data-order="${esc(o.id)}">
        <div class="pay-head">
          <img src="${esc(o.cover)}" alt="">
          <div><span class="kicker">Заказ · ${esc(o.id)}</span><h3>${esc(o.title)}</h3></div>
          <div class="pay-sum">${money(o.amount)}</div>
        </div>
        <div class="pay-grid${o.qr ? '' : ' one'}">
          ${o.qr ? `<div><div class="qr">${o.qr}</div><div class="qr-cap">Наведите камеру телефона, чтобы открыть счёт</div></div>` : ''}
          <div class="pay-actions">
            ${o.demo
              ? `<div class="demo-note">Это демо-товар: настоящий счёт не создаётся. Нажмите кнопку, чтобы посмотреть, как выдаётся ключ.</div>
                 <button class="btn btn-acid" type="button" data-demo>Симулировать оплату</button>`
              : `<a class="btn btn-acid" href="${esc(o.payUrl)}" target="_blank" rel="noopener">Оплатить в Telegram ${ARROW}</a>
                 ${o.webUrl ? `<a class="btn btn-line" href="${esc(o.webUrl)}" target="_blank" rel="noopener">Оплатить в браузере</a>` : ''}`}
            <div class="status"><span class="radar"></span><div>Ждём оплату<small>Страница обновится сама</small></div><b class="timer">--:--</b></div>
            <p class="hint">После оплаты ключ появится здесь${o.demo ? '' : ' и придёт в чат с @CryptoBot'}. Ссылку на заказ можно сохранить и открыть позже.</p>
            <div class="pay-links"><button class="btn-ghost" type="button" data-copy-link>Скопировать ссылку на заказ</button><button class="btn-ghost" type="button" data-cancel>Отменить заказ</button></div>
          </div>
        </div>
      </div>`, flow);

    const timer = $('.timer', body);
    const tick = () => {
      const left = Math.max(0, o.expiresAt - Date.now());
      const m = Math.floor(left / 60e3), s = Math.floor((left % 60e3) / 1000);
      timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      timer.classList.toggle('warn', left < 120e3);
      if (!left) { clearInterval(flow.ticker); clearTimeout(flow.poller); poll(); }
    };
    tick();
    flow.ticker = setInterval(tick, 1000);

    $('[data-copy-link]', body).addEventListener('click', async () => {
      toast((await copyText(link)) ? 'Ссылка на заказ скопирована' : 'Не удалось скопировать', 'ok');
    });
    const cancel = $('[data-cancel]', body);
    cancel.addEventListener('click', async () => {
      if (!cancel.dataset.sure) { cancel.dataset.sure = 1; cancel.textContent = 'Точно отменить? Нажмите ещё раз'; return; }
      cancel.disabled = true;
      try {
        render(await api(`/api/orders/${encodeURIComponent(id)}/cancel?t=${encodeURIComponent(token)}`, { method: 'POST' }));
        refreshGames();
      } catch (e) {
        toast(e.message, 'error');
        cancel.disabled = false;
      }
    });
    $('[data-demo]', body)?.addEventListener('click', async (e) => {
      e.currentTarget.classList.add('loading');
      try { render(await api(`/api/orders/${encodeURIComponent(id)}/demo-pay?t=${encodeURIComponent(token)}`, { method: 'POST' })); } catch (err) { toast(err.message, 'error'); }
    });
  };

  async function poll() {
    if (flow.stopped) return;
    try {
      const o = await api(`/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
      if (flow.stopped) return;
      render(o);
    } catch (e) {
      if (flow.stopped) return;
      if (e.status === 404) {
        flow.stop();
        mine.put({ id, status: 'missing' });
        return renderState('🔍', 'Заказ не найден', 'Проверьте ссылку: возможно, она скопирована не целиком.');
      }
    }
    if (!flow.stopped) flow.poller = setTimeout(poll, document.hidden ? 8000 : 3000);
  }
  const onVis = () => { if (!document.hidden && !flow.stopped) { clearTimeout(flow.poller); poll(); } };
  document.addEventListener('visibilitychange', onVis);
  const stop0 = flow.stop;
  flow.stop = () => { stop0(); document.removeEventListener('visibilitychange', onVis); };

  if (initial) {
    render(initial);
    if (!flow.stopped) flow.poller = setTimeout(poll, 3000);
  } else {
    modal.open('<div class="state"><div class="big"><span class="radar" style="display:inline-block"></span></div><h2>Загружаем заказ…</h2></div>', flow);
    poll();
  }
}

function showWin(o, { reel = false } = {}) {
  const spin = reel && !reduced && S.games.some((g) => g.cover);
  const free = o.type === 'giveaway';
  const body = modal.open(`
    <div class="win">
      <span class="kicker"><i>${free ? 'FREE' : 'PAID'}</i> ${free ? 'Раздача' : `Заказ · ${esc(o.id)}`}</span>
      <h2>${spin ? 'Крутим барабан…' : 'Ваш ключ'}</h2>
      ${spin ? '<div class="reel"><div class="reel-strip"></div><div class="reel-mark"></div></div>' : ''}
      <div class="keycard-slot"></div>
    </div>`);
  if (spin) runReel(body, o).then(() => revealKey(body, o, true));
  else revealKey(body, o, reel);
}

function runReel(body, o) {
  return new Promise((resolve) => {
    const reelEl = $('.reel', body), strip = $('.reel-strip', body);
    const pool = S.games.filter((g) => g.cover && g.id !== o.gameId).map((g) => g.cover);
    const N = 44, WIN = 38;
    const tiles = Array.from({ length: N }, (_, i) => (i === WIN || !pool.length ? o.cover : pool[(Math.random() * pool.length) | 0]));
    strip.innerHTML = tiles.map(() => '<div class="reel-tile"></div>').join('');
    [...strip.children].forEach((el, i) => { el.style.backgroundImage = cssUrl(tiles[i]); });
    requestAnimationFrame(() => {
      const tile = strip.children[WIN];
      const center = reelEl.clientWidth / 2;
      const exact = tile.offsetLeft + tile.offsetWidth / 2 - center;
      const off = exact + (Math.random() - 0.5) * tile.offsetWidth * 0.6;
      const a = strip.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-off}px)` }], { duration: 5200, easing: 'cubic-bezier(.1,.7,.07,1)', fill: 'forwards' });
      a.finished
        .then(() => strip.animate([{ transform: `translateX(${-off}px)` }, { transform: `translateX(${-exact}px)` }], { duration: 500, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'forwards' }).finished)
        .then(() => { tile.classList.add('hit'); setTimeout(resolve, 650); })
        .catch(resolve);
    });
  });
}

function revealKey(body, o, celebrate) {
  const free = o.type === 'giveaway';
  $('h2', body).textContent = free ? 'Ключ ваш!' : 'Оплачено!';
  const slot = $('.keycard-slot', body);
  const code = o.key || '';
  slot.innerHTML = `
    <div class="keycard">
      <div class="bg"></div>
      <div class="keycard-top"><span>STEAM KEY</span><span>${o.demo ? 'DEMO' : 'GLOBAL'}</span></div>
      <h3>${esc(o.title)}</h3>
      <code class="code"></code>
      <div class="keycard-actions">
        <button class="btn btn-acid" type="button" data-copy>Скопировать ключ</button>
        <a class="btn btn-line" href="https://store.steampowered.com/account/registerkey?key=${encodeURIComponent(code)}" target="_blank" rel="noopener">Активировать в Steam ↗</a>
      </div>
    </div>
    <div class="win-foot">
      <span>✓ Сохранён в «Моих ключах»</span>
      ${!free && !o.demo ? '<span>✓ Продублирован в чат @CryptoBot</span>' : ''}
      ${o.demo ? '<span>Это демо-ключ, он не активируется</span>' : ''}
    </div>`;
  $('.bg', slot).style.backgroundImage = cssUrl(o.cover);
  scramble($('.code', slot), code || 'Ключ недоступен', celebrate && !reduced ? 1500 : 0);
  if (celebrate) confetti();
  const copyBtn = $('[data-copy]', slot);
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(code);
    copyBtn.textContent = ok ? 'Скопировано ✓' : 'Не удалось';
    setTimeout(() => { copyBtn.textContent = 'Скопировать ключ'; }, 1800);
  });
}

// ───────── мои ключи ─────────
function renderMine() {
  const list = mine.all();
  $('#drawerList').innerHTML = list.length
    ? list.map((m) => `
      <button class="mk" type="button" data-id="${esc(m.id)}">
        ${m.cover ? `<img src="${esc(m.cover)}" alt="">` : '<span></span>'}
        <span>
          <b>${esc(m.title || `Заказ ${m.id}`)}</b>
          ${m.key ? `<code>${esc(m.key)}</code>` : `<span class="st ${m.status === 'pending' ? 'pending' : ''}">${STATUS[m.status] || 'Проверяем…'}</span>`}
        </span>
      </button>`).join('')
    : '<div class="drawer-empty"><b>Пока пусто</b>Здесь появятся купленные ключи и ключи из раздач.</div>';
}
async function refreshMine() {
  const todo = mine.all().filter((m) => !m.key && m.token && ['pending', 'paid_no_key', undefined].includes(m.status)).slice(0, 10);
  await Promise.all(todo.map(async (m) => {
    try {
      const o = await api(`/api/orders/${encodeURIComponent(m.id)}?t=${encodeURIComponent(m.token)}`);
      mine.put({ id: m.id, status: o.status, key: o.key, title: o.title, cover: o.cover });
    } catch (e) {
      if (e.status === 404) mine.put({ id: m.id, status: 'missing' });
    }
  }));
  if (todo.length && !drawer.el.hidden) renderMine();
}

// ───────── данные ─────────
async function refreshGames() {
  try {
    const data = await api('/api/games');
    S.games = data.games;
    S.stats = data.stats;
    renderStats(false);
    renderDrops(true);
    renderGrid(true);
  } catch { /* не критично */ }
}

function openFromUrl() {
  const p = new URLSearchParams(location.search);
  const id = p.get('order'), t = p.get('t');
  if (!id || !t) return;
  mine.put({ id, token: t });
  history.replaceState(null, '', location.pathname + location.hash);
  showOrder(id, t);
}

function bindUi() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) modal.close();
    if (e.target.closest('[data-close-drawer]')) drawer.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modal.el.hidden) modal.close(); else drawer.close();
  });
  // скрываем битые картинки
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);

  $('#myKeysBtn').addEventListener('click', () => drawer.open());
  $('#drawerList').addEventListener('click', (e) => {
    const b = e.target.closest('.mk');
    const m = b && mine.all().find((x) => x.id === b.dataset.id);
    if (!m?.token) return;
    drawer.close();
    showOrder(m.id, m.token);
  });

  const grid = $('#grid');
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (c) openGame(byId(c.dataset.id));
  });
  grid.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card-in')) {
      e.preventDefault();
      openGame(byId(e.target.closest('.card').dataset.id));
    }
  });
  $('#chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    S.genre = c.dataset.g;
    $$('.chip').forEach((x) => x.setAttribute('aria-selected', x === c));
    renderGrid();
  });
  let qt;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => { S.q = e.target.value; renderGrid(); }, 140);
  });
  $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; renderGrid(); });
}

async function init() {
  $('#year').textContent = new Date().getFullYear();
  splitDrop();
  bindUi();
  setupNav();
  setupPointer();
  setupFx();
  setupMagnetic();
  setupHeroTilt();
  updateCount();
  reveal();
  renderDeck();
  $('#grid').innerHTML = '<div class="skeleton"></div>'.repeat(6);
  try {
    const [cfg, data, feed] = await Promise.all([
      api('/api/config'), api('/api/games'), api('/api/feed').catch(() => ({ items: [] })),
    ]);
    S.cfg = cfg;
    S.games = data.games;
    S.stats = data.stats;
    applyCfg();
    renderStats();
    renderDeck();
    renderTicker(feed.items);
    renderDrops();
    renderChips();
    renderGrid();
  } catch (e) {
    renderTicker([]);
    $('#grid').innerHTML = '<div class="empty"><b>Не удалось загрузить каталог</b>Обновите страницу через минуту.</div>';
  }
  openFromUrl();
}
init();
