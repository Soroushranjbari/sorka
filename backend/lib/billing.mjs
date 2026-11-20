// CoachMint — Phase 2 billing lib (bundled, NOT a function).
// Server-authoritative plans + quotas + simulated payments (manual/coupon).
// Real gateways (ZarinPal/Stripe) plug into requestPayment()/webhook later;
// the shapes here (payments rows, grantSub()) stay the same.
// NOTE: accessOf2() delegates to the Phase-1 canonical accessOf() in saas.mjs
// so there is exactly ONE definition of trial/active/expired everywhere.
import { createHash } from 'node:crypto';
import { normEmail, accessOf, createOrg, getOrgByCoach } from './saas.mjs';
import { withLock } from './guard.mjs';

export const PLANS = {
  // Solo coach tiers
  trial:          { id: 'trial',          name: 'Trial',          tier: 'solo', maxClients: 5,   maxCoaches: 1,  maxBranches: 1, maxStorageMB: 100 },
  basic:          { id: 'basic',          name: 'Basic',          tier: 'solo', maxClients: 5,   maxCoaches: 1,  maxBranches: 1, maxStorageMB: 100 },
  professional:   { id: 'professional',   name: 'Professional',   tier: 'solo', maxClients: 30,  maxCoaches: 1,  maxBranches: 1, maxStorageMB: 2048 },
  club:           { id: 'club',           name: 'Club',           tier: 'gym',  maxClients: 200, maxCoaches: 5,  maxBranches: 1, maxStorageMB: 10240 },

  // Gym & Multi-Branch Enterprise tiers
  gym_studio:     { id: 'gym_studio',     name: 'Gym Studio',     tier: 'gym',  maxClients: 150, maxCoaches: 5,  maxBranches: 1, maxStorageMB: 10240 },
  gym_chain:      { id: 'gym_chain',      name: 'Gym Chain',      tier: 'gym',  maxClients: 600, maxCoaches: 20, maxBranches: 5, maxStorageMB: 30720 },
  gym_enterprise: { id: 'gym_enterprise', name: 'Enterprise',     tier: 'gym',  maxClients: 3000, maxCoaches: 100, maxBranches: 25, maxStorageMB: 102400 }
};

export const planOf = (acct) => PLANS[acct?.plan] || PLANS.trial;
export const isGymPlan = (planId) => (PLANS[planId]?.tier === 'gym');

/** Seat count = non-archived clients in the workspace payload. */
export function countSeats(data) {
  const list = (data && data.CLIENTS) || [];
  return list.filter((c) => c && c.status !== 'Archived').length;
}

export function quotaCheck(acct, data, org = null) {
  const plan = planOf(acct);
  const used = countSeats(data);
  const res = {
    plan: plan.id,
    tier: plan.tier || 'solo',
    max: plan.maxClients,
    used,
    over: used > plan.maxClients
  };
  if (org && plan.tier === 'gym') {
    const coachCount = (org.staff || []).filter((s) => s && s.role !== 'reception').length;
    const branchCount = (org.branches || []).length;
    res.maxCoaches = plan.maxCoaches || 1;
    res.usedCoaches = coachCount;
    res.overCoaches = coachCount > (plan.maxCoaches || 1);
    res.maxBranches = plan.maxBranches || 1;
    res.usedBranches = branchCount;
    res.overBranches = branchCount > (plan.maxBranches || 1);
    res.over = res.over || res.overCoaches || res.overBranches;
  }
  return res;
}

/** accessOf v2: single source of truth lives in saas.mjs (canonical Phase-1).
 *  Kept as an alias so data.mjs / billing.mjs / auth.mjs all agree. */
export const accessOf2 = accessOf;

export function publicBilling(acct) {
  const a = accessOf2(acct);
  return {
    status: a.status, plan: a.plan,
    trialEndsAt: acct?.trialEndsAt || null, subEndsAt: acct?.sub_ends_at || null,
    // Activation code of the CURRENT subscription (grantSub stores it as
    // sub.tracking) — shown in the app's Account tab as the purchase reference.
    lastCode: acct?.sub?.tracking || null
  };
}

export const normCoupon = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);

export function newPayId() {
  return 'pay_' + createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 16);
}

