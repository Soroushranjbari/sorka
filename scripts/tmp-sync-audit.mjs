/* One-off audit: every NEW data shape introduced in v18.74/18.75 must survive
   a full PUT → GET round-trip on the real backend (no silent stripping). */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8901, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
    SQLITE_PATH: join(dir, 'kv.sqlite.db'), NODE_ENV: 'test',
    DATABASE_URL: '', POSTGRES_URL: '', PGURL: '',
    AI_API_KEY: '', OPENROUTER_API_KEY: '', ADMIN_API_KEY: 'test-admin-key-0123456789abcdef' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const J = async (p, o = {}) => { const r = await fetch(BASE + p, o); return { s: r.status, d: await r.json().catch(() => ({})) }; };
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await wait(250); }

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.error('  FAIL', n, JSON.stringify(x).slice(0, 240))); };

const wav = 'data:audio/wav;base64,' + 'A'.repeat(40000);   // ~40 KB voice note
const photo = 'data:image/jpeg;base64,' + 'B'.repeat(80000); //80 KB ai photo (in NCHAT.src)

const DATA = {
  v: 18,
  CLIENTS: [{
    id: 1, name: 'Round Trip', status: 'Active', code: 'RT123456',
    prog2: { name: 'Powerbuilding — Block 2', phase: 2, phases: 3, week: 6, weeks: 16 },
    prog: 'Powerbuilding — Block 2', week: 6,
    habits: [
      { id: 'water', name: 'Drink 2L water', type: 'auto', metric: 'water', target: 2, unit: 'L', on: true, order: 1 },
      { id: 'steps', name: 'Steps 8,000', type: 'count', target: 8000, unit: 'steps', on: true, order: 2 },
      { id: 'nosugar', name: 'No sugary drinks', type: 'tick', target: 1, unit: '', on: false, order: 3 }
    ],
    hlog: { '2026-10-01': { water: 1, steps: 5200, nosugar: true } },
    ptsDay: 13, ptsDate: '2026-10-01', dayStreak: 12, pts: 524
  }],
  DB: { 1: { workouts: [], sessions: [], stats: { done: 41, missed: 3 }, log: [], measures: [], photos: [], split: [] } },
  MSGS: [
    { id: 'm-voice', client: 'Round Trip', from: 'client', type: 'voice', body: '🎙 Voice message · 0:12', src: wav, dur: 12, time: 'Just now', read: false },
    { id: 'm-photo', client: 'Round Trip', from: 'client', type: 'file', body: '📎 x.jpg', src: photo, time: 'Just now', read: false }
  ],
  CHALLENGES: [
    { id: 'ch-own', name: '30 push-ups a day', emoji: '💪', type: 'target', metric: 'workouts', target: 30, unit: 'days',
      start: '2026-10-01', days: 30, parts: ['Round Trip'], owner: 'client',
      reward: { pts: 80, be: '🎖', bn: 'Self-made' }, stages: [], prog: {}, done: [], status: 'active', createdAt: Date.now() }
  ],
  NLOGS: [
    { id: 'n1', client: 'Round Trip', d: '2026-10-01', meal: 'Lavash bread (local)', items: [{ n: 'Lavash bread (local)', g: 100, kcal: 275, p: 9, c: 55, f: 2 }],
      kcal: 275, p: 9, c: 55, f: 2, src: 'barcode', at: Date.now() },
    { id: 'n2', client: 'Round Trip', d: '2026-10-01', type: 'water', ml: 500, meal: '', items: [], kcal: 0, p: 0, c: 0, f: 0, src: 'quick', at: Date.now() }
  ],
  NCHAT: [{ id: 'c1', client: 'Round Trip', role: 'student', body: '📷', src: photo, d: '2026-10-01', at: Date.now(),
    card: { type: 'log', meal: 'Dinner', items: [{ n: 'Chicken Breast', g: 200, kcal: 330, p: 62, c: 0, f: 7 }], kcal: 330, p: 62, c: 0, f: 7, confirmed: true } }],
  PACKS: [{ id: 9, client: 'Round Trip', name: '10-Session Pack', total: 10, used: 4, createdAt: Date.now() }],
  NPLANS: [], NOTES: [], CHAL: undefined
};

