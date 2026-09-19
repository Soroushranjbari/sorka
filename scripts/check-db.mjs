// One-off: validate the .env DATABASE_URL against Neon (never prints secrets).
import { readFileSync } from 'node:fs';
import pg from 'pg';

let env = '';
try { env = readFileSync('.env', 'utf8'); } catch { /* .env is optional here */ }
const db = (env.match(/^DATABASE_URL=(.*)$/m) || [])[1]?.trim();
if (!db) { console.log('DATABASE_URL missing in .env — add it (see .env.example) before running this check.'); process.exit(1); }

const c = new pg.Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  console.log('CONNECTED ✓');
  const t = await c.query("select table_name from information_schema.tables where table_schema='public' order by 1");
  console.log('tables:', t.rows.map(x => x.table_name).join(', ') || '(none — schema not applied yet)');
  if (t.rows.some(x => x.table_name === 'kv_store')) {
    const n = await c.query('select count(*)::int as n from public.kv_store');
    console.log('kv_store rows:', n.rows[0].n);
  }
  await c.end();
} catch (e) {
  console.log('CONNECTION FAILED:', e.message);
  process.exit(1);
}
