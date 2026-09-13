// Coach OS — Phase 2 Billing API (simulated payments, server-authoritative).
//   GET  /api/billing/me      (Bearer) -> {ok, billing:{status,plan,...}, quota:{used,max,plan}, plans:[...]}
//   POST /api/billing/redeem  (Bearer, {code}) -> {ok, billing, quota} | 400/404/409/410
//   POST /api/billing/request (Bearer, {planId}) -> {ok, payment:{id,planId,amount,...}} (manual flow)
//   POST /api/billing/coupon  (Bearer admin, {code,planId,durationDays,maxUses,expiresInDays}) -> {ok, coupon}
//   GET  /api/billing/admin-overview (Bearer admin) -> {ok, coaches:[...]}  (ADMIN_EMAILS)
import { store, j, bearerOf, readJson, sessionOf, accountById, accessOf, ownerOf } from '../lib/saas.mjs';
import { PLANS, planOf, countSeats, quotaCheck, publicBilling, normCoupon, newPayId, grantSub, adminEmails } from '../lib/billing.mjs';

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
  const body = await readJson(req);
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
  const body = (await readJson(req)) || {};
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
  const body = await readJson(req);
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
  for (const id of idx.slice(0, 500)) {
    try {
      const ptr = await st.get(`acct-by-id:${id}`, { type: 'json' });
      if (!ptr) continue;
      const a = await st.get(`acct:${String(ptr.email).toLowerCase()}`, { type: 'json' });
      if (a) coaches.push({ id: a.id, email: a.email, name: a.name, plan: a.plan, role: a.role || 'coach', access: accessOf(a), createdAt: a.createdAt });
    } catch {}
  }
  return j(200, { ok: true, count: coaches.length, coaches });
}

export default async (req) => {
  const st = store();
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const action = (segs[2] || '').toLowerCase();
  try {
    if (req.method === 'GET' && action === 'me') return await meBilling(req, st);
    if (req.method === 'POST' && action === 'redeem') return await redeem(req, st);
    if (req.method === 'POST' && action === 'coupon') return await createCoupon(req, st);
    if (req.method === 'POST' && action === 'request') return await requestPay(req, st);
    if (req.method === 'GET' && action === 'admin-overview') return await adminOverview(req, st);
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/billing/*' };
