#!/usr/bin/env node
// CoachMint — keep the standalone-server logs bounded.
//
//   node scripts/log-rotate.mjs              # rotate anything over the cap
//   node scripts/log-rotate.mjs --dry        # just report
//   node scripts/log-rotate.mjs --max-mb 2 --keep 3
//
// The standalone server is normally launched as `node server.mjs > server.log
// 2> server.err.log`, so the process holds those files OPEN — Windows refuses
// to rename an open file. Rotation therefore happens when the server is
// stopped (e.g. right before a restart); files that cannot be moved are
// reported and skipped instead of crashing. Nothing outside the project root
// is touched, and only files ending in .log are ever considered.
import { readdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const MAX = arg('--max-mb', 5) * 1024 * 1024;
const KEEP = arg('--keep', 5);

let logs;
try { logs = readdirSync(ROOT).filter(f => f.endsWith('.log')).filter(f => statSync(join(ROOT, f)).isFile()); }
catch (e) { console.error('[log-rotate] cannot list root:', e.message); process.exit(1); }

if (!logs.length) { console.log('[log-rotate] no .log files at project root — nothing to do.'); process.exit(0); }

let rotated = 0, skipped = 0;
for (const name of logs) {
  const file = join(ROOT, name);
  const size = statSync(file).size;
  if (size <= MAX) { console.log(`[log-rotate] ${name}: ${(size / 1024).toFixed(0)} KB — under cap, skipped`); continue; }
  if (DRY) { console.log(`[log-rotate] ${name}: ${(size / 1024 / 1024).toFixed(1)} MB — WOULD rotate (keep ${KEEP})`); rotated++; continue; }
  // shift .(keep-1) out, then .1 -> .2 ... -> .1
  for (let n = KEEP - 1; n >= 1; n--) {
    const older = join(ROOT, `${name}.${n}`);
    try { renameSync(older, join(ROOT, `${name}.${n + 1}`)); }
    catch { /* no archive at this slot yet — expected */ }
  }
  try { renameSync(file, join(ROOT, `${name}.1`)); rotated++; console.log(`[log-rotate] ${name}: rotated ${(size / 1024 / 1024).toFixed(1)} MB -> ${name}.1`); }
  catch (e) { skipped++; console.error(`[log-rotate] ${name}: could not rotate (${e.code}) — is the server still running and holding the file open?`); }
}
console.log(`[log-rotate] ${DRY ? 'dry run: ' : ''}${rotated} rotated, ${skipped} skipped`);
process.exit(skipped ? 1 : 0);
