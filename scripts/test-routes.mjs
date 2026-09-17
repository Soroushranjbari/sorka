// Coach OS — route + static-exposure smoke test (no network, no real backend).
//
// This test exists because of two production bugs that unit tests could not
// catch:
//   1. shop/api/*.mjs lived OUTSIDE netlify.toml's [functions] directory, so
//      Netlify never deployed them and every shop checkout 404'd.
//   2. publish = "." served db/schema.sql (every password hash), data/*.json
//      and data/prod-secrets.txt to anyone who asked for them.
//
// It boots the real standalone server on a random port with the file KV
// backend in a temp dir and asserts the API contracts + the static deny-list.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'coachos-routes-'));
const PORT = 8100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name, extra === undefined ? '' : `(got ${JSON.stringify(extra)})`); }
};

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1',
    KV_FILE: join(dir, 'kv.json'), NODE_ENV: 'test',
    // The shop account proxy is server-to-server — point it back at this server
    // so the login/session round-trip is exercised for real.
    COACH_OS_URL: BASE
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverErr = '';
child.stderr.on('data', (b) => { serverErr += b.toString(); });

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const j = async (path, opts) => {
  const r = await fetch(BASE + path, opts);
  let d = null;
  try { d = await r.json(); } catch {}
  return { status: r.status, d, headers: r.headers };
};

try {
  if (!await waitReady()) throw new Error(`server did not start. stderr:\n${serverErr}`);

  console.log('== API routing ==');
  const health = await j('/api/health');
  ok('GET /api/health -> 200 ok', health.status === 200 && health.d?.ok === true, health.d);
  ok('health reports the file backend', health.d?.backend === 'file', health.d?.backend);
  ok('health leaks no db host', !health.d?.postgresHost, health.d?.postgresHost);

  const badLogin = await j('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  ok('POST /api/auth/login (empty) -> 400', badLogin.status === 400, badLogin.status);

  const noAuth = await j('/api/billing/me');
  ok('GET /api/billing/me (no token) -> 401', noAuth.status === 401, noAuth.status);

  // AI assistant endpoints: auth comes before everything (no key needed to 401)
  const aiQ = await j('/api/ai/quota');
  ok('GET /api/ai/quota (no token) -> 401', aiQ.status === 401, aiQ.status);
  const aiD = await j('/api/ai/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok('POST /api/ai/draft (no token) -> 401', aiD.status === 401, aiD.status);

  const badCode = await j('/api/data?code=nope!');
  ok('GET /api/data?code=<invalid> -> 400', badCode.status === 400, badCode.status);

  const missing = await j('/api/billing/does-not-exist', { method: 'POST' });
  ok('unknown billing action -> 404', missing.status === 404, missing.status);

  // Regression: GET /% made decodeURIComponent throw inside the async request
  // handler — an unhandled rejection that killed the whole Node process.
  const malformed = await j('/%');
  ok('GET /% (malformed encoding) -> 400, server alive', malformed.status === 400, malformed.status);
  const stillAlive = await j('/api/health');
  ok('server survives malformed request', stillAlive.status === 200, stillAlive.status);

  console.log('== shop API routing (regression: was never deployed) ==');
  const signup = await j('/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `test${Date.now()}@shop.dev`, name: 'Shop Tester', password: 'Str0ngPass!' })
  });
  ok('signup -> 200 with token + workspace code', signup.status === 200 && !!signup.d?.token && !!signup.d?.workspace?.code, signup.d);

  const ws = signup.d?.workspace?.code;
  const accountLogin = await j('/shop/api/account/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: signup.d?.coach?.email, password: 'Str0ngPass!' })
  });
  ok('POST /shop/api/account/login -> 200', accountLogin.status === 200 && accountLogin.d?.ok === true, accountLogin.d);

  const acctBad = await j('/shop/api/account/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@nowhere.dev', password: 'wrong-password' })
  });
  ok('shop account login (bad creds) -> 401', acctBad.status === 401, acctBad.status);

  const acctSessionNoToken = await j('/shop/api/account/session');
  ok('GET /shop/api/account/session (no token) -> 401', acctSessionNoToken.status === 401, acctSessionNoToken.status);

  // Data path still works end-to-end for a signed-in coach.
  const put = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ rev: 0, data: { v: 13, CLIENTS: [{ id: 1, name: 'A', status: 'Active' }] } })
  });
  ok('PUT /api/data (coach) -> 200', put.status === 200 && put.d?.ok === true, put.d);
  const get = await j(`/api/data?code=${ws}&rev=${put.d?.rev}`);
  ok('GET /api/data?rev=<current> -> unchanged', get.d?.unchanged === true, get.d);

  console.log('== static exposure (regression: secrets were downloadable) ==');
  for (const p of ['/data/prod-secrets.txt', '/data/prod-admin-pass.txt', '/data/kv-prod.json',
                   '/db/schema.sql', '/scripts/create-admin.mjs', '/netlify/lib/db.mjs',
                   '/server.mjs', '/package.json', '/netlify.toml', '/.env', '/DEPLOY.md', '/SELFHOST.md',
                   // Regression: the .kilo agent-worktree folder contains a FULL project copy
                   // (incl. prod-secrets.txt / schema.sql) and was not on the deny-list.
                   '/.kilo/worktrees/deep-lark/data/prod-secrets.txt',
                   '/.kilo/worktrees/deep-lark/data/prod-admin-pass.txt',
                   '/.kilo/worktrees/deep-lark/db/schema.sql',
                   '/.kilo/worktrees/deep-lark/data/kv-prod.json']) {
    const r = await fetch(BASE + p);
    ok(`blocked ${p} -> 404`, r.status === 404, r.status);
  }
  const shell = await fetch(`${BASE}/`);
  ok('GET / -> 200 app shell', shell.status === 200, shell.status);
  ok('GET / has no-cache header', /no-cache|max-age=0/.test(shell.headers.get('cache-control') || ''), shell.headers.get('cache-control'));
  ok('GET / has a CSP header', !!shell.headers.get('content-security-policy'));
  const sw = await fetch(`${BASE}/sw.js`);
  ok('GET /sw.js -> 200', sw.status === 200, sw.status);
} catch (e) {
  fail++;
  console.error('FAIL: harness error —', e.message);
} finally {
  child.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`ROUTES: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
