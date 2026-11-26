// CoachMint / FormaDock — Cloudflare Worker + D1 end-to-end test suite.
// Simulates a real Cloudflare D1 database binding via in-memory SQLite and
// exercises worker.fetch(request, env) across API routes, D1 persistence,
// PBKDF2 100k limit, security blocklists, and static asset rewrites.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const memDb = new Database(':memory:');

// Minimal faithful D1Database mock backed by SQLite-in-memory so real SQL executes.
function makeMockD1(sqlite) {
  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...args) {
          params = args;
          return this;
        },
        async first() {
          const stmt = sqlite.prepare(sql);
          return stmt.get(...params) ?? null;
        },
        async run() {
          const stmt = sqlite.prepare(sql);
          const info = stmt.run(...params);
          return { success: true, meta: { changes: info.changes } };
        },
        async all() {
          const stmt = sqlite.prepare(sql);
          return { success: true, results: stmt.all(...params) };
        }
      };
    }
  };
}

let lastAssetUrl = '';
const mockAssets = {
  async fetch(req) {
    const u = new URL(req.url);
    lastAssetUrl = u.pathname + u.search;
    if (u.pathname === '/client/app.js') return new Response('// client app.js', { status: 200, headers: { 'content-type': 'text/javascript' } });
    if (u.pathname === '/shop/index.html') return new Response('<html>shop</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.pathname === '/index.html') return new Response('<html>app</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.pathname === '/.well-known/assetlinks.json') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('ok:' + u.pathname, { status: 200 });
  }
};

const { default: worker } = await import('../worker.mjs');
const { PBKDF2_ITERATIONS } = await import('../backend/lib/saas.mjs');

const env = {
  DB: makeMockD1(memDb),
  ASSETS: mockAssets,
  NODE_ENV: 'production',
  ADMIN_API_KEY: 'cf-test-admin-key',
  COACH_OS_URL: 'https://formadock.example'
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
};

