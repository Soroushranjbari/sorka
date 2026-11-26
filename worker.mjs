// CoachMint / FormaDock — Cloudflare Workers + Static Assets + D1 entrypoint.
//
// Dispatches all /api/* and /shop/api/* routes to the standard Web
// Request -> Response handlers in backend/handlers/*.mjs backed by Cloudflare D1
// (`env.DB`), blocks sensitive repository paths, rewrites SPA & /app.js paths,
// and delegates static assets to `env.ASSETS`.
import { setD1Database } from './backend/lib/db.mjs';
import { CSP, CSP_SHOP, secure } from './backend/lib/guard.mjs';

import authHandler from './backend/handlers/auth.mjs';
import billingHandler from './backend/handlers/billing.mjs';
import dataHandler from './backend/handlers/data.mjs';
import aiHandler from './backend/handlers/ai.mjs';
import pushHandler from './backend/handlers/push.mjs';
import exportHandler from './backend/handlers/export.mjs';
import stravaHandler from './backend/handlers/strava.mjs';
import healthHandler from './backend/handlers/health.mjs';
import mediaHandler from './backend/handlers/media.mjs';
import chatHandler from './backend/handlers/chat.mjs';
import shopCheckout from './backend/handlers/shop-checkout.mjs';
import shopAccount from './backend/handlers/shop-account.mjs';
import orgHandler from './backend/handlers/org.mjs';

const json = (status, obj) => secure(new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
}));

const DENY_DIRS = ['data/', 'db/', 'scripts/', 'backend/', 'node_modules/', 'api/', 'design/', 'plans/', '.kilo/', '_shots/'];
const DENY_FILES = new Set([
  'server.mjs', 'worker.mjs', 'wrangler.jsonc', 'vercel.json', 'middleware.js',
  'package.json', 'package-lock.json', '.env', '.env.example', '.gitignore',
  'skills-lock.json', '_headers', '.assetsignore', '.vercelignore'
]);
const DENY_EXT = ['.env', '.md', '.db', '.sqlite', '.sqlite3', '.wal', '.shm', '.log', '.key', '.pem', '.cjs'];

function isBlocked(pathname) {
  const rel = pathname.replace(/^\/+/, '').toLowerCase().split('/').map((s) => s.replace(/[. ]+$/, '')).join('/');
  if (!rel) return false;
  // Allow /.well-known/* (e.g., Digital Asset Links for Android TWA APK) while blocking all other dotfiles/dirs.
  if (rel.split('/').some((s, i) => s.startsWith('.') && !(i === 0 && s === '.well-known'))) return true;
  if (DENY_DIRS.some((d) => rel.startsWith(d))) return true;
  if (DENY_FILES.has(rel)) return true;
  return DENY_EXT.some((e) => rel.endsWith(e));
}

function syncEnvToProcess(env) {
  if (!env || typeof env !== 'object' || typeof process === 'undefined' || !process.env) return;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

function withTrueIp(req) {
  const h = new Headers(req.headers);
  const ip = (h.get('cf-connecting-ip') || h.get('x-real-ip') || '').trim() || 'local';
  h.set('x-true-ip', ip);
  return new Request(req, { headers: h });
}

async function serveRewrittenAsset(request, env, targetPath, { csp = null, noCache = true } = {}) {
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return json(500, { ok: false, error: 'assets-binding-missing' });
  }
  const u = new URL(request.url);
  u.pathname = targetPath;
  const assetReq = new Request(u.toString(), { method: request.method, headers: request.headers });
  const assetRes = await env.ASSETS.fetch(assetReq);
  const out = new Response(assetRes.body, assetRes);
  if (noCache) out.headers.set('cache-control', 'no-cache, no-store, must-revalidate');
  if (csp) out.headers.set('content-security-policy', csp);
  return secure(out);
}

