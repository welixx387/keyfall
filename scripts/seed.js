// Демо-витрина: игры с картинками из Steam и ненастоящими DEMO-ключами.
// То же самое делает кнопка в админке: Настройки → Загрузить демо-витрину.
//   npm run seed            — локальная база (data/pg) или DATABASE_URL из .env
import path from 'node:path';
try { process.loadEnvFile(path.join(import.meta.dirname, '..', '.env')); } catch {}
const db = await import('../lib/db.js');
const { seedDemo } = await import('../lib/demo.js');

await db.ready();
const report = await seedDemo(db.tx);
for (const r of report) console.log(`  + ${String(r.title).padEnd(44)} ${r.mode === 'sale' ? 'продажа' : 'раздача'} · ${r.keys} ключей`);
console.log(`\nГотово: ${report.length} демо-игр. Запускайте: npm start`);
process.exit(0);
