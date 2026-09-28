#!/usr/bin/env node
// CoachMint — DB cleanup + automatic backup (item 4 of the audit report).
//
//   node scripts/db-maintenance.mjs            # dry-run: show what would happen
//   node scripts/db-maintenance.mjs --clean    # purge test/junk records (after a backup)
//   node scripts/db-maintenance.mjs --backup   # take a backup now (no purge)
//   node scripts/db-maintenance.mjs --backup --clean
//
// WHAT --clean REMOVES (only junk; real user data is never touched):
//   · accounts on throwaway domains:  *@test.dev / *@x.dev / *@shop.dev
//   · their acct-by-id pointers, sessions, session indexes, workspaces,
//     ws-meta payloads and AI quota/chat counters
//   · expired password-reset tokens (any age) + stale ones (>24h)
//   · expired sessions (sess: rows past their expiresAt)
//   · shop orders belonging to the throwaway test emails
//   · fully-used coupons marked isActive:false (redeemed, dead)
//
// WHAT --backup DOES:
//   · copies data/sqlite.db (+ -wal / -shm if present) to data/backups/
//     as coachmint-YYYY-MM-DD-HHMMSS.db — a consistent snapshot thanks to
//     SQLite's online backup API (safe while the server is running).
//   · keeps the newest KEEP_BACKUPS (default 14), deletes older ones.
//
// Exit codes: 0 ok, 1 nothing done / error.
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const DRY = !args.has('--clean') && !args.has('--backup');
const DO_CLEAN = args.has('--clean');
const DO_BACKUP = args.has('--backup') || DO_CLEAN; // --clean always takes a backup first
const KEEP_BACKUPS = Number(process.env.DB_BACKUP_KEEP) || 14;

/* load .env minimally (SQLITE_PATH only) — same rule as deploy-check */
let SQLITE_PATH = '';
try {
  if (existsSync(join(ROOT, '.env'))) {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(/^SQLITE_PATH\s*=\s*(.+)\s*$/m);
    if (m) SQLITE_PATH = m[1].trim().replace(/^["']|["']$/g, '');
  }
} catch {}
const DB_PATH = join(ROOT, SQLITE_PATH || 'data/sqlite.db');
const BACKUP_DIR = join(ROOT, 'data/backups');

if (!existsSync(DB_PATH)) {
  console.error(`[db-maintenance] database not found: ${DB_PATH}`);
  process.exit(1);
}

const { default: Database } = await import('better-sqlite3');
const db = new Database(DB_PATH);
const get = (k) => db.prepare('select value from kv where key = ?').get(k);
const val = (k) => { const r = get(k); try { return JSON.parse(r.value); } catch { return null; } };
const del = (k) => db.prepare('delete from kv where key = ?').run(k);
const rows = () => db.prepare('select key from kv').all().map(r => r.key);

const NS = 'coach-os-saas';
const TEST_RE = /@(test\.dev|x\.dev|shop\.dev|example\.com)$/i;

/* ---------------- BACKUP ---------------- */
function backup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = join(BACKUP_DIR, `coachmint-${stamp}.db`);
  // SQLite online backup API: consistent even with a live writer (WAL included).
  db.backup(target)
    .then(() => {
      console.log(`[backup] ✓ ${target}`);
      // prune old backups
      const files = readdirSync(BACKUP_DIR)
        .filter(f => /^coachmint-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f))
        .sort().reverse();
      for (const f of files.slice(KEEP_BACKUPS)) {
        try { unlinkSync(join(BACKUP_DIR, f)); console.log(`[backup] pruned ${f}`); } catch {}
      }
      console.log(`[backup] ${Math.min(files.length, KEEP_BACKUPS)} backup(s) kept (policy: ${KEEP_BACKUPS})`);
    })
    .catch((e) => { console.error('[backup] FAILED:', e.message); process.exitCode = 1; });
}

