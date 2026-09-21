// CoachMint — Vercel Edge middleware.
//
// Vercel serves the repo root statically and filesystem matches win over
// rewrites, so sensitive repo files (SQLite database, scripts, server code,
// docs) would otherwise be PUBLICLY downloadable. Middleware runs BEFORE the
// filesystem, so a 404 here shadows the static file. The matcher keeps this
// middleware off every legitimate route (app shell, shop pages, /api/* functions).
export const config = {
  matcher: [
    '/data/:path*', '/backend/:path*', '/scripts/:path*', '/.kilo/:path*',
    '/server.mjs', '/package.json', '/package-lock.json', '/vercel.json',
    '/middleware.js', '/.env', '/.env.example', '/.gitignore', '/DEPLOY.md', '/SELFHOST.md'
  ]
};

export default () => new Response('Not found', {
  status: 404,
  headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
});
