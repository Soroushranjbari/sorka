// Coach OS — portable KV backend (Phase 1.5).
// Same get/setJSON/delete surface the Phase-1 code already uses, but the
// bytes can now live in EITHER Netlify Blobs OR Supabase Postgres (kv_store).
//
// Backend selection (env):
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY present -> Supabase (primary).
//   Otherwise                                        -> Netlify Blobs.
//
// During migration BOTH are read (Supabase first, Blobs as fallback) and all
// writes go to Supabase, so no data is lost when you flip the switch.
// After migration is verified, Blobs becomes a dead fallback you can delete.
//
// Zero extra dependencies: Supabase is reached via its PostgREST HTTP API
// with the global fetch (Node 18+). Blobs is lazy-imported so Supabase-only
// environments (and contract tests) never need the package at import time.
let _blobsMod = null;
async function blobs(ns) {
  if (!_blobsMod) _blobsMod = await import('@netlify/blobs');
  return _blobsMod.getStore({ name: ns, consistency: 'strong' });
}

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const BACKEND = SUPA_URL && SUPA_KEY ? 'supabase' : 'blobs';
export const isSupabase = () => BACKEND === 'supabase';

const supaHeaders = () => ({
  apikey: SUPA_KEY,
  authorization: `Bearer ${SUPA_KEY}`,
  'content-type': 'application/json'
});

/* ---------- Supabase primitives (table: public.kv_store) ---------- */
async function supaGet(fullKey) {
  const r = await fetch(
    `${SUPA_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(fullKey)}&select=value`,
    { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!r.ok) throw new Error(`supabase-get ${r.status}`);
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  return rows[0].value ?? null;
}

async function supaSet(fullKey, value) {
  const r = await fetch(`${SUPA_URL}/rest/v1/kv_store?on_conflict=key`, {
    method: 'POST',
    headers: { ...supaHeaders(), prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: fullKey, value })
  });
  if (!r.ok) throw new Error(`supabase-set ${r.status}: ${await r.text().catch(() => '')}`);
}

async function supaDel(fullKey) {
  await fetch(`${SUPA_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(fullKey)}`, {
    method: 'DELETE',
    headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` }
  });
}

/* ---------- Blobs primitives (pre-migration backend, lazy) ---------- */

/**
 * Namespaced KV store with the exact surface Phase-1 expects:
 *   get(key, {type:'json'}), setJSON(key, val), delete(key)
 * Supabase keys are namespaced as "<ns>:<key>" inside ONE table.
 */
export function kv(ns) {
  const prefix = `${ns}:`;
  return {
    async get(key, opts) {
      if (isSupabase()) {
        try {
          const v = await supaGet(prefix + key);
          if (v !== null && v !== undefined) return v;
        } catch (e) {
          console.error('[kv] supabase read failed, trying blobs fallback:', e.message);
        }
        // Migration fallback: old bytes may still live in Blobs.
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
      if (isSupabase()) {
        await supaSet(prefix + key, val);
        return;
      }
      await (await blobs(ns)).setJSON(key, val);
    },
    async delete(key) {
      if (isSupabase()) {
        try { await supaDel(prefix + key); } catch {}
        try { await (await blobs(ns)).delete(key); } catch {}
        return;
      }
      try { await (await blobs(ns)).delete(key); } catch {}
    }
  };
}

/** Health info for the /api/health endpoint (no secrets leaked). */
export function dbInfo() {
  return {
    backend: BACKEND,
    supabaseConfigured: !!(SUPA_URL && SUPA_KEY),
    supabaseUrlHost: SUPA_URL ? (() => { try { return new URL(SUPA_URL).host; } catch { return '?'; } })() : null
  };
}
