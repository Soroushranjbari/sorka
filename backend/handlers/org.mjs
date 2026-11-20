// CoachMint — Organization & Gym Multi-Coach/Multi-Branch API.
//   GET    /api/org/me         (Bearer) -> { ok, org, role, staff, branches }
//   POST   /api/org/create     (Bearer, { name }) -> { ok, org }
//   POST   /api/org/branch     (Bearer, { name, address, phone }) -> { ok, branch, org }
//   POST   /api/org/staff      (Bearer, { coachId?, email, name, role, branches }) -> { ok, staffMember, org }
//   DELETE /api/org/staff      (Bearer, { coachId }) -> { ok, org }
//   POST   /api/org/reassign   (Bearer, { clientIds, toCoachId, toBranchId? }) -> { ok, reassignedCount }
//   POST   /api/org/machine    (Bearer, { code, name, branchId, ex, brand, adjustments, cues }) -> { ok, machine, org }
//   DELETE /api/org/machine    (Bearer, { machineId }) -> { ok, org }
import {
  store, j, bearerOf, sessionOf, accountById, normEmail,
  createOrg, getOrg, getOrgByCoach, addOrgBranch, addOrgStaff, removeOrgStaff, reassignOrgClients,
  addOrgMachine, removeOrgMachine
} from '../lib/saas.mjs';
import { PLANS, isGymPlan } from '../lib/billing.mjs';
import { readJsonCapped, tooLarge, badJson, rateLimit, ipOf, tooMany, secure } from '../lib/guard.mjs';

const ORG_MAX_BYTES = 64_000;

async function readSmall(req) {
  const { data, tooLarge: big, bad } = await readJsonCapped(req, ORG_MAX_BYTES);
  if (big) return { err: tooLarge(ORG_MAX_BYTES) };
  if (bad) return { err: badJson() };
  return { data };
}

