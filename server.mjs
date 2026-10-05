// CoachMint — portable standalone server (zero dependencies beyond better-sqlite3, Node 18+).
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
//   /api/export/*  -> backend/handlers/export.mjs  (printable plan / PDF)
//   /shop/api/*    -> backend/handlers/shop-checkout.mjs | shop-account.mjs
//   everything else -> static files from the project root (index.html, ...)
import './backend/lib/env.mjs'; // loads .env FIRST — db.mjs reads env at module load
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP, CSP_SHOP, SECURITY_HEADERS } from './backend/lib/guard.mjs';
import { SQLITE_PATH } from './backend/lib/db.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const PORT = Number(process.env.PORT) || 8888;
/* Bind address — MUST stay platform-aware or PaaS deploys fail their port scan:
   Render/Railway/Fly/Heroku route traffic to the container and VERIFY the app
   listens on 0.0.0.0:$PORT during deploy; a loopback-only bind makes the
   health check time out and the deployment is marked failed. Locally (no
   platform signals) the safe default stays 127.0.0.1: plain HTTP on a public
   interface means every session token crosses the wire in the clear — put TLS
   in nginx/Caddy and proxy to loopback, or set HOST=0.0.0.0 on purpose. */
const PAAAS = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL ||
  process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME ||
  process.env.DYNO /* Heroku */ || process.env.WEBSITE_INSTANCE_ID /* Azure App Service */ ||
  process.env.K_SERVICE /* Cloud Run */);
const HOST = process.env.HOST || (PAAAS ? '0.0.0.0' : '127.0.0.1');
const LISTEN_LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/i.test(HOST);
const ROOT_REAL = await realpath(ROOT).catch(() => ROOT);

/* Who is allowed to name the client? A proxy we can actually reach only from
   loopback — or an explicit TRUST_PROXY. Without this rule any client can send
   its own X-Forwarded-For, get a fresh rate-limit bucket per request and switch
   off every limit in the app (login, signup, forgot-password, checkout, AI).
   Managed platforms (Render et al.) front the app with THEIR proxy and
   always connect from an internal address — trust them automatically, TRUST_PROXY
   can still override. */
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '') || PAAAS;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:127.0.1.1']);
const PEER_TRUSTABLE = TRUST_PROXY || LISTEN_LOOPBACK;
function clientIp(req) {
  const sock = (req.socket && req.socket.remoteAddress) || '';
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  if (PEER_TRUSTABLE && LOOPBACK.has(sock) && xff) return xff;
  return sock || 'local';
}

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
const pushFn = await import('./backend/handlers/push.mjs');
const exportFn = await import('./backend/handlers/export.mjs');
/* v18.103 — voice/media blobs live OUTSIDE the 5 MB workspace payload. */
const mediaFn = await import('./backend/handlers/media.mjs');
/* v18.108 — realtime chat stream (one long-lived SSE connection). */
const chatFn = await import('./backend/handlers/chat.mjs');

// Vercel maps "/api/auth/signup" -> handler URL "/api/auth/signup" (rewrite),
// so the handler sees the full path. Reproduce that here.
const ROUTES = [
  { re: /^\/api\/auth\/(.*)$/, fn: authFn.default },
  { re: /^\/api\/billing\/(.*)$/, fn: billingFn.default },
  { re: /^\/api\/ai\/(.*)$/, fn: aiFn.default },
  { re: /^\/api\/push\/(.*)$/, fn: pushFn.default },
  { re: /^\/api\/export\/(.*)$/, fn: exportFn.default },
  { re: /^\/api\/data\/?$/, fn: dataFn.default },
  { re: /^\/api\/media\/?/, fn: mediaFn.default },
  { re: /^\/api\/chat\/(.*)$/, fn: chatFn.default },
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
        // x-true-ip is OURS to set — overwrite any client-supplied copy so the
        // rate limiter in backend/lib/guard.mjs can never be steered by a header.
        headers: { ...req.headers, 'x-true-ip': clientIp(req) },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half'
      });
      const out = await r.fn(webReq);
      res.statusCode = out.status;
      out.headers.forEach((v, k) => { if (k !== 'content-length') res.setHeader(k, v); });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      /* v18.108 — SSE must never be buffered: frames have to leave as they are
         produced, or the client sees a burst once the connection closes.
         Returns before the content-length/copy path below. */
      if ((out.headers.get('content-type') || '').includes('text/event-stream') && out.body) {
        const reader = out.body.getReader();
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
        } catch { /* client disconnected mid-stream */ }
        res.end();
        return;
      }
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
  '.webmanifest': 'application/manifest+json',
  /* v18.17 — self-hosted MediaPipe form check: WASM must stream-compile with
     the right MIME; the .task model is a plain binary blob. */
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream'
};

