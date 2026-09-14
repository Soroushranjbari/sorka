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
const supa = has('SUPABASE_URL') && (has('SUPABASE_SERVICE_KEY') || has('SUPABASE_SERVICE_ROLE_KEY'));
const file = has('KV_FILE');
if (supa) {
  info.push(`KV: Supabase (${env('SUPABASE_URL')})`);
  if (!env('SUPABASE_URL').startsWith('https://')) problems.push('SUPABASE_URL must start with https://');
  if (env('SUPABASE_SERVICE_KEY', ) === env('SUPABASE_ANON_KEY')) problems.push('SUPABASE_SERVICE_KEY looks like the anon key — use service_role (server-only)');
} else if (file) {
  info.push(`KV: file (${env('KV_FILE')})`);
  if (existsSync(env('KV_FILE'))) {
    try {
      const kb = Math.round(readFileSync(env('KV_FILE')).length / 1024);
      info.push(`KV file exists (${kb} KB)`);
      if (kb > 0 && env('NODE_ENV') === 'production' && !has('ALLOW_EXISTING_KV')) {
        warnings.push('KV file already has data — confirm this is the right server (set ALLOW_EXISTING_KV=1 to silence)');
      }
    } catch {}
  } else {
    info.push('KV file does not exist yet — it will be created on first write');
  }
  if (env('KV_FILE').includes(' ')) warnings.push('KV_FILE path contains spaces — quoted paths required in service files');
} else {
  problems.push('No KV backend configured. Set KV_FILE=/path/kv.json (single server) or SUPABASE_URL + SUPABASE_SERVICE_KEY (multi-instance).');
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
  info.push(`COACH_OS_URL: ${coachUrl}`);
} else {
  warnings.push('COACH_OS_URL empty — shop checkout cannot reach issue-coupon');
}

/* ---------- 4. Files ---------- */
title('Required files');
for (const f of ['index.html', 'server.mjs', 'netlify/lib/saas.mjs', 'netlify/functions/auth.mjs', 'shop/checkout.html']) {
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
