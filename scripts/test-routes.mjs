// CoachMint — route + static-exposure smoke test (no network, no real backend).
//
// This test exists because of two production bugs that unit tests could not
// catch:
//   1. shop/api/*.mjs lived OUTSIDE netlify.toml's [functions] directory, so
//      Netlify never deployed them and every shop checkout 404'd.
//   2. publish = "." served db/schema.sql (every password hash), data/*.json
//      and data/prod-secrets.txt to anyone who asked for them.
//
// It boots the real standalone server on a random port with a temp SQLite
// database and asserts the API contracts + the static deny-list.
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
    SQLITE_PATH: join(dir, 'kv-test.sqlite.db'), NODE_ENV: 'test',
    // The shop account proxy is server-to-server — point it back at this server
    // so the login/session round-trip is exercised for real.
    COACH_OS_URL: BASE,
    // A real (test) API key makes /shop/api/checkout issue the coupon INTO this
    // server's KV instead of demo-minting an unregistered code — required for
    // the purchase → signup → active-plan e2e below.
    ADMIN_API_KEY: 'test-admin-key-0123456789abcdef'
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
  ok('health reports the sqlite backend', health.d?.backend === 'sqlite', health.d?.backend);
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

  // Shop-side SIGNUP (the checkout success form + account page "Create
  // account"): the proxy must forward to /api/auth/signup and hand back a
  // working session. Regression guard: this route only exists since the shop
  // had no signup at all and every buyer was forced into the app to register.
  const shopSignup = await j('/shop/api/account/signup', {
    method: 'POST',
    // Distinct buyer IPs: signup is rate-limited 5/min PER IP, and this suite
    // performs several signups from 127.0.0.1 — without this the last ones
    // would 429 and make the suite order-dependent.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.11' },
    body: JSON.stringify({ email: `su${Date.now()}@shop.dev`, name: 'Shop Signup', password: 'Str0ngPass!' })
  });
  ok('POST /shop/api/account/signup -> 200 with token', shopSignup.status === 200 && !!shopSignup.d?.token && shopSignup.d?.coach?.email, shopSignup.d);
  ok('shop signup starts as trial (no coupon sent)', shopSignup.d?.billing?.status === 'trial', shopSignup.d?.billing);
  const shopDup = await j('/shop/api/account/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.12' },
    body: JSON.stringify({ email: shopSignup.d?.coach?.email, name: 'Duplicate', password: 'Str0ngPass!' })
  });
  ok('shop signup duplicate email -> 409', shopDup.status === 409, shopDup.status);
  const shopWeak = await j('/shop/api/account/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.13' },
    body: JSON.stringify({ email: `weak${Date.now()}@shop.dev`, name: 'Weak', password: 'short' })
  });
  ok('shop signup weak password -> 400 weak-password', shopWeak.status === 400 && shopWeak.d?.error === 'weak-password', shopWeak.d);
  // The token from the shop signup must be a REAL app session (the checkout
  // page stores it as the app's co-auth, so "Open the app" must land signed in).
  const shopMe = await j('/api/auth/me', { headers: { authorization: `Bearer ${shopSignup.d?.token}` } });
  ok('shop signup token works on /api/auth/me', shopMe.status === 200 && shopMe.d?.ok === true, shopMe.status);

  // FULL purchase → signup e2e: buy on the shop, create the account through the
  // shop WITH the issued code — the plan must be ACTIVE on first login (the
  // 14-day trial must never start). This is the exact flow the checkout
  // success page performs.
  console.log('== shop purchase → signup with code (e2e) ==');
  const buyerEmail = `buy${Date.now()}@shop.dev`;
  const buy = await j('/shop/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'basic', email: buyerEmail, name: 'Buyer One', phone: '09123456789' })
  });
  ok('shop checkout issues a REAL coupon (not demo)', buy.status === 200 && buy.d?.ok === true && !!buy.d?.coupons?.[0] && buy.d?.demo === false, buy.d);
  const buySignup = await j('/shop/api/account/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.14' },
    body: JSON.stringify({ email: buyerEmail, name: 'Buyer One', password: 'Str0ngPass!', coupon: buy.d?.coupons?.[0] })
  });
  ok('shop signup + code -> redeemed:true', buySignup.status === 200 && buySignup.d?.redeemed === true, buySignup.d);
  ok('plan is ACTIVE basic on first login (no trial)', buySignup.d?.billing?.status === 'active' && buySignup.d?.billing?.plan === 'basic', buySignup.d?.billing);
  const buyMe = await j('/api/billing/me', { headers: { authorization: `Bearer ${buySignup.d?.token}` } });
  ok('/api/billing/me confirms active basic', buyMe.status === 200 && buyMe.d?.billing?.status === 'active' && buyMe.d?.billing?.plan === 'basic', buyMe.d?.billing);
  // A second signup with the SAME (now used-up) code must still create the
  // account — the code failure must never block registration.
  const usedCode = await j('/shop/api/account/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.15' },
    body: JSON.stringify({ email: `second${Date.now()}@shop.dev`, name: 'Second User', password: 'Str0ngPass!', coupon: buy.d?.coupons?.[0] })
  });
  ok('signup with a used-up code still creates the account', usedCode.status === 200 && usedCode.d?.ok === true && usedCode.d?.redeemError === 'code-used-up', usedCode.d);

  // LOGIN = email + password ONLY. A coupon in the login body must be IGNORED
  // (no redemption, no redeemed flag) and the code must stay redeemable —
  // renewal codes go through Settings → Account (/api/billing/redeem).
  console.log('== login contract: email + password only ==');
  const renewBuy = await j('/shop/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'basic', email: `renew${Date.now()}@shop.dev`, name: 'Renew Buyer', phone: '09123456789' })
  });
  const renewCode = renewBuy.d?.coupons?.[0];
  ok('renewal coupon issued', renewBuy.status === 200 && !!renewCode, renewBuy.d);
  const loginWithCoupon = await j('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: signup.d?.coach?.email, password: 'Str0ngPass!', coupon: renewCode })
  });
  ok('login with coupon in body -> 200, NO redemption', loginWithCoupon.status === 200 && loginWithCoupon.d?.ok === true && loginWithCoupon.d?.redeemed === undefined && loginWithCoupon.d?.redeemError === undefined, loginWithCoupon.d);
  const redeemAfter = await j('/api/billing/redeem', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${loginWithCoupon.d?.token}` },
    body: JSON.stringify({ code: renewCode })
  });
  ok('the code was NOT burned at login — redeemable afterwards', redeemAfter.status === 200 && redeemAfter.d?.ok === true && redeemAfter.d?.billing?.status === 'active', redeemAfter.d);

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

  console.log('== payload validation + quota (v18.9 hardening) ==');
  // Malformed payloads used to be stored verbatim; countSeats(CLIENTS:"x")
  // silently counted 0 seats and BYPASSED the plan quota.
  const badShape = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ rev: put.d?.rev, data: { v: 13, CLIENTS: 'x' } })
  });
  ok('PUT with CLIENTS:"x" -> 400 bad-payload', badShape.status === 400 && badShape.d?.error === 'bad-payload', badShape.d);
  const badClient = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ rev: put.d?.rev, data: { v: 13, CLIENTS: [{ name: 'no-id' }] } })
  });
  ok('PUT with a client missing id -> 400 bad-payload', badClient.status === 400 && badClient.d?.error === 'bad-payload', badClient.d);
  const badDB = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ rev: put.d?.rev, data: { v: 13, DB: [] } })
  });
  ok('PUT with DB as array -> 400 bad-payload', badDB.status === 400 && badDB.d?.error === 'bad-payload', badDB.d);

  // Trial plan caps at 5 seats. The quota check used to run ONLY for
  // authenticated PUTs — an anonymous student device holding the code could
  // push a 6-client payload straight past the cap. Now the OWNER's plan is
  // enforced for every writer.
  const six = { v: 13, CLIENTS: [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, name: 'C' + i, status: 'Active' })) };
  const coachOver = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ rev: put.d?.rev, data: six })
  });
  ok('coach PUT 6 clients on trial -> 402 quota-exceeded', coachOver.status === 402 && coachOver.d?.error === 'quota-exceeded', coachOver.d);
  const anonOver = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rev: put.d?.rev, data: six })
  });
  ok('anonymous PUT 6 clients -> 402 too (owner plan enforced)', anonOver.status === 402 && anonOver.d?.error === 'quota-exceeded', anonOver.d);
  // Shrinking is always allowed — even below the cap while over it.
  const shrink = await j(`/api/data?code=${ws}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ rev: put.d?.rev, data: { v: 13, CLIENTS: [{ id: 1, name: 'A', status: 'Active' }] } })
  });
  ok('PUT shrinking back to 1 client -> 200', shrink.status === 200 && shrink.d?.ok === true, shrink.d);

  console.log('== password change + session control (v18.9) ==');
  const pwEmail = signup.d?.coach?.email;
  // Second session (another "device") for the same coach.
  const login2 = await j('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: pwEmail, password: 'Str0ngPass!' })
  });
  ok('second device login -> 200', login2.status === 200 && !!login2.d?.token, login2.status);
  const wrongCur = await j('/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ current: 'WrongPass!1', password: 'NewStr0ngPass!' })
  });
  ok('password change with wrong current -> 403', wrongCur.status === 403 && wrongCur.d?.error === 'wrong-password', wrongCur.d);
  const weakPw = await j('/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ current: 'Str0ngPass!', password: 'short' })
  });
  ok('password change with weak new -> 400', weakPw.status === 400 && weakPw.d?.error === 'weak-password', weakPw.d);
  const pwChange = await j('/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signup.d?.token}` },
    body: JSON.stringify({ current: 'Str0ngPass!', password: 'NewStr0ngPass!' })
  });
  ok('password change -> 200', pwChange.status === 200 && pwChange.d?.ok === true, pwChange.d);
  const meAfterPw = await j('/api/auth/me', { headers: { authorization: `Bearer ${signup.d?.token}` } });
  ok('current session survives password change', meAfterPw.status === 200 && meAfterPw.d?.ok === true, meAfterPw.status);
  const meOther = await j('/api/auth/me', { headers: { authorization: `Bearer ${login2.d?.token}` } });
  ok('OTHER device session revoked by password change', meOther.status === 401, meOther.status);
  const loginOld = await j('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: pwEmail, password: 'Str0ngPass!' })
  });
  ok('login with OLD password after change -> 401', loginOld.status === 401, loginOld.status);
  const loginNew = await j('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: pwEmail, password: 'NewStr0ngPass!' })
  });
  ok('login with NEW password -> 200', loginNew.status === 200 && !!loginNew.d?.token, loginNew.status);
  // logout-others: sign in a third device, then revoke everything but caller.
  const login3 = await j('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: pwEmail, password: 'NewStr0ngPass!' })
  });
  const logoutOthers = await j('/api/auth/logout-others', {
    method: 'POST', headers: { authorization: `Bearer ${loginNew.d?.token}` }
  });
  ok('logout-others -> 200', logoutOthers.status === 200 && logoutOthers.d?.ok === true, logoutOthers.d);
  const meThird = await j('/api/auth/me', { headers: { authorization: `Bearer ${login3.d?.token}` } });
  ok('other device revoked by logout-others', meThird.status === 401, meThird.status);
  const meSelf = await j('/api/auth/me', { headers: { authorization: `Bearer ${loginNew.d?.token}` } });
  ok('caller session survives logout-others', meSelf.status === 200, meSelf.status);
  const noTokPw = await j('/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ current: 'x', password: 'y' })
  });
  ok('password change without token -> 401', noTokPw.status === 401, noTokPw.status);

  console.log('== static exposure (regression: secrets were downloadable) ==');
  for (const p of ['/data/prod-secrets.txt', '/data/prod-admin-pass.txt', '/data/kv-prod.json',
                   '/backend/lib/db.mjs', '/scripts/create-admin.mjs', '/data/sqlite.db',
                   '/server.mjs', '/package.json', '/vercel.json', '/.env', '/DEPLOY.md', '/SELFHOST.md',
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