async function call(path, { method = 'GET', body = null, headers = {} } = {}) {
  const h = new Headers(headers);
  if (body && !h.has('content-type')) h.set('content-type', 'application/json');
  const req = new Request(`https://formadock.example${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined
  });
  return worker.fetch(req, env);
}

try {
  console.log('== CLOUDFLARE WORKER + D1 TEST SUITE ==');

  // 1. Health reports D1
  const hRes = await call('/api/health');
  const hJson = await hRes.json();
  ok('GET /api/health -> 200', hRes.status === 200);
  ok('health reports backend=d1', hJson.backend === 'd1' && hJson.d1Configured === true, hJson);

  // 2. PBKDF2 iteration cap compliant with Cloudflare Workers runtime (<= 100,000)
  ok('PBKDF2_ITERATIONS <= 100000 for Cloudflare Workers', PBKDF2_ITERATIONS <= 100000, PBKDF2_ITERATIONS);

  // 3. Security blocklist
  for (const blocked of [
    '/backend/lib/db.mjs', '/BACKEND/lib/db.mjs', '/data/sqlite.db', '/.env', '/.ENV',
    '/server.mjs', '/worker.mjs', '/wrangler.jsonc', '/_headers', '/package.json', '/DEPLOY.md'
  ]) {
    const r = await call(blocked);
    ok(`blocked ${blocked} -> 404`, r.status === 404, r.status);
  }

  // 4. Static rewrites + .well-known TWA allowlist
  const appJsRes = await call('/app.js?v=20.04');
  ok('GET /app.js rewrites to /client/app.js -> 200', appJsRes.status === 200 && lastAssetUrl === '/client/app.js?v=20.04');
  ok('GET /app.js sets CSP header', !!appJsRes.headers.get('content-security-policy'));

  const rootRes = await call('/');
  ok('GET / rewrites to /shop/index.html -> 200', rootRes.status === 200 && lastAssetUrl === '/shop/index.html');
  ok('GET / sets CSP header', !!rootRes.headers.get('content-security-policy'));

  const appRes = await call('/app');
  ok('GET /app rewrites to /index.html -> 200', appRes.status === 200 && lastAssetUrl === '/index.html');

  const shopRes = await call('/shop');
  ok('GET /shop rewrites to /shop/index.html -> 200', shopRes.status === 200 && lastAssetUrl === '/shop/index.html');
  ok('GET /shop sets CSP header', !!shopRes.headers.get('content-security-policy'));

  const orgRes = await call('/org/dashboard');
  ok('GET /org/dashboard rewrites to /index.html -> 200', orgRes.status === 200 && lastAssetUrl === '/index.html');

  const robotsRes = await call('/robots.txt');
  const robotsTxt = await robotsRes.text();
  ok('GET /robots.txt -> 200 with dynamic Sitemap URL', robotsRes.status === 200 && robotsTxt.includes('Sitemap: https://formadock.example/sitemap.xml'), robotsTxt);

  const sitemapRes = await call('/sitemap.xml');
  const sitemapXml = await sitemapRes.text();
  ok('GET /sitemap.xml -> 200 with canonical origin URLs', sitemapRes.status === 200 && sitemapXml.includes('<loc>https://formadock.example/</loc>') && sitemapXml.includes('<loc>https://formadock.example/app</loc>'), sitemapXml);

  const wellKnownRes = await call('/.well-known/assetlinks.json');
  ok('GET /.well-known/assetlinks.json allowed -> 200', wellKnownRes.status === 200);

  // 5. Full E2E flow backed by D1: checkout -> signup -> login -> me -> data PUT/GET
  const email = 'cf_coach@example.com';
  const chkRes = await call('/shop/api/checkout', {
    method: 'POST',
    body: { planId: 'professional', email, name: 'Ali Coach', phone: '09121112233' },
    headers: { 'cf-connecting-ip': '203.0.113.10', 'x-true-ip': '1.2.3.4' }
  });
  const chkJson = await chkRes.json();
  ok('POST /shop/api/checkout -> 200 & issues real coupon', chkRes.status === 200 && chkJson.ok && !chkJson.demo && chkJson.coupons?.length === 1, chkJson);

  const coupon = chkJson.coupons[0];
  const suRes = await call('/shop/api/account/signup', {
    method: 'POST',
    body: { name: 'Ali Coach', email, password: 'StrongPassword123', coupon }
  });
  const suJson = await suRes.json();
  ok('POST /shop/api/account/signup redeems coupon on D1 -> 200', suRes.status === 200 && suJson.ok && suJson.redeemed === true && !!suJson.token, suJson);

  const loginRes = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPassword123' }
  });
  const loginJson = await loginRes.json();
  ok('POST /api/auth/login verifies PBKDF2 100k password on D1 -> 200', loginRes.status === 200 && loginJson.ok && !!loginJson.token, loginJson);

  const token = loginJson.token;
  const meRes = await call('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  const meJson = await meRes.json();
  ok('GET /api/auth/me reports active professional plan from D1', meRes.status === 200 && meJson.access?.status === 'active' && meJson.access?.plan === 'professional', meJson);

  const wsCode = meJson.workspace.code;
  const putRes = await call(`/api/data?code=${encodeURIComponent(wsCode)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: { rev: 0, data: { clients: [{ id: 1, name: 'Test Athlete' }], workouts: [] } }
  });
  const putJson = await putRes.json();
  ok('PUT /api/data stores workspace in D1 -> 200', putRes.status === 200 && putJson.ok && Number(putJson.rev) > 0, putJson);

  const getRes = await call(`/api/data?code=${encodeURIComponent(wsCode)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const getJson = await getRes.json();
  ok('GET /api/data reads stored client back from D1', getRes.status === 200 && getJson.data?.clients?.[0]?.name === 'Test Athlete', getJson);

  // Confirm D1 table actually holds rows cleanly
  const countRow = memDb.prepare('select count(*) as cnt from kv').get();
  ok('D1 kv table contains persisted rows', countRow.cnt >= 5, countRow);
  assert.ok(countRow.cnt >= 5);
} finally {
  memDb.close();
}

console.log(`CLOUDFLARE_D1: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
