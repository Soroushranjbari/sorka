// Coach OS — Phase 2 Billing API (simulated payments, server-authoritative).
//   GET  /api/billing/me      (Bearer) -> {ok, billing:{status,plan,...}, quota:{used,max,plan}, plans:[...]}
//   POST /api/billing/redeem  (Bearer, {code}) -> {ok, billing, quota} | 400/404/409/410
//   POST /api/billing/request (Bearer, {planId}) -> {ok, payment:{id,planId,amount,...}} (manual flow)
//   POST /api/billing/coupon  (Bearer admin, {code,planId,durationDays,maxUses,expiresInDays}) -> {ok, coupon}
//   GET  /api/billing/admin-overview (Bearer admin) -> {ok, coaches:[...]}  (ADMIN_EMAILS)
//   POST /api/billing/admin-grant    (Bearer admin, {email|id, planId, days}) -> grant/extend sub
//   POST /api/billing/admin-suspend  (Bearer admin, {email|id, suspended})    -> freeze/restore access
//   POST /api/billing/issue-coupon   (x-api-key: ADMIN_API_KEY, shop server-to-server) -> {coupons:[...]}
import { store, j, bearerOf, readJson, sessionOf, accountById, accessOf, ownerOf } from '../lib/saas.mjs';
import { PLANS, planOf, countSeats, quotaCheck, publicBilling, normCoupon, newPayId, grantSub, adminEmails } from '../lib/billing.mjs';
import { readJsonCapped, tooLarge, badJson, rateLimit, ipOf, tooMany, secure } from '../lib/guard.mjs';
/* Billing bodies are tiny (codes/plan ids) — 64 KB is generous. */
const BILL_MAX_BYTES = 64_000;
async function readSmall(req) {
  const { data, tooLarge: big, bad } = await readJsonCapped(req, BILL_MAX_BYTES);
  if (big) return { err: tooLarge(BILL_MAX_BYTES) };
  if (bad) return { err: badJson() };
  return { data };
}

async function pushIdx(st, key, v) {
  try {
    const a = (await st.get(key, { type: 'json' })) || [];
    a.unshift(v);
    await st.setJSON(key, a.slice(0, 2000));
  } catch {}
}

async function meBilling(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const billing = publicBilling(acct);
  // Quota counts seats from the coach's own workspace (not null).
  let seats = 0;
  try {
    if (acct.workspaceId) {
      const m = await st.get(`ws-meta:${acct.workspaceId}`, { type: 'json' });
      if (m && m.data) seats = countSeats(m.data);
    }
  } catch {}
  const plan = planOf(acct);
  return j(200, { ok: true, billing, quota: { plan: plan.id, max: plan.maxClients, used: seats }, plans: Object.values(PLANS) });
}

async function redeem(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const { data: body, err } = await readSmall(req);
  if (err) return err;
  const code = normCoupon(body?.code);
  if (!code) return j(400, { ok: false, error: 'bad-code' });
  const c = await st.get(`coupon:${code}`, { type: 'json' });
  if (!c || c.isActive === false) return j(404, { ok: false, error: 'unknown-code' });
  if (c.expiresAt && Date.now() > c.expiresAt) return j(410, { ok: false, error: 'code-expired' });
  if ((c.usedCount || 0) >= (c.maxUses || 1)) return j(409, { ok: false, error: 'code-used-up' });
  if (!PLANS[c.planId]) return j(500, { ok: false, error: 'bad-plan' });
  c.usedCount = (c.usedCount || 0) + 1;
  await st.setJSON(`coupon:${code}`, c);
  grantSub(acct, { planId: c.planId, days: c.durationDays || 30, provider: 'coupon', tracking: code });
  await st.setJSON(`acct:${acct.email}`, acct);
  // Keep the owned workspace row in sync with the new plan (same rule as
  // requestPayment flow below — ws.plan/status mirror the subscription).
  try {
    if (acct.workspaceId) {
      const w = await st.get(`ws:${acct.workspaceId}`, { type: 'json' });
      if (w) { w.plan = acct.plan; w.status = 'active'; await st.setJSON(`ws:${acct.workspaceId}`, w); }
    }
  } catch {}
  const payId = newPayId();
  await st.setJSON(`pay:${payId}`, {
    id: payId, coachId: acct.id, planId: c.planId, amount: 0, currency: 'IRT',
    provider: 'coupon', tracking: code, status: 'paid',
    startsAt: acct.sub_started_at, endsAt: acct.sub_ends_at, createdAt: Date.now()
  });
  await pushIdx(st, 'index:payments', payId);
  let seats = 0;
  try {
    if (acct.workspaceId) {
      const m = await st.get(`ws-meta:${acct.workspaceId}`, { type: 'json' });
      if (m && m.data) seats = countSeats(m.data);
    }
  } catch {}
  const plan = planOf(acct);
  return j(200, { ok: true, billing: publicBilling(acct), quota: { plan: plan.id, max: plan.maxClients, used: seats } });
}

