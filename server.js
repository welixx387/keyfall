import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import * as store from './lib/store.js';
import { createCryptoPay } from './lib/cryptopay.js';

const ROOT = import.meta.dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* переменные можно задать и без .env */ }

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const cfg = {
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  token: process.env.CRYPTO_PAY_TOKEN || '',
  network: process.env.CRYPTO_PAY_NETWORK === 'testnet' ? 'testnet' : 'mainnet',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  shopName: process.env.SHOP_NAME || 'KEYFALL',
  supportUrl: process.env.SUPPORT_URL || '',
  fiat: (process.env.FIAT || 'USD').toUpperCase(),
  assets: (process.env.ACCEPTED_ASSETS || 'USDT,TON,BTC').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  ttlMin: Math.min(Math.max(num(process.env.INVOICE_TTL_MIN, 15), 2), 1440),
  cooldownH: Math.max(num(process.env.GIVEAWAY_COOLDOWN_HOURS, 24), 0),
  trustProxy: process.env.TRUST_PROXY === 'true',
};
const isPublicHost = !/localhost|127\.0\.0\.1|\[::1\]/.test(cfg.publicUrl);

const db = store.load();
const save = store.save;
const cp = createCryptoPay(cfg.token, cfg.network);
const UPLOADS = path.join(ROOT, 'public', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// ───────────────────────── утилиты ─────────────────────────
const now = () => Date.now();
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a ?? '')), B = Buffer.from(String(b ?? ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const ipHash = (req) => crypto.createHash('sha256').update(`${db.meta.secret}|${req.ip}`).digest('hex').slice(0, 24);
const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const k = `${name}:${req.ip}`;
    const t = now();
    const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Слишком много запросов. Подождите немного.' });
    arr.push(t);
    hits.set(k, arr);
    next();
  };
}
setInterval(() => {
  const t = now();
  for (const [k, arr] of hits) if (!arr.some((x) => t - x < 3600e3)) hits.delete(k);
}, 600e3).unref();

function keyStats() {
  const m = new Map();
  for (const k of db.keys) {
    let c = m.get(k.gameId);
    if (!c) m.set(k.gameId, (c = { available: 0, reserved: 0, sold: 0, claimed: 0, total: 0 }));
    c[k.status]++;
    c.total++;
  }
  return m;
}
const EMPTY = { available: 0, reserved: 0, sold: 0, claimed: 0, total: 0 };

function publicGame(g, c = EMPTY) {
  return {
    id: g.id, title: g.title, appId: g.appId, description: g.description, cover: g.cover, hero: g.hero,
    price: g.price, oldPrice: g.oldPrice, mode: g.mode, genres: g.genres, region: g.region,
    featured: !!g.featured, demo: !!g.demo, createdAt: g.createdAt,
    stock: c.available, given: c.sold + c.claimed, total: c.total,
  };
}

function publicOrder(o, { withToken = false } = {}) {
  const key = o.status === 'paid' ? db.keys.find((k) => k.id === o.keyId) : null;
  return {
    id: o.id, ...(withToken ? { token: o.token } : {}),
    type: o.type, status: o.status, demo: !!o.demo,
    gameId: o.gameId, title: o.title, cover: o.cover, amount: o.amount, fiat: o.fiat,
    payUrl: o.payUrl || null, webUrl: o.webUrl || null,
    createdAt: o.createdAt, expiresAt: o.expiresAt, paidAt: o.paidAt || null,
    paidAsset: o.paidAsset || null, paidAmount: o.paidAmount || null,
    key: key?.code || null,
  };
}

function findOrder(req) {
  const o = db.orders.find((x) => x.id === req.params.id);
  const t = req.query.t || req.body?.t;
  if (!o || !safeEq(o.token, t)) throw httpError(404, 'Заказ не найден');
  return o;
}

// ───────────────────── жизненный цикл заказа ─────────────────────
function releaseKey(o) {
  const key = db.keys.find((k) => k.id === o.keyId);
  if (key && key.status === 'reserved' && key.orderId === o.id) {
    key.status = 'available';
    key.orderId = null;
  }
}

