// Простое хранилище в JSON-файле. Все изменения делаются синхронно,
// поэтому в однопоточном Node.js два запроса не могут забрать один ключ.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

let state = null;

function fresh() {
  return {
    meta: { secret: crypto.randomBytes(32).toString('hex'), createdAt: Date.now() },
    games: [],
    keys: [],
    orders: [],
  };
}

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // резервная копия при каждом запуске
    fs.copyFileSync(FILE, FILE + '.bak');
  } else {
    state = fresh();
    save();
  }
  state.games ??= [];
  state.keys ??= [];
  state.orders ??= [];
  return state;
}

export function save() {
  const json = JSON.stringify(state, null, 1);
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, FILE);
  } catch {
    // на Windows антивирус иногда держит файл — пишем напрямую
    fs.writeFileSync(FILE, json);
  }
}

export const db = () => state;
export const file = FILE;
