// Coach OS — Vercel Edge middleware.
//
// Vercel serves the repo root statically and filesystem matches win over
// rewrites, so sensitive repo files (db dumps, scripts, server code, docs)
// would otherwise be PUBLICLY downloadable — the exact hole netlify.toml's
// force-404 redirects close on Netlify. Middleware runs BEFORE the filesystem,
// so a 404 here shadows the static file. The matcher keeps this middleware off
// every legitimate route (app shell, shop pages, /api/* functions).
export const config = {
  matcher: [
    '/data/:path*', '/db/:path*', '/scripts/:path*', '/netlify/:path*', '/.kilo/:path*',
    '/server.mjs', '/package.json', '/package-lock.json', '/netlify.toml', '/vercel.json',
    '/middleware.js', '/.env', '/.env.example', '/.gitignore', '/DEPLOY.md', '/SELFHOST.md'
  ]
};

export default () => new Response('Not found', {
  status: 404,
  headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
});