function fulfill(o, inv = {}) {
  if (o.status === 'paid') return;
  let key = db.keys.find((k) => k.id === o.keyId);
  const ours = key && (key.status === 'available' || (key.status === 'reserved' && key.orderId === o.id));
  // если бронь успела слететь и ключ ушёл — берём любой свободный ключ этой игры
  if (!ours) key = db.keys.find((k) => k.gameId === o.gameId && k.status === 'available');
  o.paidAt ??= now();
  if (inv.paid_asset) o.paidAsset = inv.paid_asset;
  if (inv.paid_amount) o.paidAmount = inv.paid_amount;
  if (key) {
    key.status = 'sold';
    key.orderId = o.id;
    key.soldAt = now();
    o.keyId = key.id;
    o.status = 'paid';
  } else {
    o.keyId = null;
    o.status = 'paid_no_key';
    console.warn(`[!] Заказ ${o.id} оплачен, но ключей «${o.title}» нет — добавьте ключи в админке, он выдастся автоматически`);
  }
  save();
}

function expire(o, status = 'expired') {
  if (o.status !== 'pending') return;
  o.status = status;
  releaseKey(o);
  save();
}

// Выдать ключи заказам, которые оплатили, когда ключей не было
function settleWaiting(gameId) {
  for (const o of db.orders.filter((x) => x.status === 'paid_no_key' && x.gameId === gameId)) {
    const key = db.keys.find((k) => k.gameId === gameId && k.status === 'available');
    if (!key) break;
    Object.assign(key, { status: 'sold', orderId: o.id, soldAt: now() });
    Object.assign(o, { keyId: key.id, status: 'paid' });
  }
}

function applyInvoice(o, inv) {
  if (!inv) return;
  if (inv.status === 'paid') fulfill(o, inv);
  else if (inv.status === 'expired') expire(o);
}

const inflight = new Map();
function refresh(o, force = false) {
  if (o.status !== 'pending' || !o.invoiceId) return;
  if (!force && now() - (o.checkedAt || 0) < 4000) return;
  if (inflight.has(o.id)) return inflight.get(o.id);
  o.checkedAt = now();
  const p = cp.getInvoices({ invoice_ids: String(o.invoiceId) })
    .then((r) => applyInvoice(o, r.items?.[0]))
    .catch((e) => console.warn('[cryptopay]', e.message))
    .finally(() => inflight.delete(o.id));
  inflight.set(o.id, p);
  return p;
}

// Раз в 30 секунд сверяем все неоплаченные счета (на случай, если вебхук не настроен)
async function sweep() {
  const t = now();
  for (const o of db.orders) if (o.status === 'pending' && !o.invoiceId && t > o.expiresAt) expire(o);
  const pending = db.orders.filter((o) => o.status === 'pending' && o.invoiceId);
  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100);
    try {
      const r = await cp.getInvoices({ invoice_ids: chunk.map((o) => o.invoiceId).join(','), count: 100 });
      for (const inv of r.items || []) applyInvoice(chunk.find((o) => o.invoiceId === inv.invoice_id), inv);
    } catch (e) {
      console.warn('[cryptopay] sweep:', e.message);
    }
  }
}
setInterval(sweep, 30e3).unref();

// ───────────────────────── приложение ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', cfg.trustProxy);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});

// Вебхук CryptoBot — нужен «сырой» body для проверки подписи, поэтому до express.json()
app.post('/api/cryptopay/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!cp.verifyWebhook(req.body, req.get('crypto-pay-api-signature'))) return res.status(401).json({ ok: false });
  let update;
  try { update = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ ok: false }); }
  if (update.update_type === 'invoice_paid') {
    const inv = update.payload || {};
    const o = db.orders.find((x) => x.invoiceId === inv.invoice_id || x.id === inv.payload);
    if (o) fulfill(o, inv);
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '200kb' }));

// ───────── публичное API ─────────
app.get('/api/config', (req, res) => {
  res.json({
    shopName: cfg.shopName, fiat: cfg.fiat, assets: cfg.assets, network: cfg.network,
    ttlMin: cfg.ttlMin, cooldownH: cfg.cooldownH, supportUrl: cfg.supportUrl,
  });
});

app.get('/api/games', (req, res) => {
  const stats = keyStats();
  const games = db.games
    .filter((g) => g.active !== false)
    .sort((a, b) => (!!b.featured - !!a.featured) || (a.sort ?? 0) - (b.sort ?? 0) || b.createdAt - a.createdAt)
    .map((g) => publicGame(g, stats.get(g.id)));
  const delivered = db.orders.filter((o) => o.status === 'paid').length;
  res.json({
    games,
    stats: { delivered, games: games.length, inStock: games.reduce((s, g) => s + g.stock, 0) },
  });
});

