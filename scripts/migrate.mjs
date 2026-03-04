import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
// Только файлы в корне migrations/ (001, 002, 003) — дополнения к уже существующей базе. Не трогаем standalone/.
const files = fs.readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const f of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
  try {
    await pool.query(sql);
    console.log('OK', f);
  } catch (e) {
    console.error('FAIL', f, e.message);
    await pool.end();
    process.exit(1);
  }
}
await pool.end();
console.log('Migrations done.');
