// CoachMint — portable KV backend (SQLite edition).
// Same get/setJSON/delete surface the Phase-1 code already uses, but the
// bytes can live in EITHER a single SQLite database file (default — zero
// cloud services, one `data/sqlite.db` file) or your own PostgreSQL
// (kv_store table) when you explicitly set DATABASE_URL.
//
// Backend selection (env):
//   (default)            -> SQLite via better-sqlite3. Path:
//                           SQLITE_PATH, or /tmp/coach-os.sqlite.db on
//                           Vercel (the deploy dir is read-only there),
//                           or ./data/sqlite.db everywhere else.
//   DATABASE_URL present -> PostgreSQL via the `pg` driver (opt-in for
//                           multi-instance/serverless deployments; the
//                           kv_store table is auto-created on first use).
//
// `better-sqlite3` and `pg` are lazy-imported so the module can be loaded
// (and syntax-checked) without either package present.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const DATABASE_URL = (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGURL || '').trim();

export const SQLITE_PATH = (process.env.SQLITE_PATH || '').trim()
  || (process.env.VERCEL ? '/tmp/coach-os.sqlite.db' : './data/sqlite.db');

export const BACKEND = DATABASE_URL ? 'postgres' : 'sqlite';
export const isPostgres = () => BACKEND === 'postgres';
const isSqlite = () => BACKEND === 'sqlite';

/* ---------- SQLite primitives (table: kv) ---------- */
const _require = createRequire(import.meta.url);
let _db = null;
function db() {
  if (_db) return _db;
  let Database;
  try {
    const mod = _require('better-sqlite3'); // CJS package — resolve via createRequire
    Database = mod.default || mod;
  } catch {
    throw new Error('better-sqlite3 is not installed — run: npm install');
  }
  try { mkdirSync(dirname(SQLITE_PATH), { recursive: true }); } catch {}
  const d = new Database(SQLITE_PATH);
  // WAL = safe concurrent readers + one writer, and committed transactions
  // survive a crash. Some network/OneDrive filesystems refuse WAL — fall
  // back to the default journal silently in that case.
  try { d.pragma('journal_mode = WAL'); } catch {}
  d.pragma('synchronous = NORMAL');
  d.exec(`
    create table if not exists kv (
      key        text primary key,
      value      text not null,
      updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  _db = d;
  return d;
}

function sqlGet(fullKey) {
  const row = db().prepare('select value from kv where key = ? limit 1').get(fullKey);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function sqlSet(fullKey, value) {
  db().prepare(
    `insert into kv (key, value) values (?, ?)
     on conflict (key) do update set value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(fullKey, JSON.stringify(value ?? null));
}
function sqlDel(fullKey) {
  db().prepare('delete from kv where key = ?').run(fullKey);
}

/** Close the SQLite handle (tests / graceful shutdown). No-op elsewhere. */
export function closeAll() {
  try { _db?.close(); } catch {}
  _db = null;
}

/* ---------- Postgres primitives (table: public.kv_store) ---------- */
let _pool = null;
async function pool() {
  if (!_pool) {
    const pg = await import('pg');
    // Managed Postgres (Neon/Render/RDS/…) usually requires TLS; localhost
    // does not. An explicit sslmode= in the URL always wins.
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
    // Serverless (Vercel/Lambda): every container gets its own pool, so max
    // must stay at 1 or concurrent containers exhaust the connection limit.
    // Use the provider's POOLED connection string in that environment.
    const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    _pool = new pg.default.Pool({
      connectionString: DATABASE_URL,
      max: serverless ? 1 : 5,
      idleTimeoutMillis: serverless ? 10000 : 30000,
      allowExitOnIdle: serverless,
      connectionTimeoutMillis: 10000,
      ssl: local || /sslmode=/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
    });
    _pool.on('error', (e) => console.error('[kv] pg pool error:', e.message));
    // Self-healing schema: no external SQL file needed anymore.
    await _pool.query(`
      create table if not exists public.kv_store (
        key        text primary key,
        value      jsonb not null,
        updated_at timestamptz not null default now()
      );
    `);
  }
  return _pool;
}

async function pgGet(fullKey) {
  const r = await (await pool()).query(
    'select value from public.kv_store where key = $1 limit 1',
    [fullKey]
  );
  return r.rows.length ? r.rows[0].value : null; // jsonb comes back pre-parsed
}

async function pgSet(fullKey, value) {
  await (await pool()).query(
    `insert into public.kv_store (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [fullKey, JSON.stringify(value ?? null)]
  );
}

async function pgDel(fullKey) {
  await (await pool()).query('delete from public.kv_store where key = $1', [fullKey]);
}

/**
 * Namespaced KV store with the exact surface Phase-1 expects:
 *   get(key, {type:'json'}), setJSON(key, val), delete(key)
 * Keys are namespaced as "<ns>:<key>" inside ONE table (kv / kv_store).
 */
export function kv(ns) {
  const prefix = `${ns}:`;
  return {
    async get(key /* , opts */) {
      if (isSqlite()) return sqlGet(prefix + key);
      try {
        return await pgGet(prefix + key);
      } catch (e) {
        console.error('[kv] postgres read failed:', e.message);
        return null;
      }
    },
    async setJSON(key, val) {
      if (isSqlite()) return sqlSet(prefix + key, val);
      await pgSet(prefix + key, val);
    },
    async delete(key) {
      if (isSqlite()) return sqlDel(prefix + key);
      try { await pgDel(prefix + key); } catch {}
    }
  };
}

/**
 * Health info for the public /api/health endpoint.
 * IMPORTANT: this endpoint is unauthenticated, so it must not hand out
 * internal infrastructure details. The database host / file path are only
 * reported outside production.
 */
export function dbInfo() {
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  let host = null;
  if (DATABASE_URL && !isProd) {
    try { host = new URL(DATABASE_URL).host; } catch { host = '?'; }
  }
  return {
    backend: BACKEND,
    sqliteConfigured: true,
    // null in production (see above); callers should treat it as optional.
    sqlitePath: isProd ? null : SQLITE_PATH,
    postgresConfigured: !!DATABASE_URL,
    postgresHost: host
  };
}