app.get('/api/feed', (req, res) => {
  const items = db.orders
    .filter((o) => o.status === 'paid')
    .sort((a, b) => b.paidAt - a.paidAt)
    .slice(0, 16)
    .map((o) => ({ title: o.title, type: o.type, at: o.paidAt }));
  res.json({ items });
});

app.post('/api/orders', limit('order', 10, 10 * 60e3), async (req, res) => {
  const g = db.games.find((x) => x.id === req.body?.gameId && x.active !== false);
  if (!g || g.mode !== 'sale') throw httpError(404, 'Игра не найдена');
  if (!(g.price > 0)) throw httpError(400, 'У игры не указана цена');

  const ip = ipHash(req);
  const open = db.orders.filter((o) => o.ipHash === ip && o.status === 'pending' && o.expiresAt > now());
  if (open.length >= 3) throw httpError(429, 'У вас уже есть 3 неоплаченных заказа. Оплатите или отмените их в «Моих ключах».');

  const key = db.keys.find((k) => k.gameId === g.id && k.status === 'available');
  if (!key) throw httpError(409, 'Ключи закончились — загляните чуть позже');

  const o = {
    id: rid(6), token: rid(24), type: 'sale', status: 'pending', demo: !!g.demo,
    gameId: g.id, title: g.title, cover: g.cover, keyId: key.id,
    amount: g.price, fiat: cfg.fiat, ipHash: ip,
    createdAt: now(), expiresAt: now() + cfg.ttlMin * 60e3,
  };
  key.status = 'reserved';
  key.orderId = o.id;
  db.orders.push(o);
  save();

  if (!o.demo) {
    try {
      const inv = await cp.createInvoice({
        currency_type: 'fiat',
        fiat: cfg.fiat,
        accepted_assets: cfg.assets.join(','),
        amount: g.price.toFixed(2),
        description: `${g.title} — ключ Steam · ${cfg.shopName}`.slice(0, 1024),
        // покупатель увидит ключ прямо в @CryptoBot сразу после оплаты
        hidden_message: `Ваш ключ Steam для «${g.title}»:\n${key.code}\n\nАктивация: Steam → Игры → Активировать в Steam`.slice(0, 2048),
        payload: o.id,
        expires_in: cfg.ttlMin * 60,
        allow_comments: false,
        allow_anonymous: true,
        ...(isPublicHost && {
          paid_btn_name: 'callback',
          paid_btn_url: `${cfg.publicUrl}/?order=${o.id}&t=${o.token}`,
        }),
      });
      Object.assign(o, {
        invoiceId: inv.invoice_id,
        payUrl: inv.bot_invoice_url || inv.pay_url,
        webUrl: inv.web_app_invoice_url || null,
        expiresAt: inv.expiration_date ? Date.parse(inv.expiration_date) : o.expiresAt,
      });
      save();
    } catch (e) {
      console.error('[cryptopay] createInvoice:', e.message);
      o.error = e.message;
      expire(o, 'failed');
      throw httpError(502, 'Не удалось создать счёт в CryptoBot. Попробуйте ещё раз через минуту.');
    }
  }
  res.json({ ...publicOrder(o, { withToken: true }), qr: await qrFor(o) });
});

