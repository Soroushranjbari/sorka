// Coach OS — Phase 1 shared crypto + storage helpers (bundled, NOT a function).
// Lives in netlify/lib so Netlify does not deploy it as a function endpoint.
// PBKDF2 password hashing (SHA-256, 120k iterations) + opaque session tokens.
// Phase 2: accessOf() reads the authoritative sub_status/sub_ends_at fields
// (written by grantSub) with full backward-compat for legacy `sub` + trial.
// Layout in one KV namespace ("coach-os-saas"):
//   acct:<emailLower>      -> { id, email, name, pass:{salt,hash}, plan, sub_status, sub_ends_at, sub_started_at, sub, trialEndsAt, createdAt }
//   acct-by-id:<coachId>   -> { email }
//   sess:<token>           -> { coachId, email, createdAt, expiresAt }
//   ws:<workspaceId>       -> { id, owner, code, plan, status, createdAt, claimedAt }
//   ws-by-code:<CODE>      -> { wid }
//   ws-meta:<wid>          -> { rev, data, owner, code, updatedAt }
//   index:coaches          -> [coachId, ...]  (admin list, Phase-4)
import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

// Re-exported so handlers can do timing-safe secret comparisons.
export { timingSafeEqual };
import { kv } from './db.mjs';

export const STORE_NAME = 'coach-os-saas';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
export const CODE_RE = /^[A-Z0-9]{4,12}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const TRIAL_DAYS = 14;

export const store = () => kv(STORE_NAME);
export const legacyBlobs = () => kv('coach-os-workspaces');

export const j = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export const normEmail = (v) => String(v || '').trim().toLowerCase();
export const normCode = (v) => String(v || '').trim().toUpperCase();

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(9).toString('hex')}`;
}

export function newToken() {
  return 'co_' + randomBytes(24).toString('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, rec) {
  try {
    if (!rec || !rec.salt || !rec.hash) return false;
    const h = pbkdf2Sync(String(password), rec.salt, 120000, 32, 'sha256');
    const ref = Buffer.from(rec.hash, 'hex');
    if (h.length !== ref.length) return false;
    return timingSafeEqual(h, ref);
  } catch {
    return false;
  }
}

export function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

/** Resolve a session token -> { coachId, email } | null (also sweeps expiry). */
export async function sessionOf(st, token) {
  const t = String(token || '').trim();
  if (!t || t.length < 10) return null;
  const s = await st.get(`sess:${t}`, { type: 'json' });
  if (!s) return null;
  if (s.expiresAt && Date.now() > s.expiresAt) {
    try { await st.delete(`sess:${t}`); } catch {}
    return null;
  }
  return s;
}

export function bearerOf(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/* JSON body reading goes through guard.mjs readJsonCapped — every endpoint
   must parse request bodies under a hard size cap (the old uncapped
   readJson() here let a multi-megabyte body be buffered and parsed). */

/** Trial/subscription state -> { status:'trial'|'active'|'expired', plan }.
 *  Phase 2: prefers authoritative sub_status/sub_ends_at (grantSub), falls
 *  back to legacy `sub` + trialEndsAt so pre-Phase-2 accounts keep working. */
export function accessOf(acct) {
  const plan = acct?.plan || 'trial';
  const now = Date.now();
  if (acct?.sub_status === 'suspended') return { status: 'suspended', plan };
  if (acct?.sub_status === 'active' && acct?.sub_ends_at && now < acct.sub_ends_at) {
    return { status: 'active', plan };
  }
  const sub = acct?.sub || null;
  if (sub && sub.status === 'active' && (!sub.endsAt || now < sub.endsAt)) {
    return { status: 'active', plan };
  }
  if (acct?.trialEndsAt && now < acct.trialEndsAt) return { status: 'trial', plan };
  return { status: 'expired', plan };
}

/** Owner id that namespaces every blob key for a coach. */
export const ownerOf = (acct) => `coach:${acct.id}`;

/** Fetch account by id via the id->email pointer. */
export async function accountById(st, coachId) {
  const ptr = await st.get(`acct-by-id:${coachId}`, { type: 'json' });
  if (!ptr || !ptr.email) return null;
  return st.get(`acct:${String(ptr.email).toLowerCase()}`, { type: 'json' });
}