export function grantSub(acct, { planId, days, provider, tracking }) {
  const now = Date.now();
  const base = Math.max(now, acct?.sub_ends_at || 0);
  const endsAt = base + days * 86400000;
  acct.plan = planId;
  acct.sub_status = 'active';
  acct.sub_started_at = now;
  acct.sub_ends_at = endsAt;
  acct.sub = { status: 'active', endsAt, provider: provider || 'manual', tracking: tracking || '' };
  return acct;
}

/** Single-use coupon redemption for ONE account — the ONE implementation,
 *  shared by /api/billing/redeem AND the signup/login "activate with code"
 *  path. Lock order is coupon → account; no caller may hold the account lock
 *  when calling this (signup/login release it first) or the two paths could
 *  deadlock. Returns {ok,billing,quota,access} or {ok:false,error}. */
export async function redeemForAccount(st, acct, rawCode) {
  const code = normCoupon(rawCode);
  if (!code) return { ok: false, error: 'bad-code' };
  return withLock(`coupon:${code}`, () => withLock(`acct:${acct.email}`, async () => {
    // Re-read the account inside the lock — it may have changed since.
    const cur = (await st.get(`acct:${acct.email}`, { type: 'json' })) || acct;
    const c = await st.get(`coupon:${code}`, { type: 'json' });
    if (!c || c.isActive === false) return { ok: false, error: 'unknown-code' };
    if (c.expiresAt && Date.now() > c.expiresAt) return { ok: false, error: 'code-expired' };
    if ((c.usedCount || 0) >= (c.maxUses || 1)) return { ok: false, error: 'code-used-up' };
    if (!PLANS[c.planId]) return { ok: false, error: 'bad-plan' };
    c.usedCount = (c.usedCount || 0) + 1;
    await st.setJSON(`coupon:${code}`, c);
    grantSub(cur, { planId: c.planId, days: c.durationDays || 30, provider: 'coupon', tracking: code });
    await st.setJSON(`acct:${cur.email}`, cur);
    // Keep the owned workspace row in sync with the new plan (ws.plan/status
    // mirror the subscription — same rule as the payment flows).
    try {
      if (cur.workspaceId) {
        const w = await st.get(`ws:${cur.workspaceId}`, { type: 'json' });
        if (w) { w.plan = cur.plan; w.status = 'active'; await st.setJSON(`ws:${cur.workspaceId}`, w); }
      }
    } catch {}
    if (isGymPlan(c.planId)) {
      try {
        const existingOrg = await getOrgByCoach(st, cur.id, cur.email);
        if (!existingOrg) {
          const gymTitle = (cur.name ? `${cur.name.trim()}` : 'باشگاه') + ' (HQ)';
          await createOrg(st, {
            ownerCoachId: cur.id,
            ownerEmail: cur.email,
            name: gymTitle,
            primaryBranchName: 'شعبه اصلی (مرکزی)',
            planId: c.planId
          });
        } else if (existingOrg.org) {
          existingOrg.org.plan = c.planId;
          existingOrg.org.status = 'active';
          await st.setJSON(`org:${existingOrg.org.id}`, existingOrg.org);
        }
      } catch (err) {
        console.error('[billing] org auto-provision error:', err);
      }
    }
    const payId = newPayId();
    await st.setJSON(`pay:${payId}`, {
      id: payId, coachId: cur.id, planId: c.planId, amount: 0, currency: 'IRT',
      provider: 'coupon', tracking: code, status: 'paid',
      startsAt: cur.sub_started_at, endsAt: cur.sub_ends_at, createdAt: Date.now()
    });
    try {
      const a = (await st.get('index:payments', { type: 'json' })) || [];
      a.unshift(payId);
      await st.setJSON('index:payments', a.slice(0, 2000));
    } catch {}
    let seats = 0;
    try {
      if (cur.workspaceId) {
        const m = await st.get(`ws-meta:${cur.workspaceId}`, { type: 'json' });
        if (m && m.data) seats = countSeats(m.data);
      }
    } catch {}
    const plan = planOf(cur);
    return { ok: true, billing: publicBilling(cur), quota: { plan: plan.id, max: plan.maxClients, used: seats }, access: accessOf(cur) };
  }));
}

export const adminEmails = () =>
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(normEmail)
    .filter(Boolean);
