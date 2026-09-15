// Coach OS — create the MAIN ADMIN account directly in the backend KV store.
// Skips the public signup flow on purpose: the admin email must never be
// claimable by a stranger racing the signup form.
//
// Usage (PostgreSQL backend):
//   DATABASE_URL=postgres://... \
//   node ./scripts/create-admin.mjs admin@coachos.app 'S3cure!Pass' [Name]
//
// Usage (Netlify Blobs backend): same, but run via `netlify dev` so the
// NETLIFY_BLOBS_* credentials exist.
//
// Idempotent: refuses to overwrite an existing account unless --force is passed.
import { kv } from '../netlify/lib/db.mjs';
import { STORE_NAME, newId, hashPassword } from '../netlify/lib/saas.mjs';

const [, , emailArg = '', passArg = '', nameArg = ''] = process.argv;
const FORCE = process.argv.includes('--force');
const email = String(emailArg).trim().toLowerCase();
const password = String(passArg);
const name = String(nameArg || '').trim() || 'Main Admin';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
if (!EMAIL_RE.test(email)) { console.error('Usage: node ./scripts/create-admin.mjs <email> <password> [name]'); process.exit(1); }
if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

const st = kv(STORE_NAME);
const existing = await st.get(`acct:${email}`, { type: 'json' });
if (existing && !FORCE) {
  console.error(`Account ${email} already exists. Use --force to overwrite (keeps workspace).`);
  process.exit(2);
}

const id = existing?.id || newId('coach');
const acct = {
  id, email, name,
  pass: hashPassword(password),
  plan: 'club', workspaceId: existing?.workspaceId || null,
  role: 'admin',
  sub: { status: 'active', endsAt: 4102444800000, provider: 'seed', tracking: 'main-admin' },
  sub_status: 'active', sub_ends_at: 4102444800000, sub_started_at: Date.now(),
  trialEndsAt: 4102444800000,
  createdAt: existing?.createdAt || Date.now()
};

await st.setJSON(`acct:${email}`, acct);
await st.setJSON(`acct-by-id:${id}`, { email });
try {
  const idx = (await st.get('index:coaches', { type: 'json' })) || [];
  if (!idx.includes(id)) { idx.push(id); await st.setJSON('index:coaches', idx); }
} catch {}

// Re-issue a workspace if the account never claimed one (admin logs in via the app).
if (!acct.workspaceId) {
  const C = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += C[Math.floor(Math.random() * C.length)];
  const ws = { id: newId('ws'), owner: `coach:${id}`, code, plan: 'club', status: 'active', createdAt: Date.now(), claimedAt: null };
  await st.setJSON(`ws:${ws.id}`, ws);
  await st.setJSON(`ws-by-code:${code}`, { wid: ws.id });
  acct.workspaceId = ws.id;
  await st.setJSON(`acct:${email}`, acct);
  console.log(`Workspace code (shareable with clients): ${code}`);
}

console.log(`Main admin ready -> ${email} (role=admin, plan=club, ${existing ? (FORCE ? 'updated' : 'unchanged') : 'created'})`);
console.log('Now log in from the app with this email + password.');