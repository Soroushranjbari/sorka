// CoachMint — LIVE end-to-end integration test runner.
// Boots the real server.mjs on an ephemeral port with an isolated SQLite DB
// and executes live HTTP requests across all core flows.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'coach-live-'));
const PORT = 8300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@coachmint.test';
const ADMIN_KEY = 'live-test-admin-secret-key-12345';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✔ PASS\x1b[0m', name);
  } else {
    fail++;
    failures.push(name);
    console.error('  \x1b[31m✖ FAIL\x1b[0m', name, extra ? `(details: ${JSON.stringify(extra).slice(0, 200)})` : '');
  }
}

function section(title) {
  console.log(`\n\x1b[36m▶ ${title}\x1b[0m`);
}

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] = h['content-type'] || 'application/json';
  }
  const r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, d, text, headers: r.headers };
}

const authHeader = (token) => ({ authorization: `Bearer ${token}` });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let child = null;

try {
  console.log(`Starting live server on ${BASE} (temp DB: ${join(dir, 'live.sqlite.db')})...`);
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SQLITE_PATH: join(dir, 'live.sqlite.db'),
      DATABASE_URL: '',
      POSTGRES_URL: '',
      PGURL: '',
      ADMIN_EMAILS: ADMIN_EMAIL,
      ADMIN_API_KEY: ADMIN_KEY,
      COACH_OS_URL: BASE,
      DB_BACKUP_KEEP: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stderr.on('data', (d) => {
    const msg = d.toString();
    if (!msg.includes('ExperimentalWarning')) process.stderr.write(msg);
  });

  const ready = await waitReady();
  if (!ready) throw new Error('Server failed to start within timeout.');

  console.log('Server is healthy and listening!\n');

  // ================= 1. Health & Static Shell =================
  section('1. Health & App Shell');
  const h = await req('/api/health');
  ok('GET /api/health -> 200 OK', h.status === 200);
  ok('Health reports ok: true', h.d?.ok === true);
  ok('Health reports sqlite backend', h.d?.backend === 'sqlite');

  const shell = await req('/');
  ok('GET / -> 200 HTML', shell.status === 200 && (shell.headers.get('content-type') || '').includes('text/html'));
  ok('App shell contains CoachMint title & script', shell.text.includes('CoachMint') && shell.text.includes('app.js'));
  ok('App shell has no-cache policy', /no-cache|max-age=0/.test(shell.headers.get('cache-control') || ''));
  ok('App shell sets Content-Security-Policy', !!shell.headers.get('content-security-policy'));

  const js = await req('/app.js');
  ok('GET /app.js -> 200 JS', js.status === 200 && js.text.length > 10000);

  const sw = await req('/sw.js');
  ok('GET /sw.js -> 200', sw.status === 200);

  const manifest = await req('/manifest.json');
  ok('GET /manifest.json -> 200', manifest.status === 200);

  const shopHtml = await req('/shop/');
  ok('GET /shop/ -> 200 HTML', shopHtml.status === 200);

  // ================= 2. Security Deny List =================
  section('2. Security Deny List (Forbidden Files)');
  const denyList = [
    '/.env', '/.ENV', '/.env.dump.txt', '/.gitignore',
    '/server.mjs', '/package.json', '/vercel.json', '/middleware.js',
    '/ROTATION-RUNBOOK.md', '/DEPLOY.md', '/data/sqlite.db',
    '/backend/lib/db.mjs', '/scripts/create-admin.mjs'
  ];
  for (const path of denyList) {
    const res = await req(path);
    ok(`Blocked ${path} -> 404`, res.status === 404);
  }
  const malformed = await req('/%');
  ok('Malformed URI GET /% -> 400', malformed.status === 400);

  // ================= 3. Authentication & Sessions =================
  section('3. Authentication Flow');
  const coachEmail = `coach_${Date.now()}@test.io`;
  const coachPass = 'SecurePass!2026';

  const reg = await req('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Coach Soroush', email: coachEmail, password: coachPass }
  });
  ok('POST /api/auth/signup -> 200 with session token', reg.status === 200 && !!reg.d?.token);
  const token = reg.d?.token;
  const wsCode = reg.d?.workspace?.code;
  ok('Workspace auto-created with code', typeof wsCode === 'string' && wsCode.length >= 4);

  const me = await req('/api/auth/me', { headers: authHeader(token) });
  ok('GET /api/auth/me with Bearer token -> 200', me.status === 200 && me.d?.coach?.email === coachEmail);
  ok('Access status defaults to trial', me.d?.access?.status === 'trial');

  const loginRes = await req('/api/auth/login', {
    method: 'POST',
    body: { email: coachEmail, password: coachPass }
  });
  ok('POST /api/auth/login -> 200 with new token', loginRes.status === 200 && !!loginRes.d?.token);

  const badLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { email: coachEmail, password: 'WrongPassword123' }
  });
  ok('POST /api/auth/login with wrong pass -> 401', badLogin.status === 401);

  const prof = await req('/api/auth/profile', {
    method: 'POST',
    headers: authHeader(token),
    body: { name: 'Master Coach', phone: '+989123456789', bio: 'Fitness & Endurance' }
  });
  ok('POST /api/auth/profile -> 200 updated', prof.status === 200 && prof.d?.coach?.name === 'Master Coach');

  // ================= 4. Data Sync =================
  section('4. Workspace Data Sync');
  const payload = {
    rev: 0,
    data: {
      CLIENTS: [
        { id: 1, name: 'Arman T.', status: 'Active', goal: 'Hypertrophy', prog: 'Strength PPL' }
      ],
      EVENTS: [
        { id: 'ev1', client: 'Arman T.', day: 0, start: 9, dur: 1, label: 'Upper Push' }
      ],
      NOTES: [
        { id: 'n1', c: 'Arman T.', t: 'High energy session', d: '2026-11-02' }
      ],
      NPLANS: [
        {
          id: 'np1', client: 'Arman T.', name: 'Clean Bulk Plan',
          train: { kcal: 2800, p: 190, c: 320, f: 75 },
          rest: { kcal: 2300, p: 190, c: 200, f: 70 },
          days: [
            { type: 'train', meals: [{ time: '08:00', name: 'Breakfast', foods: [] }] }
          ]
        }
      ]
    }
  };

  const putData = await req(`/api/data?code=${wsCode}`, {
    method: 'PUT',
    headers: authHeader(token),
    body: payload
  });
  ok('PUT /api/data -> 200 saved', putData.status === 200 && !!putData.d?.rev);
  const currentRev = putData.d?.rev;

  const getData = await req(`/api/data?code=${wsCode}`, { headers: authHeader(token) });
  ok('GET /api/data -> 200 returns persisted clients', getData.status === 200 && getData.d?.data?.CLIENTS?.length === 1);
  ok('Client name preserved', getData.d?.data?.CLIENTS[0]?.name === 'Arman T.');

  const pollUnchanged = await req(`/api/data?code=${wsCode}&rev=${currentRev}`, { headers: authHeader(token) });
  ok('GET /api/data with current rev -> 200 unchanged: true', pollUnchanged.status === 200 && pollUnchanged.d?.unchanged === true);

  // ================= 5. Strava Integration =================
  section('5. Strava Integration');
  const strCfg = await req('/api/strava/config');
  ok('GET /api/strava/config -> 200 simulator: true', strCfg.status === 200 && strCfg.d?.simulator === true);

  const strAuth = await req('/api/strava/auth');
  ok('GET /api/strava/auth -> 200 simulator URL', strAuth.status === 200 && strAuth.d?.mode === 'simulator');

  const strCb = await req('/api/strava/callback?code=mock_strava_sandbox_token');
  ok('GET /api/strava/callback (sandbox) -> 200 redirect HTML', strCb.status === 200 && strCb.text.includes('wear&strava=connected'));

  const strStat = await req('/api/strava/status');
  ok('GET /api/strava/status -> 200 connected: true', strStat.status === 200 && strStat.d?.connected === true);
  ok('Strava athlete identified', !!strStat.d?.athleteName);

  const strSync = await req('/api/strava/sync', { method: 'POST' });
  ok('POST /api/strava/sync -> 200 activities imported', strSync.status === 200 && strSync.d?.count > 0);
  ok('Activity contains splits & distance', strSync.d?.activities[0]?.km > 0 && typeof strSync.d?.activities[0]?.splits === 'string');

  const strDisc = await req('/api/strava/disconnect', { method: 'POST' });
  ok('POST /api/strava/disconnect -> 200 disconnected', strDisc.status === 200 && strDisc.d?.connected === false);

  // ================= 6. Shop & Billing =================
  section('6. Shop Checkout & Coupons');
  const checkout = await req('/shop/api/checkout', {
    method: 'POST',
    body: {
      planId: 'professional',
      name: 'Buyer Coach',
      email: coachEmail,
      phone: '09123456789'
    }
  });
  ok('POST /shop/api/checkout -> 200 coupon generated', checkout.status === 200 && Array.isArray(checkout.d?.coupons));
  const couponCode = checkout.d?.coupons[0];

  const redeem = await req('/api/billing/redeem', {
    method: 'POST',
    headers: authHeader(token),
    body: { code: couponCode }
  });
  ok('POST /api/billing/redeem -> 200 redeemed', redeem.status === 200 && redeem.d?.ok === true);

  const bill = await req('/api/billing/me', { headers: authHeader(token) });
  ok('GET /api/billing/me confirms active professional plan', bill.status === 200 && bill.d?.billing?.plan === 'professional' && bill.d?.billing?.status === 'active');

  // ================= 7. Printable Export =================
  section('7. Printable PDF Export');
  const expHtml = await req(`/api/export/pdf?code=${wsCode}`);
  ok('GET /api/export/pdf -> 200 HTML printable view', expHtml.status === 200 && expHtml.text.includes('Arman T.'));

  const expNut = await req(`/api/export/pdf?code=${wsCode}&kind=nutrition`);
  ok('GET /api/export/pdf?kind=nutrition -> 200', expNut.status === 200);

} catch (err) {
  console.error('\n\x1b[31mCRITICAL RUNNER ERROR:\x1b[0m', err);
  fail++;
} finally {
  if (child && !child.killed) {
    console.log('\nStopping live server process...');
    child.kill('SIGTERM');
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n====================================');
console.log(`LIVE E2E TEST SUMMARY: \x1b[32m${pass} PASSED\x1b[0m, \x1b[31m${fail} FAILED\x1b[0m`);
console.log('====================================\n');

if (fail > 0) {
  console.error('Failed checks:', failures);
  process.exit(1);
} else {
  console.log('\x1b[32mAll live end-to-end tests succeeded!\x1b[0m');
}
