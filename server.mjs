// Coach OS — portable standalone server (zero dependencies beyond better-sqlite3, Node 18+).
// Serves the static app AND the same API handlers Vercel deploys, using
// standard Web Request/Response — no framework, no platform lock-in.
//
//   node server.mjs                       # http://localhost:8888 (SQLite ./data/sqlite.db)
//   PORT=3000 node server.mjs             # custom port
//   SQLITE_PATH=/path/db.sqlite node server.mjs  # custom SQLite location
//   DATABASE_URL=postgres://... node server.mjs  # PostgreSQL KV instead of SQLite
//
// Routes (identical to the Vercel rewrites in vercel.json):
//   /api/auth/*    -> backend/handlers/auth.mjs
//   /api/billing/* -> backend/handlers/billing.mjs
//   /api/data      -> backend/handlers/data.mjs
//   /api/health    -> backend/handlers/health.mjs
//   /shop/api/*    -> backend/handlers/shop-checkout.mjs | shop-account.mjs
//   everything else -> static files from the project root (index.html, ...)
import './backend/lib/env.mjs'; // loads .env FIRST — db.mjs reads env at module load
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP, CSP_SHOP, SECURITY_HEADERS } from './backend/lib/guard.mjs';
import { SQLITE_PATH } from './backend/lib/db.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const PORT = Number(process.env.PORT) || 8888;
const HOST = process.env.HOST || '0.0.0.0';

/* Storage: SQLite at ./data/sqlite.db is the DEFAULT — no env needed. An
   explicit SQLITE_PATH moves the file; DATABASE_URL (or POSTGRES_URL/PGURL)
   switches the KV layer to PostgreSQL instead. backend/lib/db.mjs reads the
   environment at module load, and the .env import above has already run. */

/* ---------- API handlers (shared with the Vercel deployment) ---------- */
const authFn = await import('./backend/handlers/auth.mjs');
const billingFn = await import('./backend/handlers/billing.mjs');
const dataFn = await import('./backend/handlers/data.mjs');
const healthFn = await import('./backend/handlers/health.mjs');
const shopCheckoutFn = await import('./backend/handlers/shop-checkout.mjs');
const shopAccountFn = await import('./backend/handlers/shop-account.mjs');
const aiFn = await import('./backend/handlers/ai.mjs');

// Vercel maps "/api/auth/signup" -> handler URL "/api/auth/signup" (rewrite),
// so the handler sees the full path. Reproduce that here.
const ROUTES = [
  { re: /^\/api\/auth\/(.*)$/, fn: authFn.default },
  { re: /^\/api\/billing\/(.*)$/, fn: billingFn.default },
  { re: /^\/api\/ai\/(.*)$/, fn: aiFn.default },
  { re: /^\/api\/data\/?$/, fn: dataFn.default },
  { re: /^\/api\/health\/?$/, fn: healthFn.default },
  { re: /^\/shop\/api\/checkout\/?$/, fn: shopCheckoutFn.default },
  { re: /^\/shop\/api\/account\/(.*)$/, fn: shopAccountFn.default }
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

/* Files that must never be served over HTTP: they hold credentials, the
   SQLite database with every password hash / session token, or build tooling.
   The Vercel middleware blocks the same paths before the filesystem
   (middleware.js). NOTE: ROOT = project root means without this an attacker
   can simply GET /data/prod-secrets.txt. */
const DENY_DIRS = ['data/', 'db/', 'scripts/', 'backend/', 'node_modules/', '.git/', '.kilo/'];
const DENY_FILES = new Set([
  'server.mjs', 'vercel.json', 'middleware.js', 'package.json', 'package-lock.json',
  '.env', '.env.example', '.gitignore', 'DEPLOY.md', 'SELFHOST.md'
]);
const isBlocked = (rel) =>
  DENY_DIRS.some((d) => rel.startsWith(d)) || DENY_FILES.has(rel) || rel.endsWith('.md');

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405; res.end('method not allowed'); return;
  }
  // Malformed percent-encoding (e.g. GET /%) makes decodeURIComponent throw a
  // URIError. Uncaught, that rejects the async handler promise and — being an
  // unhandled rejection on Node >= 15 — kills the whole process. Answer 400.
  let p;
  try { p = decodeURIComponent(url.pathname); }
  catch { res.statusCode = 400; res.end('bad request'); return; }
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
  // Works on both path separators: the deny-lists are written POSIX-style.
  const rel = file.slice(ROOT.length + 1).split(sep).join('/');
  if (isBlocked(rel)) { res.statusCode = 404; res.end('not found'); return; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // CSP on HTML documents. The shop landing page legitimately loads fonts and
    // three.js from CDNs, so it gets its own (wider) policy — the app shell's
    // strict 'self'-only policy silently blocked them.
    if (ext === '.html') {
      res.setHeader('content-security-policy', rel.startsWith('shop/') ? CSP_SHOP : CSP);
    }
    // index.html / sw.js / manifest must always be fresh (same as netlify.toml).
    // Keyed off the RESOLVED file, not url.pathname — otherwise a request to "/"
    // (which maps to index.html) skipped the no-cache header entirely.
    if (['index.html', 'sw.js', 'manifest.json'].includes(rel)) {
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
        res.setHeader('content-security-policy', CSP);
        res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      } catch {}
    }
    res.statusCode = 404; res.end('not found');
  }
}

/* ---------- Server ---------- */
const server = createServer(async (req, res) => {
  // Last-resort guard: an exception here would otherwise become an unhandled
  // rejection and take the whole server down (Node >= 15 default behaviour).
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await handleApi(req, res, url)) return;
    await serveStatic(req, res, url);
  } catch (e) {
    console.error('[server]', req.method, req.url, e);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Coach OS server → http://localhost:${PORT}`);
  const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGURL;
  console.log(`KV backend: ${pgUrl ? 'postgres' : `sqlite (${SQLITE_PATH})`}`);
});
