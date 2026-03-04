import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

function buildConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || '';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const db = process.env.POSTGRES_DB || 'telemarketing_analytics';
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

const connectionString = buildConnectionString();
const pool = new pg.Pool({ connectionString });

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
