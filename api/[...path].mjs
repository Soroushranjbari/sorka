// CoachMint — Vercel adapter (catch-all serverless function).
//
// The whole backend lives in backend/handlers/*.mjs as standard
// Request -> Response handlers. Vercel's Node runtime gives (req, res)
// instead, so this file is the ONLY Vercel-specific glue:
//
//   Node req  ->  standard Request  ->  existing handler  ->  Response  ->  Node res
//
// Routing (mirrors vercel.json's rewrites):
//   /api/auth/*            -> backend/handlers/auth.mjs
//   /api/billing/*         -> backend/handlers/billing.mjs
//   /api/ai/*              -> backend/handlers/ai.mjs
//   /api/data              -> backend/handlers/data.mjs
//   /api/health            -> backend/handlers/health.mjs
//   /shop/api/checkout     -> backend/handlers/shop-checkout.mjs   (via vercel.json rewrite)
//   /shop/api/account/*    -> backend/handlers/shop-account.mjs    (via vercel.json rewrite)
//
// vercel.json rewrites /shop/api/* to /api/shop/api/*, so the catch-all sees
// every route under one prefix: direct hits keep their /api/... path, shop
// rewrites carry the original /shop/api/... path after the /api prefix.
// Each handler parses new URL(req.url).pathname itself, so the synthetic
// Request must carry the PUBLIC path the handler expects.
import authHandler from '../backend/handlers/auth.mjs';
import billingHandler from '../backend/handlers/billing.mjs';
import dataHandler from '../backend/handlers/data.mjs';
import aiHandler from '../backend/handlers/ai.mjs';
import pushHandler from '../backend/handlers/push.mjs';
import healthHandler from '../backend/handlers/health.mjs';
import shopCheckout from '../backend/handlers/shop-checkout.mjs';
import shopAccount from '../backend/handlers/shop-account.mjs';

/* Hop-by-hop / framing headers must NOT be copied onto the synthetic Request —
   undici sets its own and a stale content-length makes it throw. */
const SKIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'accept-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'
]);

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
};

/** Rebuild the PUBLIC URL the handler expects.
 *  Direct hit   /api/auth/login          -> /api/auth/login
 *  Shop rewrite /api/shop/api/checkout   -> /shop/api/checkout        */
function handlerUrl(req) {
  const u = new URL(req.url || '/', 'http://localhost');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const inner = u.pathname.replace(/^\/api\/?/, '');
  const path = inner.startsWith('shop/api/') ? u.pathname.replace(/^\/api/, '') : u.pathname;
  return `${proto}://${host}${path}${u.search}`;
}

async function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (SKIP_HEADERS.has(k)) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  const method = (req.method || 'GET').toUpperCase();
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (buf.length) body = buf;
  }
  return new Request(handlerUrl(req), { method, headers, body, ...(body ? { duplex: 'half' } : {}) });
}

async function sendResponse(webRes, res) {
  const headers = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  // Set-Cookie may repeat — writeHead needs the array form to emit all of them.
  if (typeof webRes.headers.getSetCookie === 'function') {
    const sc = webRes.headers.getSetCookie();
    if (sc.length) headers['set-cookie'] = sc;
  }
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.writeHead(webRes.status, headers);
  res.end(buf);
}

export default async function handler(req, res) {
  try {
    // Storage on Vercel: the default SQLite backend writes to /tmp there
    // (the deploy dir is read-only), which works but is EPHEMERAL — every
    // cold start starts from an empty database. For durable data on Vercel
    // set DATABASE_URL (Neon/Postgres); db.mjs then uses the kv_store table
    // and auto-creates it on first use.
    const inner = new URL(req.url || '/', 'http://localhost').pathname.replace(/^\/api\/?/, '');
    const webReq = await toWebRequest(req);
    let out;
    if (inner.startsWith('auth/')) out = await authHandler(webReq);
    else if (inner.startsWith('billing/')) out = await billingHandler(webReq);
    else if (inner.startsWith('ai/')) out = await aiHandler(webReq);
    else if (inner.startsWith('push/')) out = await pushHandler(webReq);
    else if (inner === 'data') out = await dataHandler(webReq);
    else if (inner === 'health') out = await healthHandler(webReq);
    else if (inner === 'shop/api/checkout') out = await shopCheckout(webReq);
    else if (inner.startsWith('shop/api/account/')) out = await shopAccount(webReq);
    else return json(res, 404, { ok: false, error: 'not-found' });
    await sendResponse(out, res);
  } catch (e) {
    console.error('[vercel-adapter]', e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal-error' });
    else res.end();
  }
}
