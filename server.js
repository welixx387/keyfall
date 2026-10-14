import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import QRCode from 'qrcode';
import * as db from './lib/db.js';
import { q, tx } from './lib/db.js';
import { createCryptoPay } from './lib/cryptopay.js';
import { seedDemo, clearDemo } from './lib/demo.js';

const ROOT = import.meta.dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* на хостинге переменные задаются в панели */ }

const ON_VERCEL = !!process.env.VERCEL;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
const cfg = {
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || vercelUrl || `http://localhost:${num(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  token: process.env.CRYPTO_PAY_TOKEN || '',
  network: process.env.CRYPTO_PAY_NETWORK === 'testnet' ? 'testnet' : 'mainnet',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  shopName: process.env.SHOP_NAME || 'KEYFALL',
  supportUrl: process.env.SUPPORT_URL || '',
  fiat: (process.env.FIAT || 'USD').toUpperCase(),
  assets: (process.env.ACCEPTED_ASSETS || 'USDT,TON,BTC').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  ttlMin: Math.min(Math.max(num(process.env.INVOICE_TTL_MIN, 15), 2), 1440),
  cooldownH: Math.max(num(process.env.GIVEAWAY_COOLDOWN_HOURS, 24), 0),
  trustProxy: ON_VERCEL || process.env.TRUST_PROXY === 'true',
};
const isPublicHost = !/localhost|127\.0\.0\.1|\[::1\]/.test(cfg.publicUrl);
const cp = createCryptoPay(cfg.token, cfg.network);

// ───────────────────────── утилиты ─────────────────────────
const now = () => Date.now();
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a ?? '')), B = Buffer.from(String(b ?? ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const ipHash = (req) => crypto.createHash('sha256').update(`${db.getSecret()}|${req.ip}`).digest('hex').slice(0, 24);
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

// ───────────────────────── данные ─────────────────────────
const EMPTY = { available: 0, reserved: 0, sold: 0, claimed: 0, total: 0 };

async function keyStats() {
  const m = new Map();
  for (const r of await q(`select game_id, status, count(*)::int as n from keys group by 1, 2`)) {
    let c = m.get(r.game_id);
    if (!c) m.set(r.game_id, (c = { ...EMPTY }));
    c[r.status] = r.n;
    c.total += r.n;
  }
  return m;
}

const gameRow = (r) => ({
  id: r.id, title: r.title, appId: r.app_id, description: r.description, cover: r.cover, hero: r.hero,
  mode: r.mode, price: r.price, oldPrice: r.old_price, genres: r.genres || [], region: r.region,
  featured: r.featured, active: r.active, sort: r.sort, demo: r.demo, createdAt: r.created_at,
});

function publicGame(g, c = EMPTY) {
  return {
    id: g.id, title: g.title, appId: g.appId, description: g.description, cover: g.cover, hero: g.hero,
    price: g.price, oldPrice: g.oldPrice, mode: g.mode, genres: g.genres, region: g.region,
    featured: g.featured, demo: g.demo, createdAt: g.createdAt,
    stock: c.available, given: c.sold + c.claimed, total: c.total,
  };
}

async function getGame(id) {
  const [r] = await q(`select * from games where id = $1`, [id]);
  return r ? gameRow(r) : null;
}

async function loadOrder(id) {
  const [o] = await q(
    `select o.*, k.code as key_code from orders o
     left join keys k on k.id = o.key_id and k.status in ('sold', 'claimed')
     where o.id = $1`, [id]);
  return o || null;
}

function publicOrder(o, { withToken = false } = {}) {
  return {
    id: o.id, ...(withToken ? { token: o.token } : {}),
    type: o.type, status: o.status, demo: o.demo,
    gameId: o.game_id, title: o.title, cover: o.cover, amount: o.amount, fiat: o.fiat,
    payUrl: o.pay_url || null, webUrl: o.web_url || null,
    createdAt: o.created_at, expiresAt: o.expires_at, paidAt: o.paid_at || null,
    paidAsset: o.paid_asset || null, paidAmount: o.paid_amount || null,
    key: o.status === 'paid' ? o.key_code || null : null,
  };
}

async function findOrder(req) {
  const o = await loadOrder(String(req.params.id));
  const t = req.query.t || req.body?.t;
  if (!o || !safeEq(o.token, t)) throw httpError(404, 'Заказ не найден');
  return o;
}

const ORDER_COLS = ['id', 'token', 'type', 'status', 'demo', 'game_id', 'title', 'cover', 'key_id', 'amount', 'fiat', 'ip_hash', 'created_at', 'expires_at', 'paid_at'];
const insertOrder = (t, o) => t(
  `insert into orders (${ORDER_COLS.join(', ')}) values (${ORDER_COLS.map((_, i) => `$${i + 1}`).join(', ')})`,
  ORDER_COLS.map((c) => o[c] ?? null),
);

// Атомарно берём первый свободный ключ игры (два запроса не получат один и тот же ключ)
const takeKey = (t, gameId, status, orderId) => t(
  `update keys set status = $3, order_id = $2, sold_at = case when $3 = 'reserved' then null else $4::double precision end
   where id = (select id from keys where game_id = $1 and status = 'available' order by created_at, id limit 1 for update skip locked)
   returning id, code`,
  [gameId, orderId, status, now()],
).then((rows) => rows[0] || null);

// ───────────────────── жизненный цикл заказа ─────────────────────
async function fulfill(orderId, inv = {}) {
  await tx(async (t) => {
    const [o] = await t(`select * from orders where id = $1 for update`, [orderId]);
    if (!o || o.status === 'paid') return;
    let key = null;
    if (o.key_id) [key] = await t(`select * from keys where id = $1 for update`, [o.key_id]);
    const ours = key && (key.status === 'available' || (key.status === 'reserved' && key.order_id === o.id));
    // если бронь успела слететь и ключ ушёл — берём любой свободный ключ этой игры
    if (!ours) [key] = await t(`select * from keys where game_id = $1 and status = 'available' order by created_at, id limit 1 for update skip locked`, [o.game_id]);
    const paid = [o.paid_at ?? now(), inv.paid_asset ?? null, inv.paid_amount ?? null];
    if (key) {
      await t(`update keys set status = 'sold', order_id = $2, sold_at = $3 where id = $1`, [key.id, o.id, now()]);
      await t(`update orders set status = 'paid', key_id = $2, paid_at = $3, paid_asset = coalesce($4, paid_asset), paid_amount = coalesce($5, paid_amount) where id = $1`, [o.id, key.id, ...paid]);
    } else {
      await t(`update orders set status = 'paid_no_key', key_id = null, paid_at = $2, paid_asset = coalesce($3, paid_asset), paid_amount = coalesce($4, paid_amount) where id = $1`, [o.id, ...paid]);
      console.warn(`[!] Заказ ${o.id} оплачен, но ключей «${o.title}» нет — добавьте ключи в админке, он выдастся автоматически`);
    }
  });
}

async function expire(orderId, status = 'expired') {
  await q(
    `with o as (update orders set status = $2 where id = $1 and status = 'pending' returning id, key_id)
     update keys k set status = 'available', order_id = null from o
     where k.id = o.key_id and k.status = 'reserved' and k.order_id = o.id`, [orderId, status]);
}

// Выдать ключи заказам, которые оплатили, когда ключей не было
async function settleWaiting(gameId) {
  for (const { id } of await q(`select id from orders where status = 'paid_no_key' and game_id = $1 order by paid_at`, [gameId])) {
    await fulfill(id);
  }
}

async function applyInvoice(orderId, inv) {
  if (inv?.status === 'paid') { await fulfill(orderId, inv); return true; }
  if (inv?.status === 'expired') { await expire(orderId); return true; }
  return false;
}

const lastCheck = new Map();
async function refresh(o, force = false) {
  if (o.status !== 'pending' || !o.invoice_id) return false;
  if (!force && now() - (lastCheck.get(o.id) || 0) < 4000) return false;
  lastCheck.set(o.id, now());
  try {
    const r = await cp.getInvoices({ invoice_ids: String(o.invoice_id) });
    return await applyInvoice(o.id, r.items?.[0]);
  } catch (e) {
    console.warn('[cryptopay]', e.message);
    return false;
  }
}

// Сверка всех неоплаченных счетов — на случай, если вебхук не настроен.
// Локально запускается по таймеру, на Vercel — попутно с запросами, не чаще раза в 30 секунд.
let lastSweep = 0;
async function sweep() {
  if (now() - lastSweep < 30e3) return;
  lastSweep = now();
  try {
    for (const { id } of await q(`select id from orders where status = 'pending' and invoice_id is null and expires_at < $1`, [now()])) await expire(id);
    const pending = await q(`select id, invoice_id from orders where status = 'pending' and invoice_id is not null order by created_at limit 300`);
    for (let i = 0; i < pending.length; i += 100) {
      const chunk = pending.slice(i, i + 100);
      const r = await cp.getInvoices({ invoice_ids: chunk.map((o) => o.invoice_id).join(','), count: 100 });
      for (const inv of r.items || []) {
        const o = chunk.find((x) => x.invoice_id === inv.invoice_id);
        if (o) await applyInvoice(o.id, inv);
      }
    }
  } catch (e) {
    console.warn('[sweep]', e.message);
  }
}

// ───────────────────────── приложение ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', cfg.trustProxy);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});

// Статика (на Vercel её отдаёт CDN из папки public, сюда запросы не доходят)
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// База данных подключается при первом запросе к API
app.use(['/api', '/uploads'], async (req, res, next) => {
  try {
    await db.ready();
    res.set('Cache-Control', 'no-store');
    next();
  } catch (e) {
    console.error('[db]', e.message);
    res.status(503).json({
      error: e.code === 'NO_DATABASE'
        ? 'База данных не подключена. В Vercel: Storage → Create Database → Neon → подключите к проекту и сделайте Redeploy.'
        : 'База данных недоступна, попробуйте через минуту.',
    });
  }
});

// Вебхук CryptoBot — нужен «сырой» body для проверки подписи, поэтому до express.json()
app.post('/api/cryptopay/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!cp.verifyWebhook(req.body, req.get('crypto-pay-api-signature'))) return res.status(401).json({ ok: false });
  let update;
  try { update = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ ok: false }); }
  if (update.update_type === 'invoice_paid') {
    const inv = update.payload || {};
    const [o] = await q(`select id from orders where invoice_id = $1 or id = $2 limit 1`, [inv.invoice_id ?? -1, String(inv.payload ?? '')]);
    if (o) await fulfill(o.id, inv);
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

app.get('/api/games', async (req, res) => {
  await sweep();
  const [rows, stats, [{ n: delivered }]] = await Promise.all([
    q(`select * from games where active order by featured desc, sort asc, created_at desc`),
    keyStats(),
    q(`select count(*)::int as n from orders where status = 'paid'`),
  ]);
  const games = rows.map((r) => publicGame(gameRow(r), stats.get(r.id)));
  res.json({ games, stats: { delivered, games: games.length, inStock: games.reduce((s, g) => s + g.stock, 0) } });
});

app.get('/api/feed', async (req, res) => {
  const items = await q(`select title, type, paid_at from orders where status = 'paid' order by paid_at desc limit 16`);
  res.json({ items: items.map((o) => ({ title: o.title, type: o.type, at: o.paid_at })) });
});

app.post('/api/orders', limit('order', 10, 10 * 60e3), async (req, res) => {
  const g = await getGame(String(req.body?.gameId ?? ''));
  if (!g || !g.active || g.mode !== 'sale') throw httpError(404, 'Игра не найдена');
  if (!(g.price > 0)) throw httpError(400, 'У игры не указана цена');

  const ip = ipHash(req);
  const [{ n }] = await q(`select count(*)::int as n from orders where ip_hash = $1 and status = 'pending' and expires_at > $2`, [ip, now()]);
  if (n >= 3) throw httpError(429, 'У вас уже есть 3 неоплаченных заказа. Оплатите или отмените их в «Моих ключах».');

  const o = {
    id: rid(6), token: rid(24), type: 'sale', status: 'pending', demo: g.demo,
    game_id: g.id, title: g.title, cover: g.cover, amount: g.price, fiat: cfg.fiat, ip_hash: ip,
    created_at: now(), expires_at: now() + cfg.ttlMin * 60e3,
  };
  const key = await tx(async (t) => {
    const k = await takeKey(t, g.id, 'reserved', o.id);
    if (k) await insertOrder(t, { ...o, key_id: k.id });
    return k;
  });
  if (!key) throw httpError(409, 'Ключи закончились — загляните чуть позже');

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
      await q(`update orders set invoice_id = $2, pay_url = $3, web_url = $4, expires_at = $5 where id = $1`, [
        o.id, inv.invoice_id, inv.bot_invoice_url || inv.pay_url, inv.web_app_invoice_url || null,
        inv.expiration_date ? Date.parse(inv.expiration_date) : o.expires_at,
      ]);
    } catch (e) {
      console.error('[cryptopay] createInvoice:', e.message);
      await q(`update orders set error = $2 where id = $1`, [o.id, e.message]);
      await expire(o.id, 'failed');
      throw httpError(502, 'Не удалось создать счёт в CryptoBot. Попробуйте ещё раз через минуту.');
    }
  }
  const saved = await loadOrder(o.id);
  res.json({ ...publicOrder(saved, { withToken: true }), qr: await qrFor(saved) });
});

async function qrFor(o) {
  if (o.status !== 'pending' || !o.pay_url) return null;
  return QRCode.toString(o.pay_url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0a0a0f', light: '#ffffff' } });
}

app.get('/api/orders/:id', limit('poll', 120, 60e3), async (req, res) => {
  let o = await findOrder(req);
  let changed = false;
  if (o.status === 'pending' && !o.invoice_id && now() > o.expires_at) { await expire(o.id); changed = true; }
  if (await refresh(o)) changed = true;
  if (changed) o = await loadOrder(o.id);
  res.json({ ...publicOrder(o), qr: await qrFor(o) });
});

app.post('/api/orders/:id/cancel', async (req, res) => {
  let o = await findOrder(req);
  if (o.status === 'pending' && o.invoice_id) {
    if (await refresh(o, true)) o = await loadOrder(o.id);
    if (o.status === 'pending') {
      try {
        await cp.deleteInvoice(o.invoice_id);
      } catch (e) {
        console.warn('[cryptopay] deleteInvoice:', e.message);
        throw httpError(502, 'Не получилось отменить счёт. Попробуйте ещё раз.');
      }
    }
  }
  if (o.status === 'pending') await expire(o.id, 'cancelled');
  res.json(publicOrder(await loadOrder(o.id)));
});

// Только для демо-товаров: имитация оплаты, чтобы посмотреть выдачу ключа
app.post('/api/orders/:id/demo-pay', async (req, res) => {
  const o = await findOrder(req);
  if (!o.demo) throw httpError(400, 'Это не демо-заказ');
  if (o.status === 'pending') await fulfill(o.id, { paid_asset: 'USDT', paid_amount: String(o.amount) });
  res.json(publicOrder(await loadOrder(o.id)));
});

app.post('/api/giveaway/:id/claim', limit('claim', 6, 60e3), async (req, res) => {
  const g = await getGame(String(req.params.id));
  if (!g || !g.active || g.mode !== 'giveaway') throw httpError(404, 'Раздача не найдена');
  const ip = ipHash(req);
  const o = {
    id: rid(6), token: rid(24), type: 'giveaway', status: 'paid', demo: g.demo,
    game_id: g.id, title: g.title, cover: g.cover, amount: 0, fiat: cfg.fiat, ip_hash: ip,
    created_at: now(), expires_at: now(), paid_at: now(),
  };
  await tx(async (t) => {
    // один посетитель — одна заявка за раз, даже если он жмёт кнопку в двух вкладках
    await t(`select 1 from (select pg_advisory_xact_lock(hashtext($1))) s`, [ip]);
    const mine = await t(`select game_id, created_at from orders where type = 'giveaway' and ip_hash = $1`, [ip]);
    if (mine.some((x) => x.game_id === g.id)) throw httpError(409, 'Вы уже забрали ключ из этой раздачи');
    const nextAt = Math.max(0, ...mine.map((x) => x.created_at)) + cfg.cooldownH * 3600e3;
    if (cfg.cooldownH > 0 && mine.length && nextAt > now()) {
      const h = Math.ceil((nextAt - now()) / 3600e3);
      throw Object.assign(httpError(429, `Следующий бесплатный ключ можно забрать через ${h} ч.`), { nextAt });
    }
    const key = await takeKey(t, g.id, 'claimed', o.id);
    if (!key) throw httpError(409, 'Раздача закончилась — ключи разобрали');
    await insertOrder(t, { ...o, key_id: key.id });
  });
  res.json(publicOrder(await loadOrder(o.id), { withToken: true }));
});

// Картинки, загруженные через админку
app.get('/uploads/:file', async (req, res) => {
  const [r] = await q(`select mime, data from uploads where id = $1`, [String(req.params.file).split('.')[0]]);
  if (!r) return res.status(404).end();
  res.set({ 'Content-Type': r.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(Buffer.from(r.data));
});

// ───────── админка ─────────
const COOKIE = 'kf_admin';
const SESSION_MS = 7 * 86400e3;
const sign = (exp) => crypto.createHmac('sha256', `${db.getSecret()}|${cfg.adminPassword}`).update(`admin:${exp}`).digest('base64url');

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
  if (!cfg.adminPassword) throw httpError(503, 'Задайте ADMIN_PASSWORD в настройках (.env или Environment Variables на хостинге)');
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
  await sweep();
  // начало суток в часовом поясе администратора (tz = getTimezoneOffset() из браузера)
  const tz = Math.max(-840, Math.min(840, num(req.query.tz, 0))) * 60e3;
  const day0 = Math.floor((now() - tz) / 86400e3) * 86400e3 + tz;
  const from = day0 - 13 * 86400e3;
  const [[sales], recent, [counts], keyRows, [{ d: hasDemo }], balance, me] = await Promise.all([
    q(`select count(*)::int as n, coalesce(sum(amount), 0) as s from orders where type = 'sale' and status = 'paid' and not demo`),
    q(`select paid_at, amount from orders where type = 'sale' and status = 'paid' and not demo and paid_at >= $1`, [from]),
    q(`select count(*) filter (where type = 'giveaway')::int as g, count(*) filter (where status = 'pending')::int as p,
              count(*) filter (where status = 'paid_no_key')::int as w from orders`),
    q(`select status, count(*)::int as n from keys group by 1`),
    q(`select exists(select 1 from games where demo) as d`),
    cp.getBalance().catch(() => null),
    cp.getMe().catch(() => null),
  ]);
  const series = Array.from({ length: 14 }, (_, i) => {
    const start = from + i * 86400e3;
    const list = recent.filter((o) => o.paid_at >= start && o.paid_at < start + 86400e3);
    return { date: start, count: list.length, revenue: list.reduce((s, o) => s + o.amount, 0) };
  });
  const keys = { ...EMPTY };
  for (const r of keyRows) { keys[r.status] = r.n; keys.total += r.n; }
  res.json({
    revenue: sales.s, sold: sales.n, giveaways: counts.g, pending: counts.p, waiting: counts.w,
    keys, series, hasDemo,
    balance: balance?.filter((b) => +b.available > 0 || +b.onhold > 0) ?? null,
    app: me ? { name: me.name, id: me.app_id } : null,
    cfg: {
      shopName: cfg.shopName, fiat: cfg.fiat, assets: cfg.assets, network: cfg.network, ttlMin: cfg.ttlMin,
      cooldownH: cfg.cooldownH, publicUrl: cfg.publicUrl, webhookUrl: `${cfg.publicUrl}/api/cryptopay/webhook`,
      isPublicHost, tokenSet: !!cfg.token, db: db.kind(),
    },
  });
});

function cleanGame(body) {
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const url = (v) => {
    const s = str(v, 1000);
    return /^(https?:\/\/|\/uploads\/)/.test(s) ? s : '';
  };
  const price = Math.round(num(body.price, 0) * 100) / 100;
  const oldPrice = Math.round(num(body.oldPrice, 0) * 100) / 100;
  const mode = body.mode === 'giveaway' ? 'giveaway' : 'sale';
  const g = {
    title: str(body.title, 120),
    appId: str(body.appId, 12).replace(/\D/g, ''),
    description: str(body.description, 2000),
    cover: url(body.cover),
    hero: url(body.hero),
    mode,
    price: mode === 'giveaway' ? 0 : Math.max(price, 0),
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
const gameParams = (g) => [g.title, g.appId, g.description, g.cover, g.hero, g.mode, g.price, g.oldPrice, JSON.stringify(g.genres), g.region, g.featured, g.active, g.sort];

const parseKeys = (text) => [...new Set(String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.length <= 200))];
async function addKeys(gameId, text) {
  const codes = parseKeys(text);
  if (!codes.length) return { added: 0, duplicates: 0 };
  const rows = await q(
    `insert into keys (id, game_id, code, status, created_at)
     select i, $1, c, 'available', $4 from unnest($2::text[], $3::text[]) as u(i, c)
     on conflict (code) do nothing returning id`,
    [gameId, codes.map(() => rid(8)), codes, now()],
  );
  await settleWaiting(gameId);
  return { added: rows.length, duplicates: codes.length - rows.length };
}

app.get('/api/admin/games', async (req, res) => {
  const [rows, stats] = await Promise.all([q(`select * from games order by created_at desc`), keyStats()]);
  res.json({
    games: rows.map((r) => {
      const g = gameRow(r), c = stats.get(g.id) || EMPTY;
      return { ...publicGame(g, c), active: g.active, sort: g.sort, keys: c };
    }),
  });
});

app.post('/api/admin/games', async (req, res) => {
  const g = { id: rid(6), createdAt: now(), ...cleanGame(req.body) };
  await q(
    `insert into games (title, app_id, description, cover, hero, mode, price, old_price, genres, region, featured, active, sort, id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)`,
    [...gameParams(g), g.id, g.createdAt],
  );
  const result = req.body.keys ? await addKeys(g.id, req.body.keys) : { added: 0, duplicates: 0 };
  res.json({ game: g, ...result });
});

app.put('/api/admin/games/:id', async (req, res) => {
  const g = cleanGame(req.body);
  const rows = await q(
    `update games set title = $1, app_id = $2, description = $3, cover = $4, hero = $5, mode = $6, price = $7, old_price = $8,
       genres = $9::jsonb, region = $10, featured = $11, active = $12, sort = $13 where id = $14 returning *`,
    [...gameParams(g), String(req.params.id)],
  );
  if (!rows.length) throw httpError(404, 'Игра не найдена');
  res.json({ game: gameRow(rows[0]) });
});

app.delete('/api/admin/games/:id', async (req, res) => {
  const id = String(req.params.id);
  await tx(async (t) => {
    if (!(await t(`select 1 from games where id = $1`, [id])).length) throw httpError(404, 'Игра не найдена');
    if ((await t(`select 1 from orders where game_id = $1 and status = 'pending' limit 1`, [id])).length) {
      throw httpError(409, 'По игре есть неоплаченные заказы — скройте её и удалите позже');
    }
    // проданные ключи остаются в истории заказов, свободные удаляются
    await t(`delete from keys where game_id = $1 and status not in ('sold', 'claimed')`, [id]);
    await t(`delete from games where id = $1`, [id]);
  });
  res.json({ ok: true });
});

app.get('/api/admin/games/:id/keys', async (req, res) => {
  const rows = await q(`select id, code, status, order_id, created_at, sold_at from keys where game_id = $1 order by created_at desc, id`, [String(req.params.id)]);
  res.json({ keys: rows.map((k) => ({ id: k.id, code: k.code, status: k.status, orderId: k.order_id, createdAt: k.created_at, soldAt: k.sold_at })) });
});

app.post('/api/admin/games/:id/keys', async (req, res) => {
  const id = String(req.params.id);
  if (!(await getGame(id))) throw httpError(404, 'Игра не найдена');
  res.json(await addKeys(id, req.body?.text));
});

app.delete('/api/admin/keys/:id', async (req, res) => {
  const id = String(req.params.id);
  const del = await q(`delete from keys where id = $1 and status = 'available' returning id`, [id]);
  if (!del.length) {
    const exists = (await q(`select 1 from keys where id = $1`, [id])).length;
    throw httpError(exists ? 409 : 404, exists ? 'Удалить можно только свободный ключ' : 'Ключ не найден');
  }
  res.json({ ok: true });
});

app.get('/api/admin/orders', async (req, res) => {
  const rows = await q(
    `select o.*, k.code as key_code from orders o
     left join keys k on k.id = o.key_id and k.status in ('sold', 'claimed')
     order by o.created_at desc limit 500`);
  res.json({ orders: rows.map((o) => ({ ...publicOrder(o), key: o.key_code || null, invoiceId: o.invoice_id || null, error: o.error || null })) });
});

app.post('/api/admin/orders/:id/check', async (req, res) => {
  const o = await loadOrder(String(req.params.id));
  if (!o) throw httpError(404, 'Заказ не найден');
  await refresh(o, true);
  res.json(publicOrder(await loadOrder(o.id)));
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

app.post('/api/admin/upload', express.raw({ type: 'image/*', limit: '4mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'Пустой файл');
  const sig = buf.subarray(0, 12);
  const type =
    sig[0] === 0x89 && sig.toString('latin1', 1, 4) === 'PNG' ? ['png', 'image/png']
    : sig[0] === 0xff && sig[1] === 0xd8 ? ['jpg', 'image/jpeg']
    : sig.toString('latin1', 0, 4) === 'GIF8' ? ['gif', 'image/gif']
    : sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP' ? ['webp', 'image/webp']
    : null;
  if (!type) throw httpError(400, 'Поддерживаются PNG, JPG, WEBP и GIF');
  const id = rid(10);
  await q(`insert into uploads (id, mime, data, created_at) values ($1, $2, $3, $4)`, [id, type[1], buf, now()]);
  res.json({ url: `/uploads/${id}.${type[0]}` });
});

app.post('/api/admin/demo/seed', async (req, res) => {
  const report = await seedDemo(tx);
  res.json({ added: report.length });
});

app.post('/api/admin/demo/clear', async (req, res) => {
  res.json({ removed: await clearDemo(tx) });
});

// ───────── страницы и ошибки ─────────
// На Vercel «/» и «/admin» переписываются на статические файлы (vercel.json); это запасной путь
app.get(['/', '/admin'], (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, `${req.path === '/admin' ? '/admin.html' : '/index.html'}${query}`);
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.expose) console.error(err);
  res.status(status).json({ error: err.expose ? err.message : 'Ошибка сервера', ...(err.nextAt && { nextAt: err.nextAt }) });
});

export default app;

if (!ON_VERCEL) {
  app.listen(cfg.port, async () => {
    console.log(`\n  ${cfg.shopName} запущен →  http://localhost:${cfg.port}`);
    console.log(`  Админка          →  http://localhost:${cfg.port}/admin`);
    console.log(`  CryptoBot        →  ${cfg.network}${cfg.token ? '' : '  (!) CRYPTO_PAY_TOKEN не задан'}`);
    if (!cfg.adminPassword) console.log('  (!) ADMIN_PASSWORD не задан — админка отключена');
    try {
      await db.ready();
      console.log(`  База данных      →  ${db.kind() === 'postgres' ? 'Postgres (DATABASE_URL)' : 'встроенная, папка data/pg'}\n`);
      sweep();
      setInterval(sweep, 30e3).unref();
    } catch (e) {
      console.error('  (!) База данных недоступна:', e.message);
    }
  });
}
