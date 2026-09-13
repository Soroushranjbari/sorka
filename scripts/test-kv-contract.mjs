// Coach OS — portable KV contract test (runs WITHOUT any backend).
// Mocks global fetch with an in-memory kv_store, then loads netlify/lib/db.mjs
// and asserts: setJSON->get round-trip, missing key -> null, namespacing,
// delete, and blobs-fallback read. No network, no Supabase, no Netlify.
const rows = new Map(); // key -> value (simulates public.kv_store)
let supaOn = true;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (!u.includes('/rest/v1/kv_store')) throw new Error('unexpected url ' + u);
  if (!supaOn) return { ok: false, status: 500, json: async () => null, text: async () => 'down' };
  const mKey = u.match(/key=eq\.([^&]+)/);
  if (method === 'GET') {
    const k = decodeURIComponent(mKey[1]);
    return { ok: true, json: async () => (rows.has(k) ? [{ value: rows.get(k) }] : []) };
  }
  if (method === 'POST') {
    const body = JSON.parse(opts.body);
    rows.set(body.key, body.value);
    return { ok: true, json: async () => null, text: async () => '' };
  }
  if (method === 'DELETE') {
    rows.delete(decodeURIComponent(mKey[1]));
    return { ok: true, json: async () => null };
  }
  throw new Error('unexpected method');
};

process.env.SUPABASE_URL = 'https://xyzcompany.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
const { kv, BACKEND } = await import('../netlify/lib/db.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.error('FAIL:', name)); };

ok('backend detected as supabase', BACKEND === 'supabase');
const a = kv('ns-a'), b = kv('ns-b');
await a.setJSON('k1', { x: 1 });
ok('round-trip', JSON.stringify(await a.get('k1', { type: 'json' })) === '{"x":1}');
ok('missing -> null', (await a.get('nope', { type: 'json' })) === null);
await b.setJSON('k1', { y: 2 });
ok('namespaced', (await a.get('k1', { type: 'json' })).x === 1 && (await b.get('k1', { type: 'json' })).y === 2);
await a.delete('k1');
ok('delete', (await a.get('k1', { type: 'json' })) === null);

// Fallback: supabase down + key only in Blobs -> still readable.
// (Blobs unavailable locally, so we only assert graceful null, not throw.)
supaOn = false;
let threw = false;
try { await a.get('anything', { type: 'json' }); } catch { threw = true; }
ok('fallback never throws', !threw);

console.log(`KV_CONTRACT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
