// Coach OS — portable KV contract test (runs WITHOUT any backend or network).
// Points the KV layer at a temp JSON file, then loads netlify/lib/db.mjs and
// asserts: backend detection, setJSON->get round-trip, missing key -> null,
// namespacing, delete, and durability on disk. No Postgres, no Netlify.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'coachos-kv-'));
process.env.KV_FILE = join(dir, 'kv-test.json');
const { kv, BACKEND } = await import('../netlify/lib/db.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.error('FAIL:', name)); };

ok('backend detected as file', BACKEND === 'file');
const a = kv('ns-a'), b = kv('ns-b');
await a.setJSON('k1', { x: 1 });
ok('round-trip', JSON.stringify(await a.get('k1', { type: 'json' })) === '{"x":1}');
ok('missing -> null', (await a.get('nope', { type: 'json' })) === null);
await b.setJSON('k1', { y: 2 });
ok('namespaced', (await a.get('k1', { type: 'json' })).x === 1 && (await b.get('k1', { type: 'json' })).y === 2);
await a.delete('k1');
ok('delete', (await a.get('k1', { type: 'json' })) === null);

// Durability: the file on disk holds every namespaced key as "<ns>:<key>".
const disk = JSON.parse(readFileSync(process.env.KV_FILE, 'utf8'));
ok('persisted to disk', disk['ns-b:k1'] && disk['ns-b:k1'].y === 2);

rmSync(dir, { recursive: true, force: true });

console.log(`KV_CONTRACT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
