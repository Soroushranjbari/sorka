// CoachMint — Phase 1 shared crypto + storage helpers (bundled, NOT a function).
// Lives in backend/lib so it is never deployed as a function endpoint.
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
import { withLock } from './guard.mjs';

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

/** Lightweight in-record audit trail (last 50 entries) for B2B data governance.
    Lives inside the org blob so it needs no extra keys and is returned with
    GET /api/org/me. pushAudit only mutates the in-memory org — the caller's
    following st.setJSON('org:<id>') persists it. */
export function pushAudit(org, action, detail = '') {
  if (!org || typeof org !== 'object') return;
  org.audit = [
    ...(org.audit || []),
    { at: Date.now(), action: String(action || '').slice(0, 40), detail: String(detail || '').slice(0, 120) }
  ].slice(-50);
}

/** Organization (Gym / Club) Management */
export async function createOrg(st, { ownerCoachId, ownerEmail, name, primaryBranchName, planId }) {
  const orgId = newId('org');
  const org = {
    id: orgId,
    name: String(name || 'Gym Workspace').trim(),
    ownerCoachId,
    ownerEmail: normEmail(ownerEmail),
    plan: planId || 'gym_studio',
    status: 'active',
    createdAt: Date.now(),
    branches: [
      { id: 'br_hq', name: String(primaryBranchName || 'Main Branch (HQ)').trim(), isHQ: true, createdAt: Date.now() }
    ],
    staff: [
      { coachId: ownerCoachId, email: normEmail(ownerEmail), role: 'gym_owner', branches: ['*'], addedAt: Date.now() }
    ]
  };
  pushAudit(org, 'org.create', org.name);
  await st.setJSON(`org:${orgId}`, org);
  await st.setJSON(`org-by-coach:${ownerCoachId}`, { orgId, role: 'gym_owner', branches: ['*'] });
  if (ownerEmail) {
    await st.setJSON(`org-by-email:${normEmail(ownerEmail)}`, { orgId, role: 'gym_owner', branches: ['*'] });
  }
  return org;
}

export async function getOrg(st, orgId) {
  if (!orgId) return null;
  return st.get(`org:${orgId}`, { type: 'json' });
}

export async function getOrgByCoach(st, coachId, email = null) {
  if (!coachId && !email) return null;
  const emailL = email ? normEmail(email) : null;
  let ptr = coachId ? await st.get(`org-by-coach:${coachId}`, { type: 'json' }) : null;
  if (!ptr && emailL) {
    ptr = await st.get(`org-by-email:${emailL}`, { type: 'json' });
    if (ptr && coachId) {
      // Pointer backfill is an idempotent same-value write — safe to race.
      await st.setJSON(`org-by-coach:${coachId}`, ptr);
    }
  }
  if (!ptr || !ptr.orgId) return null;
  const org = await getOrg(st, ptr.orgId);
  if (!org) return null;
  /* v-fix (CR-1) — the pointer is only an index; org.staff is authoritative.
     A removed staff member's stale pointer (org-by-email was never cleaned)
     used to keep FULL data + management access alive after offboarding:
     data.mjs isOrgMember trusted it and the role ptr still carried the old
     role. Validate membership here and self-heal the stale pointers. */
  const member = (org.staff || []).find((s) => s && ((coachId && s.coachId === coachId) || (emailL && s.email === emailL)));
  if (!member) {
    try { if (coachId) await st.delete(`org-by-coach:${coachId}`); } catch {}
    try { if (emailL) await st.delete(`org-by-email:${emailL}`); } catch {}
    return null;
  }
  // Reconcile the real signed-up coachId into the staff record (the invite may
  // predate the coach's account). Locked read-modify-write so a concurrent
  // addOrgStaff on the same org blob cannot be lost (v-fix HI-4).
  if (coachId && member.coachId !== coachId) {
    await withLock(`org:${org.id}`, async () => {
      const fresh = await getOrg(st, org.id);
      const m = fresh && (fresh.staff || []).find((s) => s && (emailL ? s.email === emailL : s.coachId === coachId));
      if (fresh && m && m.coachId !== coachId) {
        m.coachId = coachId;
        await st.setJSON(`org:${fresh.id}`, fresh);
      }
    });
  }
  return { org, staffRecord: { orgId: org.id, role: member.role || 'trainer', branches: member.branches || ['*'] } };
}

