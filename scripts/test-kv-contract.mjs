// CoachMint — portable KV contract test (runs WITHOUT any network).
// Points the KV layer at a temp SQLite database, then loads backend/lib/db.mjs
// and asserts: backend detection, setJSON->get round-trip, missing key -> null,
// namespacing, delete, and durability on disk. No Postgres, no cloud.
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'coachos-kv-'));
process.env.SQLITE_PATH = join(dir, 'kv-test.sqlite.db');
const { kv, BACKEND, closeAll } = await import('../backend/lib/db.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.error('FAIL:', name)); };

ok('backend detected as sqlite', BACKEND === 'sqlite');
const a = kv('ns-a'), b = kv('ns-b');
await a.setJSON('k1', { x: 1 });
ok('round-trip', JSON.stringify(await a.get('k1', { type: 'json' })) === '{"x":1}');
ok('missing -> null', (await a.get('nope', { type: 'json' })) === null);
await b.setJSON('k1', { y: 2 });
ok('namespaced', (await a.get('k1', { type: 'json' })).x === 1 && (await b.get('k1', { type: 'json' })).y === 2);
await a.delete('k1');
ok('delete', (await a.get('k1', { type: 'json' })) === null);

// Durability: the SQLite file exists on disk and holds the data (WAL may
// buffer recent writes in -wal until checkpoint, so just verify the db file).
ok('persisted to disk', existsSync(process.env.SQLITE_PATH) && statSync(process.env.SQLITE_PATH).size > 0);

// Release the file handle BEFORE rmSync — Windows refuses to delete open files.
closeAll();
try { rmSync(dir, { recursive: true, force: true }); }
catch { /* AV/indexer may still hold it briefly — temp dir, harmless */ }

console.log(`KV_CONTRACT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
