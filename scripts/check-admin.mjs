// One-off diagnostic: inspect the production DB for the admin account.
// Usage: node ./scripts/check-admin.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';

let env = '';
try { env = readFileSync('.env', 'utf8'); } catch { /* .env is optional here */ }
const db = (env.match(/^DATABASE_URL=(.*)$/m) || [])[1];
if (!db || !db.trim()) {
  console.log('DATABASE_URL not found in .env — add it (see .env.example) before running this check.');
  process.exit(1);
}
// Some pg versions reject the `channel_binding` URL parameter; strip it (and
// tidy up the leftover '?'/'&') before handing the string to the driver.
const clean = db.trim().replace(/([?&])channel_binding=[^&]*/g, '$1').replace(/[?&]$/, '');
const c = new pg.Client({ connectionString: clean, ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  console.log('AUTH OK');
  const kv = await c.query('select count(*)::int as n from public.kv_store');
  console.log('KV_ROWS:', kv.rows[0].n);
  const accts = await c.query("select key from public.kv_store where key like 'acct:%' limit 10");
  console.log('ACCT_KEYS:', JSON.stringify(accts.rows));
  const admin = await c.query("select value->>'email' as email, value->>'role' as role, value->>'plan' as plan from public.kv_store where key = 'acct:admin@coachos-prod.local'");
  console.log('KV_ADMIN:', JSON.stringify(admin.rows));
  const tables = await c.query("select table_name from information_schema.tables where table_schema='public' order by 1");
  console.log('TABLES:', JSON.stringify(tables.rows.map(r => r.table_name)));
} catch (e) {
  console.log('DB_ERROR:', e.code || '', e.message);
} finally {
  await c.end().catch(() => {});
}
