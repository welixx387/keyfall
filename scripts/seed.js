// Демо-витрина: игры с картинками из Steam и ненастоящими DEMO-ключами.
// Демо-товары оплачиваются кнопкой «Симулировать оплату» — без CryptoBot.
// Удалить их можно одной кнопкой в админке (Настройки → Удалить демо-данные).
// Запускать при остановленном сервере:  npm run seed
import crypto from 'node:crypto';
import * as store from '../lib/store.js';

const DEMO = [
  { appId: 1091500, price: 24.99, oldPrice: 59.99, featured: true },
  { appId: 1245620, price: 34.99, oldPrice: 59.99, featured: true },
  { appId: 1086940, price: 44.99 },
  { appId: 1145350, price: 21.49, oldPrice: 29.99 },
  { appId: 1174180, price: 17.99, oldPrice: 59.99 },
  { appId: 2379780, price: 9.99, oldPrice: 14.99 },
  { appId: 814380, price: 27.99, oldPrice: 59.99 },
  { appId: 632470, price: 8.99, oldPrice: 39.99 },
  { appId: 1426210, price: 14.99, oldPrice: 39.99 },
  { appId: 367520, price: 6.49, oldPrice: 14.99 },
  { appId: 413150, mode: 'giveaway' },
  { appId: 504230, mode: 'giveaway' },
  { appId: 620, mode: 'giveaway' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n) => crypto.randomBytes(n).toString('base64url');
const chunk = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');
const demoKey = () => `DEMO-${chunk()}-${chunk()}`;
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function steam(appId) {
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=russian&cc=us`, { signal: AbortSignal.timeout(12000) });
    const d = (await r.json())[appId];
    if (d?.success) return d.data;
  } catch {}
  return null;
}

const db = store.load();
if (db.games.some((g) => g.demo) && !process.argv.includes('--force')) {
  console.log('Демо-данные уже есть. Чтобы пересоздать: npm run seed -- --force');
  process.exit(0);
}
const old = new Set(db.games.filter((g) => g.demo).map((g) => g.id));
db.games = db.games.filter((g) => !g.demo);
db.keys = db.keys.filter((k) => !old.has(k.gameId));
db.orders = db.orders.filter((o) => !o.demo);

let i = 0;
for (const item of DEMO) {
  const x = await steam(item.appId);
  const cdn = `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appId}`;
  const g = {
    id: rid(6),
    createdAt: Date.now() - i * 1000,
    title: x?.name || `Steam App ${item.appId}`,
    appId: String(item.appId),
    description: decode(x?.short_description || ''),
    cover: x?.header_image || `${cdn}/header.jpg`,
    hero: x?.background_raw || x?.header_image || `${cdn}/header.jpg`,
    mode: item.mode || 'sale',
    price: item.price || 0,
    oldPrice: item.oldPrice || null,
    genres: (x?.genres || []).map((g) => g.description).slice(0, 3),
    region: 'Весь мир',
    featured: !!item.featured,
    active: true,
    sort: i,
    demo: true,
  };
  db.games.push(g);
  const n = g.mode === 'giveaway' ? 4 + crypto.randomInt(6) : 2 + crypto.randomInt(11);
  for (let k = 0; k < n; k++) {
    db.keys.push({ id: rid(8), gameId: g.id, code: demoKey(), status: 'available', orderId: null, createdAt: Date.now() });
  }
  console.log(`  + ${g.title.padEnd(36)} ${g.mode === 'sale' ? '$' + g.price : 'раздача'}  · ${n} ключей`);
  i++;
  await sleep(350);
}
store.save();
console.log(`\nГотово: ${DEMO.length} демо-игр. Запускайте: npm start`);
