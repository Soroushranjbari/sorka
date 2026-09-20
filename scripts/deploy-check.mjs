// Coach OS — deployment pre-flight check.
// Run before starting the server in a new environment:
//   node ./scripts/deploy-check.mjs
// Exits non-zero with a clear fix list when something is misconfigured.
// Safe to run repeatedly; never prints secret values.
import { existsSync, readFileSync } from 'node:fs';

const env = (k) => (process.env[k] || '').trim();
const has = (k) => env(k).length > 0;
const problems = [];
const warnings = [];
const info = [];

const title = (s) => console.log(`\n== ${s} ==`);

/* ---------- 1. KV backend ---------- */
title('KV backend');
const pgUrl = env('DATABASE_URL') || env('POSTGRES_URL') || env('PGURL');
if (pgUrl) {
  let host = '?';
  try { host = new URL(pgUrl).host; } catch {}
  info.push(`KV: PostgreSQL (${host})`);
  if (!/^postgres(ql)?:\/\//.test(pgUrl)) problems.push('DATABASE_URL must start with postgres:// or postgresql://');
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(pgUrl) && env('NODE_ENV') === 'production') {
    warnings.push('DATABASE_URL points at localhost in production — confirm this is intended');
  }
} else {
  // SQLite is the default backend — zero configuration needed.
  const sqlitePath = env('SQLITE_PATH') || (process.env.VERCEL ? '/tmp/coach-os.sqlite.db' : './data/sqlite.db');
  info.push(`KV: SQLite (${sqlitePath})`);
  if (existsSync(sqlitePath)) {
    try {
      const kb = Math.round(readFileSync(sqlitePath).length / 1024);
      info.push(`SQLite database exists (${kb} KB)`);
    } catch {}
  } else {
    info.push('SQLite database does not exist yet — it will be created on first write');
  }
  if (process.env.VERCEL) {
    warnings.push('SQLite on Vercel lives in /tmp and is EPHEMERAL — data resets on every cold start. Set DATABASE_URL for durable storage.');
  }
  if (has('KV_FILE')) warnings.push('KV_FILE is no longer used — the JSON-file backend was removed; data lives in SQLite now');
}

/* ---------- 2. Secrets ---------- */
title('Secrets & keys');
const apiKey = env('ADMIN_API_KEY');
if (apiKey) {
  if (apiKey.length < 24) problems.push(`ADMIN_API_KEY too short (${apiKey.length} chars) — generate with: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`);
  if (/^(test|local|dev|changeme|secret|key)/i.test(apiKey)) warnings.push('ADMIN_API_KEY looks like a placeholder — rotate before going live');
  info.push('ADMIN_API_KEY set (shop issue-coupon enabled)');
} else {
  warnings.push('ADMIN_API_KEY empty — /shop/api/checkout will fail (shop cannot issue coupons)');
}
if (has('RESET_DELIVERY') && env('RESET_DELIVERY').toLowerCase() === 'return') {
  if (env('NODE_ENV') === 'production' || env('PUBLIC_URL')) problems.push('RESET_DELIVERY=return leaks reset links in API responses — remove it in production (use RESEND_API_KEY instead)');
  else warnings.push('RESET_DELIVERY=return is dev-only — remember to remove for production');
}

/* ---------- 3. Admin & URLs ---------- */
title('Admin & URLs');
if (!has('ADMIN_EMAILS')) problems.push('ADMIN_EMAILS empty — nobody can reach the admin panel');
else info.push(`ADMIN_EMAILS: ${env('ADMIN_EMAILS').split(',').length} address(es)`);

const coachUrl = env('COACH_OS_URL');
if (coachUrl) {
  if (!/^https:\/\//.test(coachUrl) && !coachUrl.includes('localhost')) problems.push('COACH_OS_URL must be https:// in production (http only for localhost tests)');
  // A placeholder passes the https check but breaks every shop purchase at
  // runtime (checkout.mjs then fetches https://YOUR-SITE.netlify.app/...).
  if (/YOUR-SITE|your-site|example\.com|\.invalid|\.example|CHANGEME/i.test(coachUrl)) {
    problems.push(`COACH_OS_URL is still a placeholder (${coachUrl}) — set the real public app URL`);
  }
  if (/\/\/(localhost|127\.0\.0\.1)/.test(coachUrl)) {
    warnings.push('COACH_OS_URL points at localhost — the shop cannot reach the app from a browser');
  }
  info.push(`COACH_OS_URL: ${coachUrl}`);
} else {
  warnings.push('COACH_OS_URL empty — shop checkout cannot reach issue-coupon');
}

/* ---------- 4. Files ---------- */
title('Required files');
for (const f of ['index.html', 'server.mjs', 'backend/lib/saas.mjs', 'backend/handlers/auth.mjs', 'shop/checkout.html']) {
  if (existsSync(f)) info.push(`ok: ${f}`);
  else problems.push(`missing file: ${f}`);
}
if (existsSync('shop/index.html')) info.push('ok: shop/index.html');
else warnings.push('shop/index.html missing — /shop will 404 (copy the landing page there)');

/* ---------- 5. Report ---------- */
console.log('');
for (const i of info) console.log('  •', i);
if (warnings.length) {
  console.log('\n⚠ WARNINGS:');
  for (const w of warnings) console.log('  ⚠', w);
}
if (problems.length) {
  console.log('\n✗ PROBLEMS (fix before starting):');
  for (const p of problems) console.log('  ✗', p);
  console.log(`\nRESULT: ${problems.length} problem(s), ${warnings.length} warning(s) — NOT ready`);
  process.exit(1);
}
console.log(`\nRESULT: ready (${warnings.length} warning(s)) — you can start the server`);
