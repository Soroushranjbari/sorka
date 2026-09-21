// CoachMint — one-time migration: import a KV JSON dump (the old file backend)
// into the SQLite database. Run ONCE after switching to SQLite:
//
//   npm run db:migrate                     # ./data/kv.json -> ./data/sqlite.db
//   node scripts/migrate-kv-to-sqlite.mjs path/to/kv.json path/to/db.sqlite
//
// Keys that already exist in the SQLite db are SKIPPED (never clobbered), so
// the migration is safe to re-run and never overwrites newer live data.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3').default || require('better-sqlite3');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argIn = process.argv[2] || join(ROOT, 'data', 'kv.json');
const argDb = process.argv[3] || process.env.SQLITE_PATH || join(ROOT, 'data', 'sqlite.db');

const src = resolve(argIn);
const dst = resolve(argDb);
if (!existsSync(src)) {
  console.error(`Source KV file not found: ${src}`);
  process.exit(1);
}

let data;
try { data = JSON.parse(readFileSync(src, 'utf8')); }
catch (e) { console.error(`Cannot parse ${src}: ${e.message}`); process.exit(1); }
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  console.error(`${src} is not a KV dump (expected a flat object of key -> value).`);
  process.exit(1);
}

import { mkdirSync } from 'node:fs';
try { mkdirSync(dirname(dst), { recursive: true }); } catch {}
const db = new Database(dst);
try { db.pragma('journal_mode = WAL'); } catch {}
db.exec(`
  create table if not exists kv (
    key        text primary key,
    value      text not null,
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

const insert = db.prepare(
  `insert into kv (key, value) values (?, ?)
   on conflict (key) do nothing`
);
const existing = db.prepare('select count(*) as n from kv').get().n;

const tx = db.transaction((entries) => {
  let written = 0, skipped = 0;
  for (const [key, value] of entries) {
    const r = insert.run(key, JSON.stringify(value ?? null));
    r.changes > 0 ? written++ : skipped++;
  }
  return { written, skipped };
});

const entries = Object.entries(data);
const { written, skipped } = tx(entries);
const total = db.prepare('select count(*) as n from kv').get().n;

console.log(`Migrated ${src}`);
console.log(`  -> ${dst}`);
console.log(`  keys in dump: ${entries.length} · written: ${written} · already present (skipped): ${skipped}`);
console.log(`  db now holds ${total} keys (had ${existing} before)`);
db.close();
