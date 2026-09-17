// Coach OS — portable KV backend (PostgreSQL edition, Supabase-free).
// Same get/setJSON/delete surface the Phase-1 code already uses, but the
// bytes can live in EITHER your own PostgreSQL (kv_store table), a plain
// JSON file (self-hosted standalone server), or Netlify Blobs.
//
// Backend selection (env):
//   DATABASE_URL present -> PostgreSQL via the `pg` driver (primary;
//                           multi-instance safe, direct connection — no
//                           Supabase, no PostgREST, no service keys).
//   KV_FILE present      -> JSON file on disk.
//   Otherwise            -> Netlify Blobs.
//
// Schema lives in db/schema.sql (kv_store + normalized mirror tables).
// `pg` is lazy-imported so file/blobs environments (and contract tests)
// never need the package at import time.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let _blobsMod = null;
async function blobs(ns) {
  if (!_blobsMod) _blobsMod = await import('@netlify/blobs');
  return _blobsMod.getStore({ name: ns, consistency: 'strong' });
}

const DATABASE_URL = (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGURL || '').trim();
const KV_FILE = (process.env.KV_FILE || '').trim();

export const BACKEND = DATABASE_URL ? 'postgres' : KV_FILE ? 'file' : 'blobs';
export const isPostgres = () => BACKEND === 'postgres';
const isFile = () => BACKEND === 'file';

/* ---------- Postgres primitives (table: public.kv_store) ---------- */
let _pool = null;
async function pool() {
  if (!_pool) {
    const pg = await import('pg');
    // Managed Postgres (Neon/Render/RDS/…) usually requires TLS; localhost
    // does not. An explicit sslmode= in the URL always wins.
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
    // Serverless (Netlify Functions/Lambda): every container gets its own
    // pool, so max must stay at 1 or concurrent containers exhaust the
    // database connection limit. Use the provider's POOLED connection
    // string (pgBouncer/Supavisor/Neon pooler) in that environment.
    const serverless = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
    _pool = new pg.default.Pool({
      connectionString: DATABASE_URL,
      max: serverless ? 1 : 5,
      idleTimeoutMillis: serverless ? 10000 : 30000,
      allowExitOnIdle: serverless,
      connectionTimeoutMillis: 10000,
      ssl: local || /sslmode=/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
    });
    _pool.on('error', (e) => console.error('[kv] pg pool error:', e.message));
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

/* ---------- File primitives (self-hosted single-instance server) ----------
   One JSON document holds every namespaced key: { "<ns>:<key>": value }.
   Writes are atomic (tmp file + rename). Perfect for one Node process on a
   VPS/Docker; for multi-instance deployments use PostgreSQL instead. */
let _fileCache = null;
function fileData() {
  if (_fileCache) return _fileCache;
  try { _fileCache = JSON.parse(readFileSync(KV_FILE, 'utf8')); } catch { _fileCache = {}; }
  if (!_fileCache || typeof _fileCache !== 'object') _fileCache = {};
  return _fileCache;
}
function fileFlush() {
  try { mkdirSync(dirname(KV_FILE), { recursive: true }); } catch {}
  const tmp = `${KV_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(_fileCache));
  renameSync(tmp, KV_FILE);
}
async function fileGet(fullKey) {
  const d = fileData();
  return Object.prototype.hasOwnProperty.call(d, fullKey) ? d[fullKey] : null;
}
async function fileSet(fullKey, value) {
  fileData()[fullKey] = value;
  fileFlush();
}
async function fileDel(fullKey) {
  const d = fileData();
  if (Object.prototype.hasOwnProperty.call(d, fullKey)) { delete d[fullKey]; fileFlush(); }
}

/* ---------- Blobs primitives (fallback backend, lazy) ---------- */

/**
 * Namespaced KV store with the exact surface Phase-1 expects:
 *   get(key, {type:'json'}), setJSON(key, val), delete(key)
 * Postgres keys are namespaced as "<ns>:<key>" inside ONE table (kv_store).
 */
export function kv(ns) {
  const prefix = `${ns}:`;
  return {
    async get(key, opts) {
      if (isFile()) return fileGet(prefix + key);
      if (isPostgres()) {
        try {
          const v = await pgGet(prefix + key);
          if (v !== null && v !== undefined) return v;
          return null;
        } catch (e) {
          console.error('[kv] postgres read failed, trying blobs fallback:', e.message);
        }
        // Fallback: old bytes may still live in Blobs.
        try {
          return await (await blobs(ns)).get(key, opts);
        } catch {
          return null;
        }
      }
      try {
        return await (await blobs(ns)).get(key, opts);
      } catch {
        return null;
      }
    },
    async setJSON(key, val) {
      if (isFile()) return fileSet(prefix + key, val);
      if (isPostgres()) {
        await pgSet(prefix + key, val);
        return;
      }
      await (await blobs(ns)).setJSON(key, val);
    },
    async delete(key) {
      if (isFile()) return fileDel(prefix + key);
      if (isPostgres()) {
        try { await pgDel(prefix + key); } catch {}
        return;
      }
      try { await (await blobs(ns)).delete(key); } catch {}
    }
  };
}

/**
 * Health info for the public /api/health endpoint.
 * IMPORTANT: this endpoint is unauthenticated, so it must not hand out
 * internal infrastructure details. The database host used to be returned
 * unconditionally (e.g. `ep-xxx-pooler.c-7.us-east-2.aws.neon.tech`), which
 * tells an attacker exactly which cloud/region/DB is behind the app. It is
 * now only reported outside production.
 */
export function dbInfo() {
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  let host = null;
  if (DATABASE_URL && !isProd) {
    try { host = new URL(DATABASE_URL).host; } catch { host = '?'; }
  }
  return {
    backend: BACKEND,
    postgresConfigured: !!DATABASE_URL,
    // null in production (see above); callers should treat it as optional.
    postgresHost: host,
    fileConfigured: !!KV_FILE
  };
}