async function createCoupon(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const admins = adminEmails();
  if (acct.role !== 'admin' && (!admins.length || !admins.includes((s.email || '').toLowerCase()))) {
    return j(403, { ok: false, error: 'forbidden' });
  }
  const { data: cbody, err: err1 } = await readSmall(req);
  if (err1) return err1;
  const body = cbody || {};
  const code = normCoupon(body.code);
  if (code.length < 4 || !/^[A-Z0-9-]{4,32}$/.test(code)) {
    return j(400, { ok: false, error: 'bad-code' });
  }
  const planId = String(body.planId || '');
  if (!PLANS[planId] || planId === 'trial') return j(400, { ok: false, error: 'bad-plan' });
  const durationDays = Math.max(1, Math.min(3650, Number(body.durationDays) || 30));
  const maxUses = Math.max(1, Math.min(1000, Number(body.maxUses) || 1));
  const expiresInDays = Number(body.expiresInDays) || 0;
  await st.setJSON(`coupon:${code}`, {
    code, planId, durationDays, maxUses, usedCount: 0, isActive: true,
    expiresAt: expiresInDays > 0 ? Date.now() + expiresInDays * 86400000 : null,
    createdAt: Date.now()
  });
  await pushIdx(st, 'index:coupons', code);
  return j(200, { ok: true, coupon: { code, planId, durationDays, maxUses } });
}

async function requestPay(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const { data: body, err: err2 } = await readSmall(req);
  if (err2) return err2;
  const planId = String(body?.planId || 'professional');
  if (!PLANS[planId] || planId === 'trial') return j(400, { ok: false, error: 'bad-plan' });
  const payId = newPayId();
  const pr = { basic: 290000, professional: 790000, club: 2490000 }[planId] || 0;
  await st.setJSON(`pay:${payId}`, {
    id: payId, coachId: acct.id, planId, amount: pr, currency: 'IRT',
    provider: 'manual', tracking: '', status: 'pending',
    startsAt: null, endsAt: null, createdAt: Date.now()
  });
  await pushIdx(st, 'index:payments', payId);
  return j(200, { ok: true, payment: { id: payId, planId, amount: pr, currency: 'IRT', status: 'pending' } });
}

