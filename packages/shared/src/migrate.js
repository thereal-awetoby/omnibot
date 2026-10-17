import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { getPool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const pool = getPool();
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  await pool.query(readFileSync(join(dir, f), 'utf8'));
  console.log('applied', f);
}
await pool.end();
