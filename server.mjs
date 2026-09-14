// Coach OS — portable standalone server (zero dependencies, Node 18+).
// Serves the static app AND the same API handlers Netlify deploys, using
// standard Web Request/Response — no framework, no platform lock-in.
//
//   node server.mjs                       # http://localhost:8888
//   PORT=3000 node server.mjs             # custom port
//   KV_FILE=./data/kv.json node server.mjs  # file-backed KV (default)
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node server.mjs  # Supabase KV
//
// Routes (identical to the Netlify redirects in netlify.toml):
//   /api/auth/*    -> netlify/functions/auth.mjs
//   /api/billing/* -> netlify/functions/billing.mjs
//   /api/data      -> netlify/functions/data.mjs
//   /api/health    -> netlify/functions/health.mjs
//   everything else -> static files from the project root (index.html, ...)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP, SECURITY_HEADERS } from './netlify/lib/guard.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const PORT = Number(process.env.PORT) || 8888;
const HOST = process.env.HOST || '0.0.0.0';

/* ---------- API handlers (shared with the Netlify deployment) ---------- */
const authFn = await import('./netlify/functions/auth.mjs');
const billingFn = await import('./netlify/functions/billing.mjs');
const dataFn = await import('./netlify/functions/data.mjs');
const healthFn = await import('./netlify/functions/health.mjs');
const shopCheckoutFn = await import('./shop/api/checkout.mjs');

// Netlify maps "/api/auth/signup" -> handler URL "/api/auth/signup" (config.path
// with a wildcard), so the handler sees the full path. Reproduce that here.
const ROUTES = [
  { re: /^\/api\/auth\/(.*)$/, fn: authFn.default },
  { re: /^\/api\/billing\/(.*)$/, fn: billingFn.default },
  { re: /^\/api\/data\/?$/, fn: dataFn.default },
  { re: /^\/api\/health\/?$/, fn: healthFn.default },
  { re: /^\/shop\/api\/checkout\/?$/, fn: shopCheckoutFn.default }
];

async function handleApi(req, res, url) {
  const path = url.pathname;
  for (const r of ROUTES) {
    if (!r.re.test(path)) continue;
    try {
      // Handlers read `new URL(req.url)` — give them the absolute URL.
      const abs = new URL(path + url.search, `http://${req.headers.host || 'localhost'}`);
      const webReq = new Request(abs, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half'
      });
      const out = await r.fn(webReq);
      res.statusCode = out.status;
      out.headers.forEach((v, k) => { if (k !== 'content-length') res.setHeader(k, v); });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      const buf = out.body ? Buffer.from(await out.arrayBuffer()) : null;
      if (buf) res.setHeader('content-length', buf.length);
      res.end(buf || undefined);
    } catch (e) {
      console.error('[api]', path, e);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'server-error' }));
    }
    return true;
  }
  return false;
}

/* ---------- Static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405; res.end('method not allowed'); return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  // The shop landing page lives under /shop with a long filename — make /shop
  // and /shop/ resolve to it so links stay short.
  if (p === '/shop' || p === '/shop/') p = '/shop/index.html';
  // Resolve inside ROOT only (path traversal guard). ROOT has no trailing
  // separator here, so every allowed file is ROOT + sep + relative path.
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT + sep)) {
    res.statusCode = 403; res.end('forbidden'); return;
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // CSP on HTML documents (the app shell). Inline script/style is required
    // by the single-file architecture; everything else is locked down.
    if (extname(file).toLowerCase() === '.html') res.setHeader('content-security-policy', CSP);
    // index.html / sw.js / manifest must always be fresh (same as netlify.toml).
    if (['/index.html', '/sw.js', '/manifest.json'].includes(url.pathname)) {
      res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    }
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    // SPA fallback: unknown non-file paths get the app shell.
    if (!extname(p)) {
      try {
        const body = await readFile(join(ROOT, 'index.html'));
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
        res.end(body);
        return;
      } catch {}
    }
    res.statusCode = 404; res.end('not found');
  }
}

/* ---------- Server ---------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (await handleApi(req, res, url)) return;
  await serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  const { BACKEND } = import('./netlify/lib/db.mjs');
  console.log(`Coach OS server → http://localhost:${PORT}`);
  console.log(`KV backend: ${process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) ? 'supabase' : process.env.KV_FILE ? `file (${process.env.KV_FILE})` : 'blobs (needs Netlify credentials)'}`);
});