async function qrFor(o) {
  if (o.status !== 'pending' || !o.payUrl) return null;
  return QRCode.toString(o.payUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0a0a0f', light: '#ffffff' } });
}

app.get('/api/orders/:id', limit('poll', 120, 60e3), async (req, res) => {
  const o = findOrder(req);
  if (o.status === 'pending' && !o.invoiceId && now() > o.expiresAt) expire(o);
  await refresh(o);
  res.json({ ...publicOrder(o), qr: await qrFor(o) });
});

app.post('/api/orders/:id/cancel', async (req, res) => {
  const o = findOrder(req);
  if (o.status !== 'pending') return res.json(publicOrder(o));
  if (o.invoiceId) {
    await refresh(o, true);
    if (o.status !== 'pending') return res.json(publicOrder(o));
    try {
      await cp.deleteInvoice(o.invoiceId);
    } catch (e) {
      console.warn('[cryptopay] deleteInvoice:', e.message);
      throw httpError(502, 'Не получилось отменить счёт. Попробуйте ещё раз.');
    }
  }
  expire(o, 'cancelled');
  res.json(publicOrder(o));
});

// Только для демо-товаров: имитация оплаты, чтобы посмотреть выдачу ключа
app.post('/api/orders/:id/demo-pay', (req, res) => {
  const o = findOrder(req);
  if (!o.demo) throw httpError(400, 'Это не демо-заказ');
  if (o.status === 'pending') fulfill(o, { paid_asset: 'USDT', paid_amount: String(o.amount) });
  res.json(publicOrder(o));
});

app.post('/api/giveaway/:id/claim', limit('claim', 6, 60e3), (req, res) => {
  const g = db.games.find((x) => x.id === req.params.id && x.active !== false);
  if (!g || g.mode !== 'giveaway') throw httpError(404, 'Раздача не найдена');
  const ip = ipHash(req);
  const mine = db.orders.filter((o) => o.type === 'giveaway' && o.ipHash === ip);
  if (mine.some((o) => o.gameId === g.id)) throw httpError(409, 'Вы уже забрали ключ из этой раздачи');
  const last = Math.max(0, ...mine.map((o) => o.createdAt));
  const nextAt = last + cfg.cooldownH * 3600e3;
  if (cfg.cooldownH > 0 && nextAt > now()) {
    const h = Math.ceil((nextAt - now()) / 3600e3);
    throw Object.assign(httpError(429, `Следующий бесплатный ключ можно забрать через ${h} ч.`), { nextAt });
  }
  const key = db.keys.find((k) => k.gameId === g.id && k.status === 'available');
  if (!key) throw httpError(409, 'Раздача закончилась — ключи разобрали');

  const o = {
    id: rid(6), token: rid(24), type: 'giveaway', status: 'paid', demo: !!g.demo,
    gameId: g.id, title: g.title, cover: g.cover, keyId: key.id,
    amount: 0, fiat: cfg.fiat, ipHash: ip, createdAt: now(), expiresAt: now(), paidAt: now(),
  };
  Object.assign(key, { status: 'claimed', orderId: o.id, soldAt: now() });
  db.orders.push(o);
  save();
  res.json(publicOrder(o, { withToken: true }));
});

// ───────── админка ─────────
const COOKIE = 'kf_admin';
const SESSION_MS = 7 * 86400e3;
const sign = (exp) => crypto.createHmac('sha256', `${db.meta.secret}|${cfg.adminPassword}`).update(`admin:${exp}`).digest('base64url');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function isAdmin(req) {
  if (!cfg.adminPassword) return false;
  const [exp, mac] = (readCookie(req, COOKIE) || '').split('.');
  return !!exp && +exp > now() && safeEq(mac, sign(exp));
}
function adminOnly(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Нужно войти в админку' });
  // защита от CSRF: браузер не отправит этот заголовок с чужого сайта без CORS
  if (req.method !== 'GET' && req.get('x-kf') !== '1') return res.status(403).json({ error: 'Forbidden' });
  next();
}
const cookieFlags = () => `Path=/; HttpOnly; SameSite=Strict${cfg.publicUrl.startsWith('https') ? '; Secure' : ''}`;

app.post('/api/admin/login', limit('login', 6, 15 * 60e3), (req, res) => {
  if (!cfg.adminPassword) throw httpError(503, 'Задайте ADMIN_PASSWORD в файле .env и перезапустите сервер');
  if (req.get('x-kf') !== '1' || !safeEq(req.body?.password, cfg.adminPassword)) throw httpError(401, 'Неверный пароль');
  const exp = now() + SESSION_MS;
  res.set('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags()}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags()}`);
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req), configured: !!cfg.adminPassword }));

app.use('/api/admin', adminOnly);