/* Files that must never be served over HTTP: they hold credentials, the
   SQLite database with every password hash / session token, or build tooling.
   The Vercel middleware blocks the same paths before the filesystem
   (middleware.js). NOTE: ROOT = project root means without this an attacker
   can simply GET /data/prod-secrets.txt. */
const DENY_DIRS = ['data/', 'db/', 'scripts/', 'backend/', 'node_modules/', 'api/', 'design/', '.kilo/'];
const DENY_FILES = new Set([
  'server.mjs', 'vercel.json', 'middleware.js', 'package.json', 'package-lock.json',
  '.env', '.env.example', '.gitignore', 'skills-lock.json'
]);
const DENY_EXT = ['.env', '.md', '.db', '.sqlite', '.sqlite3', '.wal', '.shm', '.log', '.key', '.pem', '.cjs'];

/* A case-SENSITIVE deny-list on a case-INSENSITIVE filesystem is no deny-list:
   GET /.env answered 404 while GET /.ENV handed back the whole .env (DB URL,
   ADMIN_API_KEY, AI keys), /DATA/sqlite.db the database and /BACKEND/... sources.
   So: fold case, strip trailing dots/spaces (Win32 folds ".env." to ".env"),
   and deny every dot-file / dot-dir by default instead of chasing names. */
const isBlocked = (rel) => {
  const r = rel.toLowerCase().split('/').map((s) => s.replace(/[. ]+$/, '')).join('/');
  if (r.split('/').some((s) => s.startsWith('.'))) return true;
  if (DENY_DIRS.some((d) => r.startsWith(d))) return true;
  if (DENY_FILES.has(r)) return true;
  return DENY_EXT.some((e) => r.endsWith(e));
};

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
  // Belt and braces for case-insensitive filesystems: reject anything the OS
  // resolved under a DIFFERENT CASE than requested (/Index.HTML), and anything
  // that escapes ROOT through a symlink/junction. Comparison stays
  // case-insensitive so a legitimately case-different ROOT (OneDrive) is fine.
  const real = await realpath(file).catch(() => null);
  if (real) {
    if (!real.startsWith(ROOT_REAL + sep) && real !== ROOT_REAL) {
      res.statusCode = 404; res.end('not found'); return;
    }
    if (real !== file && real.toLowerCase() === file.toLowerCase()) {
      res.statusCode = 404; res.end('not found'); return;
    }
  }
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

server.listen(PORT, HOST, async () => {
  console.log(`CoachMint server → http://localhost:${PORT}`);
  const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGURL;
  console.log(`KV backend: ${pgUrl ? 'postgres' : `sqlite (${SQLITE_PATH})`}`);
  if (!pgUrl && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.warn('[deploy] production without DATABASE_URL — all accounts, sessions and student DATA live in one local sqlite file. Set DATABASE_URL and back this file up.');
  }
  /* Item 4 — automatic backups. The whole business lives in one SQLite file;
     without a backup a corrupt disk or a bad UPDATE is unrecoverable. A
     consistent snapshot is taken every 6h with SQLite's online backup API
     (safe while the server runs), kept under data/backups/ — the last
     DB_BACKUP_KEEP (default 14) copies survive, older ones are pruned. */
  if (!pgUrl) {
    try {
      const { join, dirname } = await import('node:path');
      const { mkdirSync, readdirSync, unlinkSync } = await import('node:fs');
      const KEEP = Number(process.env.DB_BACKUP_KEEP) || 14;
      const backupNow = async () => {
        try {
          const dir = join(dirname(SQLITE_PATH), 'backups');
          mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
          const target = join(dir, `coachmint-${stamp}.db`);
          const { default: Database } = await import('better-sqlite3');
          await new Database(SQLITE_PATH, { readonly: true }).backup(target);
          try {
            const files = readdirSync(dir).filter(f => /^coachmint-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse();
            for (const f of files.slice(KEEP)) { try { unlinkSync(join(dir, f)); } catch {} }
          } catch {}
        } catch (e) { console.error('[backup] failed:', e.message); }
      };
      setInterval(backupNow, 6 * 3600 * 1000).unref();
      setTimeout(backupNow, 60_000).unref();
      console.log(`[backup] automatic snapshots every 6h → data/backups/ (keep ${KEEP})`);
    } catch (e) { console.error('[backup] init failed:', e.message); }
  }
  if (!TRUST_PROXY && !LISTEN_LOOPBACK) {
    console.warn('[deploy] listening on a public interface with TRUST_PROXY unset: every client shares one rate-limit bucket ("' + HOST + '"). Put nginx/Caddy front and set TRUST_PROXY=1, or bind HOST=127.0.0.1.');
  }
  console.log(`[deploy] HOST=${HOST} · TRUST_PROXY=${TRUST_PROXY ? 'yes' : 'no'}${PAAAS ? ' · managed platform detected' : ''}`);
});