export async function addOrgBranch(st, orgId, { name, address, phone, isHQ = false }, maxBranches = 5) {
  const org = await getOrg(st, orgId);
  if (!org) return { ok: false, error: 'org-not-found' };
  if ((org.branches || []).length >= maxBranches) {
    return { ok: false, error: 'branch-quota-exceeded', max: maxBranches };
  }
  if (isHQ) {
    (org.branches || []).forEach((b) => { b.isHQ = false; });
  }
  const branchId = newId('br');
  const branch = {
    id: branchId,
    name: String(name || 'Branch').trim(),
    address: String(address || '').trim(),
    phone: String(phone || '').trim(),
    isHQ: !!isHQ,
    createdAt: Date.now()
  };
  org.branches = [...(org.branches || []), branch];
  await st.setJSON(`org:${orgId}`, org);
  return { ok: true, branch, org };
}

export async function addOrgStaff(st, orgId, { coachId, email, name, role = 'trainer', branches = ['*'] }, maxCoaches = 5) {
  const org = await getOrg(st, orgId);
  if (!org) return { ok: false, error: 'org-not-found' };
  const currentCoaches = (org.staff || []).filter((s) => s.role !== 'reception').length;
  if (role !== 'reception' && currentCoaches >= maxCoaches) {
    return { ok: false, error: 'coach-quota-exceeded', max: maxCoaches };
  }
  const existing = (org.staff || []).find((s) => (coachId && s.coachId === coachId) || s.email === normEmail(email));
  if (existing) {
    return { ok: false, error: 'staff-already-exists' };
  }
  const staffMember = {
    coachId,
    email: normEmail(email),
    name: String(name || '').trim(),
    role,
    branches: Array.isArray(branches) ? branches : ['*'],
    addedAt: Date.now()
  };
  org.staff = [...(org.staff || []), staffMember];
  await st.setJSON(`org:${orgId}`, org);
  if (coachId) await st.setJSON(`org-by-coach:${coachId}`, { orgId, role, branches: staffMember.branches });
  if (email) await st.setJSON(`org-by-email:${normEmail(email)}`, { orgId, role, branches: staffMember.branches });
  return { ok: true, staffMember, org };
}

export async function removeOrgStaff(st, orgId, coachId) {
  const org = await getOrg(st, orgId);
  if (!org) return { ok: false, error: 'org-not-found' };
  if (org.ownerCoachId === coachId) {
    return { ok: false, error: 'cannot-remove-owner' };
  }
  org.staff = (org.staff || []).filter((s) => s.coachId !== coachId);
  await st.setJSON(`org:${orgId}`, org);
  try { await st.delete(`org-by-coach:${coachId}`); } catch {}
  return { ok: true, org };
}

export function reassignOrgClients(clientsList, { clientIds, toCoachId, toBranchId }) {
  if (!Array.isArray(clientsList) || !Array.isArray(clientIds) || !toCoachId) return clientsList || [];
  const set = new Set(clientIds.map(String));
  return clientsList.map((c) => {
    if (!c || !set.has(String(c.id))) return c;
    const updated = { ...c, assignedCoachId: toCoachId };
    if (toBranchId) updated.branchId = toBranchId;
    return updated;
  });
}

export async function addOrgMachine(st, orgId, { code, name, nameFa, branchId, ex, brand, adjustments, cues }) {
  const org = await getOrg(st, orgId);
  if (!org) return { ok: false, error: 'org-not-found' };
  const machineId = newId('mach');
  const cleanAdj = typeof adjustments === 'object' && adjustments !== null
    ? JSON.stringify(adjustments)
    : String(adjustments || '').trim();
  const machine = {
    id: machineId,
    code: String(code || '').toUpperCase().trim(),
    name: String(name || 'Gym Machine').trim(),
    nameFa: String(nameFa || name || 'دستگاه باشگاه').trim(),
    brand: String(brand || '').trim(),
    branchId: branchId || (org.branches && org.branches[0] ? org.branches[0].id : 'br_hq'),
    ex: String(ex || '').trim(),
    adjustments: cleanAdj,
    cues: String(cues || '').trim(),
    createdAt: Date.now()
  };
  org.machines = [...(org.machines || []), machine];
  await st.setJSON(`org:${orgId}`, org);
  return { ok: true, machine, org };
}

export async function removeOrgMachine(st, orgId, machineId) {
  const org = await getOrg(st, orgId);
  if (!org) return { ok: false, error: 'org-not-found' };
  org.machines = (org.machines || []).filter((m) => m.id !== machineId);
  await st.setJSON(`org:${orgId}`, org);
  return { ok: true, org };
}

