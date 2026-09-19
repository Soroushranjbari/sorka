// Coach OS — sanitize a KV dump whose secrets were published.
//
// WHY THIS EXISTS
//   data/kv-prod.json / data/kv.json / db/schema.sql were committed to a PUBLIC
//   GitHub repository. They contain, in clear text:
//     * 22 `sess:<token>` entries  — the session token is part of the KEY, and
//       every one of them was still inside its 30-day validity window
//     * `acct:<email>.pass = {salt,hash}` for every account (offline-crackable)
//     * `coupon:<CODE>` entries that anyone could redeem
//   Untracking the files is not an option here, so the credentials themselves
//   have to become worthless.
//
// WHAT IT DOES
//   1. Drops every session entry (sess:* and sess-idx:*). Sessions are
//      transient — affected users simply sign in again.
//   2. Replaces each account's password hash with a hash of a NEW random
//      password and writes the new passwords to a local file (gitignored).
//   3. Deactivates every coupon code (isActive:false) so leaked codes cannot
//      be redeemed. Re-issue fresh codes from the admin panel if needed.
//   Everything else (clients, workouts, plans, measurements, orders) is
//   preserved byte-for-byte.
//
// USAGE
//   node ./scripts/sanitize-kv-dump.mjs                     # dry-run (default)
//   node ./scripts/sanitize-kv-dump.mjs --apply             # rewrite the file
//   node ./scripts/sanitize-kv-dump.mjs --apply --file data/kv.json
//   node ./scripts/sanitize-kv-dump.mjs --apply --no-passwords
//
// Exit codes: 0 = ok (or nothing to do), 1 = bad input.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes, pbkdf2Sync } from 'node:crypto';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const WITH_PASSWORDS = !argv.includes('--no-passwords');
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const file = flag('--file', 'data/kv-prod.json');
const passOut = flag('--passwords-out', 'data/rotated-pass.txt');

/* ---------- helpers (mirror netlify/lib/saas.mjs so hashes stay compatible) */
const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
};

// Human-transcribable but strong (no 0/O/1/l/I). 20 chars ≈ 96 bits.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const newPassword = (len = 20) => {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
};

/* ---------- load ---------- */
let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Cannot read KV file ${file}: ${e.message}`);
  process.exit(1);
}
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  console.error(`${file} is not a KV JSON object ({ "<ns>:<key>": value, ... }).`);
  process.exit(1);
}

/* ---------- plan ---------- */
const sessionKeys = [];
const sessIdxKeys = [];
const acctKeys = [];
const couponKeys = [];

for (const key of Object.keys(data)) {
  // "<ns>:<key>" — the namespace is the first segment, the rest is the KV key.
  const rest = key.slice(key.indexOf(':') + 1);
  if (rest.startsWith('sess-idx:')) sessIdxKeys.push(key);
  else if (rest.startsWith('sess:')) sessionKeys.push(key);
  else if (rest.startsWith('acct:')) acctKeys.push(key);
  else if (rest.startsWith('coupon:')) couponKeys.push(key);
}

const accounts = acctKeys.filter((k) => data[k] && typeof data[k] === 'object' && data[k].pass);
const coupons = couponKeys.filter((k) => data[k] && typeof data[k] === 'object' && data[k].isActive !== false);

console.log(`\n== ${file} ==`);
console.log(`keys total        : ${Object.keys(data).length}`);
console.log(`session tokens    : ${sessionKeys.length}  -> DELETE (token is in the key name)`);
console.log(`session indexes   : ${sessIdxKeys.length}  -> DELETE (they list the tokens)`);
console.log(`accounts w/ pass  : ${accounts.length}  -> ${WITH_PASSWORDS ? 'REPLACE hash with a new random password' : 'left unchanged (--no-passwords)'}`);
console.log(`active coupons    : ${coupons.length}  -> deactivate (isActive:false)`);

if (accounts.length && WITH_PASSWORDS) {
  console.log('\nAccounts getting a new password:');
  for (const k of accounts) console.log(`  - ${String(data[k].email || k).replace(/^.*:acct:/, '')}`);
}

if (!sessionKeys.length && !sessIdxKeys.length && !accounts.length && !coupons.length) {
  console.log('\nNothing to sanitize — this file holds no leaked credentials.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to rewrite the file.');
  process.exit(0);
}

/* ---------- apply ---------- */
for (const k of sessionKeys) delete data[k];
for (const k of sessIdxKeys) delete data[k];

const rotated = [];
if (WITH_PASSWORDS) {
  for (const k of accounts) {
    const email = String(data[k].email || k.replace(/^.*:acct:/, ''));
    const pw = newPassword();
    data[k].pass = hashPassword(pw);
    data[k].pwChangedAt = Date.now();
    rotated.push([email, pw]);
  }
}

for (const k of coupons) data[k].isActive = false;

// Atomic write (tmp + rename) so a crash cannot leave a truncated KV file.
const tmp = `${file}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(data));
renameSync(tmp, file);

if (rotated.length) {
  const header =
    '# Coach OS — new passwords generated by scripts/sanitize-kv-dump.mjs\n' +
    `# Generated: ${new Date().toISOString()}\n` +
    '# The previous hashes were published in a public Git repository and are dead.\n' +
    '# Hand each password to its owner, then DELETE this file.\n\n';
  writeFileSync(passOut, header + rotated.map(([e, p]) => `${e}\t${p}`).join('\n') + '\n');
}

console.log('\nDONE — file rewritten.');
console.log(`  sessions removed : ${sessionKeys.length + sessIdxKeys.length}`);
if (rotated.length) {
  console.log(`  passwords rotated: ${rotated.length}  -> written to ${passOut}`);
  console.log('  ⚠️  hand the new passwords out, then DELETE that file.');
}
console.log(`  coupons disabled : ${coupons.length}`);
console.log('\nNext: regenerate the SQL dump so db/schema.sql stops carrying them:');
console.log(`  npm run db:dump`);
