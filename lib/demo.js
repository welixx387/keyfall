// Демо-витрина: игры с картинками из Steam и ненастоящими DEMO-ключами.
// Демо-товары «оплачиваются» кнопкой «Симулировать оплату» — без CryptoBot.
import crypto from 'node:crypto';

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

const rid = (n) => crypto.randomBytes(n).toString('base64url');
const chunk = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function steam(appId) {
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=russian&cc=us`, { signal: AbortSignal.timeout(12000) });
    const d = (await r.json())[appId];
    if (d?.success) return d.data;
  } catch { /* без интернета возьмём стандартные картинки */ }
  return null;
}

export async function clearDemo(tx) {
  return tx(async (t) => {
    const ids = (await t(`select id from games where demo`)).map((r) => r.id);
    await t(`delete from orders where demo or game_id = any($1::text[])`, [ids]);
    await t(`delete from keys where game_id = any($1::text[])`, [ids]);
    await t(`delete from games where demo`);
    return ids.length;
  });
}

export async function seedDemo(tx) {
  await clearDemo(tx);
  const details = await Promise.all(DEMO.map((d) => steam(d.appId)));
  const base = Date.now();
  const report = [];
  await tx(async (t) => {
    for (const [i, item] of DEMO.entries()) {
      const x = details[i];
      const cdn = `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appId}/header.jpg`;
      const id = rid(6);
      const mode = item.mode || 'sale';
      await t(
        `insert into games (id, title, app_id, description, cover, hero, mode, price, old_price, genres, region, featured, active, sort, demo, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'Весь мир', $11, true, $12, true, $13)`,
        [id, x?.name || `Steam App ${item.appId}`, String(item.appId), decode(x?.short_description || ''),
          x?.header_image || cdn, x?.background_raw || x?.header_image || cdn, mode, item.price || 0, item.oldPrice || null,
          JSON.stringify((x?.genres || []).map((g) => g.description).slice(0, 3)), !!item.featured, i, base - i * 1000],
      );
      const n = mode === 'giveaway' ? 4 + crypto.randomInt(6) : 2 + crypto.randomInt(11);
      const codes = Array.from({ length: n }, () => `DEMO-${chunk()}-${chunk()}`);
      await t(
        `insert into keys (id, game_id, code, status, created_at)
         select i, $1, c, 'available', $4 from unnest($2::text[], $3::text[]) as u(i, c) on conflict (code) do nothing`,
        [id, codes.map(() => rid(8)), codes, base],
      );
      report.push({ title: x?.name || item.appId, mode, keys: n });
    }
  });
  return report;
}