try {
  const su = await J('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `aud${Date.now()}@t.dev`, name: 'Audit', password: 'Str0ngPass!' }) });
  ok('signup -> 200', su.s === 200, su);
  const ws = su.d?.workspace?.code, tok = su.d?.token;

  const put = await J(`/api/data?code=${ws}`, { method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ data: DATA }) });
  ok('PUT with every new data shape -> 200', put.s === 200 && put.d?.ok === true, put);

  const get = await J(`/api/data?code=${ws}`, { headers: { authorization: `Bearer ${tok}` } });
  ok('GET -> 200', get.s === 200, get);
  const D = get.d?.data || {};

  const c = (D.CLIENTS || [])[0];
  ok('CLIENTS returned', !!c, get.d && Object.keys(D));
  ok('prog2 survives', JSON.stringify(c?.prog2) === JSON.stringify(DATA.CLIENTS[0].prog2), c?.prog2);
  ok('habits (3, incl. hidden) survive', Array.isArray(c?.habits) && c.habits.length === 3 && c.habits[2].on === false, c?.habits);
  ok('hlog (per-day values) survives', JSON.stringify(c?.hlog) === JSON.stringify(DATA.CLIENTS[0].hlog), c?.hlog);
  ok('ptsDay/ptsDate survive', c?.ptsDay === 13 && c?.ptsDate === '2026-10-01', { p: c?.ptsDay, d: c?.ptsDate });
  ok('dayStreak survives', c?.dayStreak === 12, c?.dayStreak);

  const mv = (D.MSGS || []).find(m => m.id === 'm-voice');
  ok('voice message survives with audio', !!mv && mv.type === 'voice' && mv.src?.startsWith('data:audio') && mv.src.length > 39000,
    mv && { type: mv.type, len: mv.src?.length });
  const mp = (D.MSGS || []).find(m => m.id === 'm-photo');
  ok('photo message survives', !!mp && (mp.src || '').length > 79000, mp && (mp.src || '').length);

  const ch = (D.CHALLENGES || []).find(x => x.id === 'ch-own');
  ok('client-owned challenge survives', !!ch && ch.owner === 'client' && ch.parts[0] === 'Round Trip', ch);

  const nb = (D.NLOGS || []).find(x => x.src === 'barcode');
  ok('barcode log (non-library food name) survives', !!nb && nb.items[0].n === 'Lavash bread (local)', nb);
  const wt = (D.NLOGS || []).find(x => x.type === 'water');
  ok('water log (ml) survives', !!wt && wt.ml === 500, wt);

  const cc = (D.NCHAT || [])[0];
  ok('assistant msg + confirmed card + photo survive', !!cc?.src && cc?.card?.confirmed === true && cc?.card?.kcal === 330, cc && { src: cc.src.length, card: cc.card });
  ok('PACKS survive', (D.PACKS || []).length === 1 && D.PACKS[0].name === '10-Session Pack', D.PACKS);
  ok('DB bucket (stats/photos) survives', D.DB?.['1']?.stats?.done === 41, D.DB?.['1']);

  // payload size is dominated by the two audio/photo blobs — must stay under cap
  const bytes = Buffer.byteLength(JSON.stringify({ data: DATA }));
  ok('payload fits the5 MB cap', bytes < 5_000_000, bytes);
  console.log('     payload size:', (bytes / 1024).toFixed(0), 'KB');
} finally {
  console.log(`\nSYNC-ROUNDTRIP: ${pass} pass, ${fail} fail`);
  srv.kill();
  process.exit(fail ? 1 : 0);
}