async function adminOverview(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const admins = adminEmails();
  const me = (s.email || '').toLowerCase();
  // Auth: durable role flag OR explicit ADMIN_EMAILS allow-list.
  if (acct.role !== 'admin' && (!admins.length || !admins.includes(me))) {
    return j(403, { ok: false, error: 'forbidden' });
  }
  const idx = (await st.get('index:coaches', { type: 'json' })) || [];
  const coaches = [];
  // No hard cap: at 500+ coaches the loop is still bounded by the index
  // length; reads are per-coach KV gets (cheap on Supabase/file backends).
  for (const id of idx.slice(0, 5000)) {
    try {
      const ptr = await st.get(`acct-by-id:${id}`, { type: 'json' });
      if (!ptr) continue;
      const a = await st.get(`acct:${String(ptr.email).toLowerCase()}`, { type: 'json' });
      if (!a) continue;
      // Seats used in the coach's workspace (for the admin table).
      let seats = null;
      try {
        if (a.workspaceId) {
          const m = await st.get(`ws-meta:${a.workspaceId}`, { type: 'json' });
          if (m && m.data) seats = countSeats(m.data);
        }
      } catch {}
      const access = accessOf(a);
      const endsAt = a.sub_ends_at || a.trialEndsAt || null;
      coaches.push({
        id: a.id, email: a.email, name: a.name, plan: a.plan,
        role: a.role || 'coach', access,
        suspended: a.sub_status === 'suspended',
        subEndsAt: endsAt,
        daysLeft: endsAt ? Math.max(0, Math.ceil((endsAt - Date.now()) / 86400000)) : null,
        seats, maxSeats: planOf(a).maxClients,
        createdAt: a.createdAt
      });
    } catch {}
  }
  return j(200, { ok: true, count: coaches.length, coaches });
}

/** Resolve a coach account by email or id (admin helpers). */
async function coachByRef(st, ref) {
  const email = String(ref?.email || '').trim().toLowerCase();
  if (email) return st.get(`acct:${email}`, { type: 'json' });
  if (ref?.id) {
    const ptr = await st.get(`acct-by-id:${String(ref.id)}`, { type: 'json' });
    if (ptr && ptr.email) return st.get(`acct:${String(ptr.email).toLowerCase()}`, { type: 'json' });
  }
  return null;
}

/** POST /api/billing/admin-grant {email|id, planId, days} — grant/extend a
 *  subscription. Days stack on top of any remaining time (renewal semantics). */
async function adminGrant(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const admin = await accountById(st, s.coachId);
  if (!admin || admin.role !== 'admin') return j(403, { ok: false, error: 'forbidden' });
  const { data: body, err } = await readSmall(req);
  if (err) return err;
  const target = await coachByRef(st, body || {});
  if (!target) return j(404, { ok: false, error: 'coach-not-found' });
  const planId = String(body?.planId || '');
  if (!PLANS[planId] || planId === 'trial') return j(400, { ok: false, error: 'bad-plan' });
  const days = Math.max(1, Math.min(3650, Number(body?.days) || 30));
  grantSub(target, { planId, days, provider: 'admin', tracking: `by:${admin.email}` });
  target.sub_status = 'active'; // a grant always re-activates
  await st.setJSON(`acct:${target.email}`, target);
  return j(200, {
    ok: true, coach: { email: target.email, plan: target.plan },
    subEndsAt: target.sub_ends_at,
    daysLeft: Math.max(0, Math.ceil((target.sub_ends_at - Date.now()) / 86400000))
  });
}

/** POST /api/billing/admin-suspend {email|id, suspended:bool} — freeze or
 *  restore a coach's write access (data stays intact, read-only while frozen). */
async function adminSuspend(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const admin = await accountById(st, s.coachId);
  if (!admin || admin.role !== 'admin') return j(403, { ok: false, error: 'forbidden' });
  const { data: body, err } = await readSmall(req);
  if (err) return err;
  const target = await coachByRef(st, body || {});
  if (!target) return j(404, { ok: false, error: 'coach-not-found' });
  if (target.role === 'admin') return j(400, { ok: false, error: 'cannot-suspend-admin' });
  const suspended = !!body?.suspended;
  target.sub_status = suspended ? 'suspended' : (target.sub && target.sub.status === 'active' ? 'active' : target.sub_status === 'active' ? 'active' : target.sub_status);
  if (!suspended && target.sub_status !== 'active') {
    // Un-suspending without an active sub falls back to trial/expiry logic.
    delete target.sub_status;
  }
  await st.setJSON(`acct:${target.email}`, target);
  return j(200, { ok: true, coach: { email: target.email }, suspended, access: accessOf(target) });
}