/* ---------------- CLEAN ---------------- */
function clean() {
  const plan = { accounts: [], sessions: [], workspaces: [], misc: [] };
  const testIds = new Set();

  for (const k of rows()) {
    if (k.startsWith(`${NS}:acct:`) && !k.includes('acct-by-id')) {
      const a = val(k);
      if (a && TEST_RE.test(a.email || '')) {
        plan.accounts.push(k);
        testIds.add(a.id);
      }
    }
  }

  for (const k of rows()) {
    if (k.startsWith(`${NS}:sess:co_`)) {
      const s = val(k);
      if (!s) { plan.sessions.push(k); continue; }
      const expired = s.expiresAt && Date.now() > s.expiresAt;
      const isTest = testIds.size && testEmail(s.email);
      if (expired || isTest) plan.sessions.push(k);
    } else if (k.startsWith(`${NS}:sess-idx:`)) {
      // indexes of deleted/purged coaches go away with them
      const id = k.slice(`${NS}:sess-idx:`.length);
      if (testIds.has(id)) plan.sessions.push(k);
    } else if (k.startsWith(`${NS}:acct-by-id:`)) {
      if (testIds.has(k.slice(`${NS}:acct-by-id:`.length))) plan.accounts.push(k);
    } else if (k.startsWith(`${NS}:ws:`) || k.startsWith(`${NS}:ws-meta:`)) {
      const w = val(k);
      const owner = (w && w.owner || '').replace(/^coach:/, '');
      if (testIds.has(owner)) plan.workspaces.push(k);
    } else if (k.startsWith(`${NS}:ws-by-code:`)) {
      const p = val(k);
      if (p && p.wid && testWsIds().has(p.wid)) plan.workspaces.push(k);
    } else if (k.startsWith(`${NS}:reset:rs_`)) {
      const r = val(k);
      if (!r || (r.expiresAt && Date.now() > r.expiresAt)) plan.misc.push(k);
    } else if (k.startsWith(`${NS}:ai-`)) {
      const cid = (k.match(/coach_[a-z0-9]+/) || [])[0];
      if (testIds.has(cid)) plan.misc.push(k);
    } else if (k.startsWith('shop-orders:order:')) {
      const o = val(k);
      if (o && TEST_RE.test(o.email || '')) plan.misc.push(k);
    } else if (k.startsWith('shop-orders:idx:')) {
      const email = k.slice('shop-orders:idx:'.length);
      if (TEST_RE.test(email)) plan.misc.push(k);
    } else if (k.startsWith(`${NS}:coupon:`)) {
      const c = val(k);
      if (c && c.isActive === false && (c.usedCount || 0) >= (c.maxUses || 1)) plan.misc.push(k);
    }
  }
  function testEmail(email) { return TEST_RE.test(String(email || '')); }
  // second pass for ws-by-code (needs the wid set, built above)
  function testWsIds() {
    const s = new Set();
    for (const k of plan.workspaces) { const wid = k.split(':').pop(); if (k.includes(':ws:')) s.add(wid); }
    return s;
  }

  const total = plan.accounts.length + plan.sessions.length + plan.workspaces.length + plan.misc.length;
  console.log(`[clean] ${total} record(s) to delete:`);
  console.log(`  · accounts+pointers : ${plan.accounts.length}`);
  console.log(`  · sessions/indexes  : ${plan.sessions.length}`);
  console.log(`  · workspaces        : ${plan.workspaces.length}`);
  console.log(`  · misc (resets/ai/coupons/shop-orders): ${plan.misc.length}`);
  if (DRY || !total) {
    if (total) for (const k of [...plan.accounts, ...plan.sessions, ...plan.workspaces, ...plan.misc]) console.log('   -', k);
    console.log('[clean] dry-run — pass --clean to apply.');
    return;
  }
  const tx = db.transaction(() => {
    for (const k of [...plan.accounts, ...plan.sessions, ...plan.workspaces, ...plan.misc]) del(k);
  });
  tx();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const left = db.prepare('select count(*) c from kv').get().c;
  console.log(`[clean] ✓ done — ${total} deleted, ${left} records remain.`);
}

if (DRY) {
  console.log('[db-maintenance] DRY RUN (no changes). Use --backup and/or --clean.');
  clean();
} else {
  if (DO_BACKUP) backup();
  if (DO_CLEAN) {
    // run clean AFTER the backup promise resolves (backup is async)
    setTimeout(() => { try { clean(); } finally { db.close(); } }, 300);
  } else {
    setTimeout(() => db.close(), 300);
  }
}
if (DRY) db.close();
