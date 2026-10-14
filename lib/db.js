// База данных: Postgres, если задан DATABASE_URL (Vercel + Neon, VPS),
// иначе встроенный Postgres (PGlite) в папке data/pg — для запуска на своём компьютере.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA = `
create table if not exists meta (k text primary key, v text not null);

create table if not exists games (
  id text primary key,
  title text not null,
  app_id text not null default '',
  description text not null default '',
  cover text not null default '',
  hero text not null default '',
  mode text not null default 'sale',
  price double precision not null default 0,
  old_price double precision,
  genres jsonb not null default '[]'::jsonb,
  region text not null default 'Весь мир',
  featured boolean not null default false,
  active boolean not null default true,
  sort double precision not null default 0,
  demo boolean not null default false,
  created_at double precision not null
);

create table if not exists keys (
  id text primary key,
  game_id text not null,
  code text not null unique,
  status text not null default 'available',
  order_id text,
  created_at double precision not null,
  sold_at double precision
);
create index if not exists keys_game_status_idx on keys (game_id, status, created_at);

create table if not exists orders (
  id text primary key,
  token text not null,
  type text not null,
  status text not null,
  demo boolean not null default false,
  game_id text,
  title text not null default '',
  cover text not null default '',
  key_id text,
  amount double precision not null default 0,
  fiat text not null default 'USD',
  ip_hash text not null default '',
  invoice_id double precision,
  pay_url text,
  web_url text,
  error text,
  paid_asset text,
  paid_amount text,
  created_at double precision not null,
  expires_at double precision not null,
  paid_at double precision
);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_ip_idx on orders (ip_hash, type);

create table if not exists uploads (
  id text primary key,
  mime text not null,
  data bytea not null,
  created_at double precision not null
);
`;

export const databaseUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

async function connect() {
  const url = databaseUrl();
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    pool.on('error', (e) => console.error('[db]', e.message));
    const rows = (client) => async (text, params = []) => (await client.query(text, params)).rows;
    return {
      kind: 'postgres',
      exec: (sql) => pool.query(sql),
      q: rows(pool),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const result = await fn(rows(client));
          await client.query('commit');
          return result;
        } catch (e) {
          await client.query('rollback').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
    };
  }
  if (process.env.VERCEL) {
    throw Object.assign(new Error('NO_DATABASE'), { code: 'NO_DATABASE' });
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.join(import.meta.dirname, '..', 'data', 'pg');
  fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  const rows = (client) => async (text, params = []) => (await client.query(text, params)).rows;
  return {
    kind: 'pglite',
    exec: (sql) => db.exec(sql),
    q: rows(db),
    tx: (fn) => db.transaction((t) => fn(rows(t))),
  };
}

let impl = null;
let secret = '';
let readyPromise = null;

// Подключение и миграция выполняются один раз на экземпляр сервера
export function ready() {
  readyPromise ??= (async () => {
    const i = await connect();
    await i.exec(SCHEMA);
    await i.q(`insert into meta (k, v) values ('secret', $1) on conflict (k) do nothing`, [crypto.randomBytes(32).toString('hex')]);
    secret = (await i.q(`select v from meta where k = 'secret'`))[0].v;
    impl = i;
    return i;
  })().catch((e) => {
    readyPromise = null;
    throw e;
  });
  return readyPromise;
}

export const q = (text, params) => impl.q(text, params);
export const tx = (fn) => impl.tx(fn);
export const getSecret = () => secret;
export const kind = () => impl?.kind || null;