app.get('/api/admin/overview', async (req, res) => {
  const sales = db.orders.filter((o) => o.type === 'sale' && o.status === 'paid' && !o.demo);
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const series = Array.from({ length: 14 }, (_, i) => {
    const from = day0.getTime() - (13 - i) * 86400e3;
    const list = sales.filter((o) => o.paidAt >= from && o.paidAt < from + 86400e3);
    return { date: from, count: list.length, revenue: list.reduce((s, o) => s + o.amount, 0) };
  });
  const keys = { available: 0, reserved: 0, sold: 0, claimed: 0, total: 0 };
  for (const c of keyStats().values()) for (const k in keys) keys[k] += c[k];
  const [balance, me] = await Promise.all([cp.getBalance().catch(() => null), cp.getMe().catch(() => null)]);
  res.json({
    revenue: sales.reduce((s, o) => s + o.amount, 0),
    sold: sales.length,
    giveaways: db.orders.filter((o) => o.type === 'giveaway').length,
    pending: db.orders.filter((o) => o.status === 'pending').length,
    waiting: db.orders.filter((o) => o.status === 'paid_no_key').length,
    keys, series,
    balance: balance?.filter((b) => +b.available > 0 || +b.onhold > 0) ?? null,
    app: me ? { name: me.name, id: me.app_id } : null,
    hasDemo: db.games.some((g) => g.demo),
    cfg: {
      shopName: cfg.shopName, fiat: cfg.fiat, assets: cfg.assets, network: cfg.network, ttlMin: cfg.ttlMin,
      cooldownH: cfg.cooldownH, publicUrl: cfg.publicUrl, webhookUrl: `${cfg.publicUrl}/api/cryptopay/webhook`,
      isPublicHost, tokenSet: !!cfg.token,
    },
  });
});

function cleanGame(body, prev = {}) {
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const url = (v) => {
    const s = str(v, 1000);
    return /^(https?:\/\/|\/uploads\/)/.test(s) ? s : '';
  };
  const price = Math.round(num(body.price, 0) * 100) / 100;
  const oldPrice = Math.round(num(body.oldPrice, 0) * 100) / 100;
  const g = {
    ...prev,
    title: str(body.title, 120),
    appId: str(body.appId, 12).replace(/\D/g, ''),
    description: str(body.description, 2000),
    cover: url(body.cover),
    hero: url(body.hero),
    mode: body.mode === 'giveaway' ? 'giveaway' : 'sale',
    price: body.mode === 'giveaway' ? 0 : Math.max(price, 0),
    oldPrice: oldPrice > price ? oldPrice : null,
    genres: (Array.isArray(body.genres) ? body.genres : String(body.genres ?? '').split(','))
      .map((s) => String(s).trim()).filter(Boolean).slice(0, 6),
    region: str(body.region, 40) || 'Весь мир',
    featured: !!body.featured,
    active: body.active !== false,
    sort: num(body.sort, 0),
  };
  if (!g.title) throw httpError(400, 'Укажите название игры');
  if (g.mode === 'sale' && !(g.price > 0)) throw httpError(400, 'Укажите цену больше нуля');
  return g;
}

function parseKeys(text) {
  return [...new Set(String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length <= 200))];
}
function addKeys(gameId, text) {
  const existing = new Set(db.keys.map((k) => k.code));
  let added = 0, duplicates = 0;
  for (const code of parseKeys(text)) {
    if (existing.has(code)) { duplicates++; continue; }
    db.keys.push({ id: rid(8), gameId, code, status: 'available', orderId: null, createdAt: now() });
    existing.add(code);
    added++;
  }
  settleWaiting(gameId);
  return { added, duplicates };
}

app.get('/api/admin/games', (req, res) => {
  const stats = keyStats();
  res.json({
    games: db.games
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ ...publicGame(g, stats.get(g.id)), active: g.active !== false, sort: g.sort ?? 0, keys: stats.get(g.id) || EMPTY })),
  });
});

app.post('/api/admin/games', (req, res) => {
  const g = { id: rid(6), createdAt: now(), ...cleanGame(req.body) };
  db.games.push(g);
  const result = req.body.keys ? addKeys(g.id, req.body.keys) : { added: 0, duplicates: 0 };
  save();
  res.json({ game: g, ...result });
});

app.put('/api/admin/games/:id', (req, res) => {
  const i = db.games.findIndex((g) => g.id === req.params.id);
  if (i < 0) throw httpError(404, 'Игра не найдена');
  db.games[i] = { ...cleanGame(req.body, db.games[i]), id: db.games[i].id, createdAt: db.games[i].createdAt };
  save();
  res.json({ game: db.games[i] });
});

app.delete('/api/admin/games/:id', (req, res) => {
  const g = db.games.find((x) => x.id === req.params.id);
  if (!g) throw httpError(404, 'Игра не найдена');
  if (db.orders.some((o) => o.gameId === g.id && o.status === 'pending')) {
    throw httpError(409, 'По игре есть неоплаченные заказы — скройте её и удалите позже');
  }
  // проданные ключи остаются в истории заказов, свободные удаляются
  db.keys = db.keys.filter((k) => k.gameId !== g.id || k.status === 'sold' || k.status === 'claimed');
  db.games = db.games.filter((x) => x.id !== g.id);
  save();
  res.json({ ok: true });
});