/** POST /api/billing/issue-coupon — server-to-server coupon creation for the
 *  external shop site. Auth: `x-api-key: ADMIN_API_KEY` (NOT a user session).
 *  Body: {code?, planId, durationDays?, maxUses?, expiresInDays?, count?}
 *  Returns the coupon code(s) so the shop can deliver them after payment. */
async function issueCoupon(req, st) {
  const key = String(req.headers.get('x-api-key') || '');
  const expected = String(process.env.ADMIN_API_KEY || '');
  if (!expected || key.length < 16 || key !== expected) return j(403, { ok: false, error: 'forbidden' });
  const { data: body, err } = await readSmall(req);
  if (err) return err;
  const planId = String(body?.planId || '');
  if (!PLANS[planId] || planId === 'trial') return j(400, { ok: false, error: 'bad-plan' });
  const durationDays = Math.max(1, Math.min(3650, Number(body?.durationDays) || 30));
  const maxUses = Math.max(1, Math.min(1000, Number(body?.maxUses) || 1));
  const expiresInDays = Number(body?.expiresInDays) || 0;
  const count = Math.max(1, Math.min(50, Number(body?.count) || 1));
  const C = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const gen = () => {
    let c = ''; for (let i = 0; i < 10; i++) c += C[Math.floor(Math.random() * C.length)];
    return `${planId.slice(0, 3).toUpperCase()}-${c}`;
  };
  const out = [];
  for (let i = 0; i < count; i++) {
    const code = normCoupon(body?.code && i === 0 ? body.code : gen());
    if (code.length < 4 || !/^[A-Z0-9-]{4,32}$/.test(code)) return j(400, { ok: false, error: 'bad-code' });
    if (await st.get(`coupon:${code}`, { type: 'json' })) return j(409, { ok: false, error: 'code-exists', code });
    await st.setJSON(`coupon:${code}`, {
      code, planId, durationDays, maxUses, usedCount: 0, isActive: true,
      expiresAt: expiresInDays > 0 ? Date.now() + expiresInDays * 86400000 : null,
      createdAt: Date.now(), issuedBy: 'shop-api'
    });
    await pushIdx(st, 'index:coupons', code);
    out.push(code);
  }
  return j(200, { ok: true, coupons: out, planId, durationDays, maxUses });
}

export default async (req) => {
  const st = store();
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const action = (segs[2] || '').toLowerCase();
  // Brute-force guard on code entry points (redeem guesses, coupon abuse).
  // issue-coupon is authenticated by ADMIN_API_KEY (server-to-server from the
  // shop) and creates — not guesses — codes, so it gets a roomier window.
  if (req.method === 'POST') {
    const [limit, win] = action === 'issue-coupon' ? [120, 60_000] : [20, 60_000];
    const r = rateLimit(`billing:${action}:${ipOf(req)}`, limit, win);
    if (!r.ok) return tooMany(r.retryAfter);
  }
  try {
    if (req.method === 'GET' && action === 'me') return secure(await meBilling(req, st));
    if (req.method === 'POST' && action === 'redeem') return secure(await redeem(req, st));
    if (req.method === 'POST' && action === 'coupon') return secure(await createCoupon(req, st));
    if (req.method === 'POST' && action === 'request') return secure(await requestPay(req, st));
    if (req.method === 'GET' && action === 'admin-overview') return secure(await adminOverview(req, st));
    if (req.method === 'POST' && action === 'admin-grant') return secure(await adminGrant(req, st));
    if (req.method === 'POST' && action === 'admin-suspend') return secure(await adminSuspend(req, st));
    if (req.method === 'POST' && action === 'issue-coupon') return secure(await issueCoupon(req, st));
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/billing/*' };
