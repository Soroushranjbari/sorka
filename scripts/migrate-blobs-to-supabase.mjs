// Coach OS — one-shot migration: Netlify Blobs -> Supabase kv_store.
// Copies (never deletes) every key from both Blobs namespaces into the
// Supabase table `public.kv_store` (keys namespaced "<ns>:<key>").
//
// Run AFTER executing supabase/schema.sql and setting env vars:
//   SUPABASE_URL=https://xyzcompany.supabase.co
//   SUPABASE_SERVICE_KEY=eyJhbGciOi... (SERVICE ROLE, never the anon key)
//
// Local (needs Netlify Blobs access, so run via `netlify dev` or with
// NETLIFY_BLOBS_* env present):
//   node ./scripts/migrate-blobs-to-supabase.mjs
//
// Flags:
//   --dry-run   list what WOULD be copied, copy nothing.
//   --only=ns   only one namespace (coach-os-saas | coach-os-workspaces).
const { getStore } = await import('@netlify/blobs');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DRY = process.argv.includes('--dry-run');
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const NAMESPACES = onlyArg ? [onlyArg] : ['coach-os-saas', 'coach-os-workspaces'];

if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.');
  process.exit(1);
}

const headers = {
  apikey: SUPA_KEY,
  authorization: `Bearer ${SUPA_KEY}`,
  'content-type': 'application/json'
};

let copied = 0, skipped = 0, failed = 0;

for (const ns of NAMESPACES) {
  console.log(`\n== namespace: ${ns} ==`);
  let store;
  try {
    store = getStore({ name: ns, consistency: 'strong' });
  } catch (e) {
    console.error(`  cannot open Blobs store (${e.message}) — skipping`);
    continue;
  }
  let list;
  try {
    list = await store.list();
  } catch (e) {
    console.error(`  list() failed (${e.message}) — skipping`);
    continue;
  }
  const keys = (list.blobs || []).map((b) => b.key);
  console.log(`  ${keys.length} keys found`);
  for (const key of keys) {
    let val = null;
    try {
      val = await store.get(key, { type: 'json' });
    } catch (e) {
      console.error(`  GET ${key}: failed (${e.message})`);
      failed++;
      continue;
    }
    if (val === null || val === undefined) { skipped++; continue; }
    if (DRY) { console.log(`  [dry-run] would copy ${ns}:${key}`); copied++; continue; }
    const r = await fetch(`${SUPA_URL}/rest/v1/kv_store?on_conflict=key`, {
      method: 'POST',
      headers: { ...headers, prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: `${ns}:${key}`, value: val })
    });
    if (!r.ok) {
      console.error(`  PUT ${ns}:${key}: Supabase ${r.status} ${await r.text().catch(() => '')}`);
      failed++;
    } else {
      copied++;
      if (copied % 50 === 0) console.log(`  ...${copied} copied`);
    }
  }
}

console.log(`\nDone. copied=${copied} skipped=${skipped} failed=${failed}${DRY ? ' (DRY RUN)' : ''}`);
process.exit(failed ? 2 : 0);