app.get('/api/admin/games/:id/keys', (req, res) => {
  const keys = db.keys
    .filter((k) => k.gameId === req.params.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((k) => ({ id: k.id, code: k.code, status: k.status, orderId: k.orderId, createdAt: k.createdAt, soldAt: k.soldAt }));
  res.json({ keys });
});

app.post('/api/admin/games/:id/keys', (req, res) => {
  if (!db.games.some((g) => g.id === req.params.id)) throw httpError(404, 'Игра не найдена');
  const result = addKeys(req.params.id, req.body?.text);
  save();
  res.json(result);
});

app.delete('/api/admin/keys/:id', (req, res) => {
  const k = db.keys.find((x) => x.id === req.params.id);
  if (!k) throw httpError(404, 'Ключ не найден');
  if (k.status !== 'available') throw httpError(409, 'Удалить можно только свободный ключ');
  db.keys = db.keys.filter((x) => x !== k);
  save();
  res.json({ ok: true });
});

app.get('/api/admin/orders', (req, res) => {
  const orders = db.orders
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 500)
    .map((o) => ({ ...publicOrder(o), key: db.keys.find((k) => k.id === o.keyId && (k.status === 'sold' || k.status === 'claimed'))?.code || null, invoiceId: o.invoiceId || null, error: o.error || null }));
  res.json({ orders });
});

app.post('/api/admin/orders/:id/check', async (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id);
  if (!o) throw httpError(404, 'Заказ не найден');
  await refresh(o, true);
  res.json(publicOrder(o));
});

app.get('/api/admin/steam/:appid', async (req, res) => {
  const appid = String(req.params.appid).match(/\d+/)?.[0];
  if (!appid) throw httpError(400, 'Нужен ID приложения Steam');
  const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=russian&cc=us`, {
    signal: AbortSignal.timeout(12000),
    headers: { 'Accept-Language': 'ru' },
  }).catch(() => null);
  const j = await r?.json().catch(() => null);
  const d = j?.[appid];
  if (!d?.success) throw httpError(404, 'Steam не нашёл такую игру');
  const x = d.data;
  res.json({
    appId: appid,
    title: x.name,
    description: decodeHtml(x.short_description || ''),
    cover: x.header_image,
    hero: x.background_raw || x.background || x.header_image,
    genres: (x.genres || []).map((g) => g.description).slice(0, 4),
    steamPrice: x.price_overview ? x.price_overview.final / 100 : null,
  });
});
const decodeHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

app.post('/api/admin/upload', express.raw({ type: 'image/*', limit: '6mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'Пустой файл');
  const sig = buf.subarray(0, 12);
  const ext =
    sig[0] === 0x89 && sig.toString('latin1', 1, 4) === 'PNG' ? 'png'
    : sig[0] === 0xff && sig[1] === 0xd8 ? 'jpg'
    : sig.toString('latin1', 0, 4) === 'GIF8' ? 'gif'
    : sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP' ? 'webp'
    : null;
  if (!ext) throw httpError(400, 'Поддерживаются PNG, JPG, WEBP и GIF');
  const name = `${rid(10)}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  res.json({ url: `/uploads/${name}` });
});

app.post('/api/admin/demo/clear', (req, res) => {
  const ids = new Set(db.games.filter((g) => g.demo).map((g) => g.id));
  db.games = db.games.filter((g) => !ids.has(g.id));
  db.keys = db.keys.filter((k) => !ids.has(k.gameId));
  db.orders = db.orders.filter((o) => !o.demo && !ids.has(o.gameId));
  save();
  res.json({ removed: ids.size });
});

// ───────── статика и ошибки ─────────
app.use('/uploads', express.static(UPLOADS, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.expose) console.error(err);
  res.status(status).json({ error: err.expose ? err.message : 'Ошибка сервера', ...(err.nextAt && { nextAt: err.nextAt }) });
});

app.listen(cfg.port, () => {
  console.log(`\n  ${cfg.shopName} запущен →  http://localhost:${cfg.port}`);
  console.log(`  Админка          →  http://localhost:${cfg.port}/admin`);
  console.log(`  CryptoBot        →  ${cfg.network}${cfg.token ? '' : '  (!) CRYPTO_PAY_TOKEN не задан'}`);
  if (!cfg.adminPassword) console.log('  (!) ADMIN_PASSWORD не задан — админка отключена');
  console.log('');
  sweep();
});
