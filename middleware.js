// CoachMint — Vercel Edge middleware.
//
// Vercel serves the repo root statically and filesystem matches win over
// rewrites, so sensitive repo files (SQLite database, scripts, server code,
// docs) would otherwise be PUBLICLY downloadable. Middleware runs BEFORE the
// filesystem, so a 404 here shadows the static file. The matcher keeps this
// middleware off every legitimate route (app shell, shop pages, /api/* functions).
export const config = {
  // Mirror server.mjs (isBlocked / DENY_DIRS / DENY_FILES): every path the
  // standalone server refuses to serve must also be refused here, otherwise
  // the same files are public on Vercel while 404-ing locally. design/ and
  // plans/ hold internal mockups and planning docs — never meant to be served.
  matcher: [
    '/data/:path*', '/backend/:path*', '/scripts/:path*', '/.kilo/:path*',
    '/design/:path*', '/plans/:path*', '/db/:path*', '/node_modules/:path*',
    '/server.mjs', '/package.json', '/package-lock.json', '/vercel.json',
    '/middleware.js', '/CLAUDE.md', '/.windsurfrules', '/skills-lock.json',
    '/.env', '/.env.example', '/.gitignore', '/DEPLOY.md', '/SELFHOST.md'
  ]
};

export default () => new Response('Not found', {
  status: 404,
  headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
});