const SPA_APP_PATHS = new Set(['/app', '/org', '/gym', '/club', '/coach', '/login']);
const SPA_APP_PREFIXES = ['/app/', '/org/', '/gym/', '/club/', '/coach/'];

export default {
  async fetch(request, env) {
    try {
      syncEnvToProcess(env);
      if (env?.DB) setD1Database(env.DB);

      const u = new URL(request.url);
      let pathname;
      try {
        pathname = decodeURIComponent(u.pathname);
      } catch {
        return new Response('Bad request', { status: 400 });
      }

      if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/shop/api/')) {
        const apiReq = withTrueIp(request);
        const clean = pathname.replace(/\/+$/, '');
        if (pathname.startsWith('/api/auth/')) return await authHandler(apiReq);
        if (pathname.startsWith('/api/billing/')) return await billingHandler(apiReq);
        if (pathname.startsWith('/api/ai/')) return await aiHandler(apiReq);
        if (pathname.startsWith('/api/push/')) return await pushHandler(apiReq);
        if (pathname.startsWith('/api/export/')) return await exportHandler(apiReq);
        if (pathname.startsWith('/api/strava/')) return await stravaHandler(apiReq);
        if (clean === '/api/org' || pathname.startsWith('/api/org/')) return await orgHandler(apiReq);
        if (clean === '/api/data') return await dataHandler(apiReq);
        if (clean === '/api/media' || pathname.startsWith('/api/media/')) return await mediaHandler(apiReq);
        if (pathname.startsWith('/api/chat/')) return await chatHandler(apiReq);
        if (clean === '/api/health') return await healthHandler(apiReq);
        if (clean === '/shop/api/checkout') return await shopCheckout(apiReq);
        if (clean === '/shop/api/account' || pathname.startsWith('/shop/api/account/')) return await shopAccount(apiReq);
        if (clean === '/shop/api/tracking-config') {
          const envVal = (k) => (typeof process !== 'undefined' && process.env && process.env[k] ? String(process.env[k]).trim() : '');
          return secure(new Response(JSON.stringify({
            ok: true,
            ga4Id: envVal('GA4_MEASUREMENT_ID'),
            adsId: envVal('GOOGLE_ADS_ID'),
            adsPurchaseLabel: envVal('GOOGLE_ADS_PURCHASE_LABEL'),
            metaPixelId: envVal('META_PIXEL_ID')
          }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
          }));
        }
        return json(404, { ok: false, error: 'not-found' });
      }

      if (isBlocked(pathname)) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }

      if (pathname === '/robots.txt') {
        const txt = [
          'User-agent: *',
          'Allow: /',
          'Allow: /app',
          'Allow: /shop',
          'Disallow: /api/',
          'Disallow: /shop/api/',
          'Disallow: /shop/account.html',
          'Disallow: /shop/checkout.html',
          `Sitemap: ${u.origin}/sitemap.xml`,
          ''
        ].join('\n');
        return secure(new Response(txt, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' }
        }));
      }
      if (pathname === '/sitemap.xml') {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${u.origin}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${u.origin}/app</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
`;
        return secure(new Response(xml, {
          status: 200,
          headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' }
        }));
      }
      if (pathname === '/app.js') {
        return await serveRewrittenAsset(request, env, '/client/app.js', { csp: CSP, noCache: true });
      }
      if (pathname === '/' || pathname === '/shop' || pathname === '/shop/') {
        return await serveRewrittenAsset(request, env, '/shop/index.html', { csp: CSP_SHOP, noCache: true });
      }
      if (SPA_APP_PATHS.has(pathname) || SPA_APP_PREFIXES.some((p) => pathname.startsWith(p))) {
        return await serveRewrittenAsset(request, env, '/index.html', { csp: CSP, noCache: true });
      }

      if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        return json(500, { ok: false, error: 'assets-binding-missing' });
      }
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error('[cloudflare-worker]', e);
      return json(500, { ok: false, error: 'internal-error' });
    }
  }
};