export default async function handle(req) {
  const ip = ipOf(req);
  if (!rateLimit('org', ip, 60, 60000)) return tooMany(60);

  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/org\/?/, '').replace(/\/+$/, '');

  const st = store();
  const token = bearerOf(req);
  const s = await sessionOf(st, token);
  if (!s) return j(401, { ok: false, error: 'unauthorized' });

  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });

  // 1. GET /api/org/me
  if (req.method === 'GET' && (!action || action === 'me')) {
    const orgData = await getOrgByCoach(st, s.coachId, acct.email);
    if (!orgData) {
      return j(200, { ok: true, org: null, isGym: isGymPlan(acct.plan), plan: acct.plan });
    }
    const { org, staffRecord } = orgData;
    return j(200, {
      ok: true,
      org: {
        id: org.id,
        name: org.name,
        plan: org.plan,
        branches: org.branches || [],
        staff: org.staff || [],
        machines: org.machines || [],
        createdAt: org.createdAt
      },
      role: staffRecord.role || 'trainer',
      branches: staffRecord.branches || ['*'],
      isOwner: org.ownerCoachId === s.coachId,
      plan: acct.plan
    });
  }

  // 2. POST /api/org/create
  if (req.method === 'POST' && action === 'create') {
    if (!isGymPlan(acct.plan)) {
      return j(403, { ok: false, error: 'gym-plan-required', message: 'An active Gym or Club subscription is required to create an organization.' });
    }
    const existing = await getOrgByCoach(st, s.coachId, acct.email);
    if (existing && existing.org) {
      return j(409, { ok: false, error: 'org-already-exists', orgId: existing.org.id });
    }
    const { data, err } = await readSmall(req);
    if (err) return err;

    const org = await createOrg(st, {
      ownerCoachId: s.coachId,
      ownerEmail: acct.email,
      name: data?.name || `${acct.name || 'Coach'}'s Gym`,
      primaryBranchName: data?.primaryBranchName,
      planId: acct.plan
    });
    return j(200, { ok: true, org });
  }

  // The remaining actions require membership in an organization
  const orgData = await getOrgByCoach(st, s.coachId, acct.email);
  if (!orgData || !orgData.org) {
    return j(404, { ok: false, error: 'no-org-found' });
  }
  const { org, staffRecord } = orgData;
  const isOwnerOrManager = ['gym_owner', 'manager', 'head_coach'].includes(staffRecord.role);
  const plan = PLANS[org.plan] || PLANS.gym_studio;

  // 3. POST /api/org/branch
  if (req.method === 'POST' && action === 'branch') {
    if (!isOwnerOrManager) return j(403, { ok: false, error: 'forbidden' });
    const { data, err } = await readSmall(req);
    if (err) return err;
    if (!data?.name) return j(400, { ok: false, error: 'branch-name-required' });

    const res = await addOrgBranch(st, org.id, data, plan.maxBranches || 5);
    if (!res.ok) return j(400, res);
    return j(200, res);
  }

  // 4. POST /api/org/staff
  if (req.method === 'POST' && action === 'staff') {
    if (!isOwnerOrManager) return j(403, { ok: false, error: 'forbidden' });
    const { data, err } = await readSmall(req);
    if (err) return err;

    const email = normEmail(data?.email);
    if (!email) return j(400, { ok: false, error: 'email-required' });

    // Look up existing coach account if present, or assign temporary coachId
    const targetAcct = await st.get(`acct:${email}`, { type: 'json' });
    const targetCoachId = targetAcct?.id || data?.coachId || `coach_${Date.now().toString(36)}`;

    const res = await addOrgStaff(st, org.id, {
      coachId: targetCoachId,
      email,
      name: data?.name || targetAcct?.name || email.split('@')[0],
      role: data?.role || 'trainer',
      branches: data?.branches || ['*']
    }, plan.maxCoaches || 5);

    if (!res.ok) return j(400, res);
    return j(200, { ok: true, staffMember: res.staffMember, staff: res.staffMember, org: res.org });
  }

  // 5. DELETE /api/org/staff
  if (req.method === 'DELETE' && (action === 'staff' || action.startsWith('staff/'))) {
    if (staffRecord.role !== 'gym_owner') return j(403, { ok: false, error: 'owner-only' });
    const targetCoachId = action.startsWith('staff/') ? action.slice(6) : url.searchParams.get('coachId');
    if (!targetCoachId) return j(400, { ok: false, error: 'coach-id-required' });

    const res = await removeOrgStaff(st, org.id, targetCoachId);
    if (!res.ok) return j(400, res);
    return j(200, res);
  }

  // 6. POST /api/org/reassign
  if (req.method === 'POST' && action === 'reassign') {
    if (!isOwnerOrManager) return j(403, { ok: false, error: 'forbidden' });
    const { data, err } = await readSmall(req);
    if (err) return err;

    const toCoachId = data?.toCoachId || data?.targetCoachId;
    const toBranchId = data?.toBranchId || data?.targetBranchId || null;
    const clientIds = data?.clientIds;
    if (!Array.isArray(clientIds) || !clientIds.length || !toCoachId) {
      return j(400, { ok: false, error: 'invalid-reassign-payload' });
    }

    // Verify toCoachId belongs to org
    let targetStaff = (org.staff || []).find((s) => s.coachId === toCoachId || s.email === normEmail(toCoachId));
    if (!targetStaff) {
      const targetAcct = await accountById(st, toCoachId);
      if (targetAcct && targetAcct.email) {
        targetStaff = (org.staff || []).find((s) => s.email === normEmail(targetAcct.email));
        if (targetStaff) {
          targetStaff.coachId = toCoachId;
          await st.setJSON(`org:${org.id}`, org);
          await st.setJSON(`org-by-coach:${toCoachId}`, { orgId: org.id, role: targetStaff.role, branches: targetStaff.branches });
        }
      }
    }
    if (!targetStaff) {
      return j(400, { ok: false, error: 'target-coach-not-in-org' });
    }

    // Update the workspace data for this owner
    const ownerAcct = org.ownerCoachId === s.coachId ? acct : await accountById(st, org.ownerCoachId);
    const wsId = ownerAcct?.workspaceId || acct.workspaceId;
    if (wsId) {
      const meta = await st.get(`ws-meta:${wsId}`, { type: 'json' });
      if (meta && meta.data && Array.isArray(meta.data.CLIENTS)) {
        meta.data.CLIENTS = reassignOrgClients(meta.data.CLIENTS, { clientIds, toCoachId: targetStaff.coachId, toBranchId });
        meta.rev = (meta.rev || 0) + 1;
        meta.updatedAt = Date.now();
        await st.setJSON(`ws-meta:${wsId}`, meta);
      }
    }

    return j(200, { ok: true, reassignedCount: clientIds.length, toCoachId: targetStaff.coachId, toBranchId });
  }

  // 7. POST /api/org/machine
  if (req.method === 'POST' && action === 'machine') {
    if (!isOwnerOrManager) return j(403, { ok: false, error: 'forbidden' });
    const { data, err } = await readSmall(req);
    if (err) return err;
    if (!data?.name && !data?.code) {
      return j(400, { ok: false, error: 'machine-name-or-code-required' });
    }
    const res = await addOrgMachine(st, org.id, data);
    if (!res.ok) return j(400, res);
    return j(200, res);
  }

  // 8. DELETE /api/org/machine
  if (req.method === 'DELETE' && action === 'machine') {
    if (!isOwnerOrManager) return j(403, { ok: false, error: 'forbidden' });
    const { data, err } = await readSmall(req);
    if (err) return err;
    if (!data?.machineId) {
      return j(400, { ok: false, error: 'machine-id-required' });
    }
    const res = await removeOrgMachine(st, org.id, data.machineId);
    if (!res.ok) return j(400, res);
    return j(200, res);
  }

  return j(404, { ok: false, error: 'unknown-org-endpoint' });
}
