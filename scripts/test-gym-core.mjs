// CoachMint — Gym & Multi-Coach/Multi-Branch Core Test Suite
//   node ./scripts/test-gym-core.mjs
import { PLANS, isGymPlan, quotaCheck } from '../backend/lib/billing.mjs';
import {
  createOrg, getOrg, getOrgByCoach, addOrgBranch, addOrgStaff, removeOrgStaff, reassignOrgClients
} from '../backend/lib/saas.mjs';
import handleOrg from '../backend/handlers/org.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

// Simple In-Memory KV Store mock matching the store() contract
function makeMockStore() {
  const map = new Map();
  return {
    async get(k, opts) {
      if (!map.has(k)) return null;
      const v = map.get(k);
      return (opts?.type === 'json' && typeof v === 'string') ? JSON.parse(v) : v;
    },
    async setJSON(k, v) {
      map.set(k, JSON.stringify(v));
    },
    async delete(k) {
      map.delete(k);
    }
  };
}

console.log('== 1. Plans & Quota Checks ==');
ok(isGymPlan('gym_trial') === true, 'gym_trial is a gym plan');
ok(isGymPlan('gym_studio') === true, 'gym_studio is a gym plan');
ok(isGymPlan('gym_chain') === true, 'gym_chain is a gym plan');
ok(isGymPlan('gym_enterprise') === true, 'gym_enterprise is a gym plan');
ok(isGymPlan('club') === true, 'club tier mapped to gym');
ok(isGymPlan('basic') === false, 'basic is not a gym plan');
ok(isGymPlan('trial') === false, 'trial is not a gym plan');

// Quota check with gym organization
const mockOrg = {
  branches: [{ id: 'br_hq' }, { id: 'br_2' }],
  staff: [
    { coachId: 'c1', role: 'gym_owner' },
    { coachId: 'c2', role: 'trainer' },
    { coachId: 'c3', role: 'reception' } // does not count towards coach cap
  ]
};
const q1 = quotaCheck({ plan: 'gym_studio' }, { CLIENTS: [{ id: 1 }, { id: 2 }] }, mockOrg);
ok(q1.tier === 'gym', 'quotaCheck reports gym tier');
ok(q1.usedCoaches === 2, 'reception excluded from usedCoaches count (2 coaches)');
ok(q1.maxCoaches === 5, 'gym_studio maxCoaches is 5');
ok(q1.overCoaches === false, 'within coach quota');
ok(q1.usedBranches === 2 && q1.maxBranches === 1 && q1.overBranches === true, 'branch quota overflow detected (2 > 1)');
ok(q1.over === true, 'composite quota flag is over');

console.log('== 2. Organization Lifecycle ==');
const st = makeMockStore();
const org = await createOrg(st, {
  ownerCoachId: 'coach_owner_1',
  ownerEmail: 'owner@olympiagym.ir',
  name: 'Olympia Fitness Club',
  planId: 'gym_chain'
});

ok(org && org.id.startsWith('org_'), 'org created with unique id');
ok(org.branches.length === 1 && org.branches[0].isHQ === true, 'default HQ branch created');
ok(org.staff.length === 1 && org.staff[0].role === 'gym_owner', 'owner added as gym_owner staff');

const lookup = await getOrg(st, org.id);
ok(lookup && lookup.name === 'Olympia Fitness Club', 'org fetched from store');

const coachPtr = await getOrgByCoach(st, 'coach_owner_1');
ok(coachPtr && coachPtr.org.id === org.id && coachPtr.staffRecord.role === 'gym_owner', 'getOrgByCoach resolves owner');

console.log('== 3. Multi-Branch Operations & Quotas ==');
// gym_chain allows up to 5 branches
const b2 = await addOrgBranch(st, org.id, { name: 'West Branch', address: 'Shahrak Gharb', phone: '02188888888' }, 5);
ok(b2.ok && b2.branch.name === 'West Branch', 'second branch added successfully');

const b3 = await addOrgBranch(st, org.id, { name: 'North Branch', address: 'Niavaran' }, 5);
ok(b3.ok && b3.org.branches.length === 3, 'third branch added');

// Test quota limit enforcement: simulate studio plan with max 1 branch
const bFail = await addOrgBranch(st, org.id, { name: 'Branch 4' }, 3); // cap at 3
ok(bFail.ok === false && bFail.error === 'branch-quota-exceeded', 'branch quota limit strictly enforced');

console.log('== 4. Multi-Coach Staff Management (RBAC) ==');
// Add head coach
const s1 = await addOrgStaff(st, org.id, {
  coachId: 'coach_head_1',
  email: 'head@olympiagym.ir',
  name: 'Kaveh Coach',
  role: 'head_coach',
  branches: ['*']
}, 20);
ok(s1.ok && s1.staffMember.role === 'head_coach', 'head coach staff added');

// Add personal trainer
const s2 = await addOrgStaff(st, org.id, {
  coachId: 'coach_pt_1',
  email: 'trainer1@olympiagym.ir',
  name: 'Sara Trainer',
  role: 'trainer',
  branches: ['br_hq']
}, 20);
ok(s2.ok && s2.staffMember.branches.includes('br_hq'), 'trainer assigned to specific branch');

// Add reception
const s3 = await addOrgStaff(st, org.id, {
  coachId: 'coach_rec_1',
  email: 'reception@olympiagym.ir',
  name: 'Maryam Reception',
  role: 'reception',
  branches: ['br_hq']
}, 20);
ok(s3.ok && s3.staffMember.role === 'reception', 'reception staff added');

// Duplicate staff rejected
const sDup = await addOrgStaff(st, org.id, {
  coachId: 'coach_pt_1',
  email: 'trainer1@olympiagym.ir'
}, 20);
ok(sDup.ok === false && sDup.error === 'staff-already-exists', 'duplicate staff addition rejected');

// Quota cap enforcement on trainers
const sCap = await addOrgStaff(st, org.id, {
  coachId: 'coach_pt_overflow',
  email: 'overflow@olympiagym.ir',
  role: 'trainer'
}, 3); // current coaches = owner + head + pt = 3. Cap at 3.
ok(sCap.ok === false && sCap.error === 'coach-quota-exceeded', 'coach quota cap enforced');

// Reception does not consume trainer seat
const sRecPass = await addOrgStaff(st, org.id, {
  coachId: 'coach_rec_2',
  email: 'rec2@olympiagym.ir',
  role: 'reception'
}, 3);
ok(sRecPass.ok === true, 'reception bypasses trainer seat quota');

// Remove staff
const rem = await removeOrgStaff(st, org.id, 'coach_pt_1');
ok(rem.ok && !rem.org.staff.some(s => s.coachId === 'coach_pt_1'), 'trainer removed successfully');

// Removing owner rejected
const remOwner = await removeOrgStaff(st, org.id, 'coach_owner_1');
ok(remOwner.ok === false && remOwner.error === 'cannot-remove-owner', 'owner removal forbidden');

console.log('== 5. Client Reassignment (Anti-Poaching / Transfer Engine) ==');
const originalClients = [
  { id: 101, name: 'Arman Rezaei', assignedCoachId: 'coach_pt_1', branchId: 'br_hq' },
  { id: 102, name: 'Babak Rad', assignedCoachId: 'coach_pt_1', branchId: 'br_hq' },
  { id: 103, name: 'Nima Karimi', assignedCoachId: 'coach_head_1', branchId: 'br_hq' }
];

const transferred = reassignOrgClients(originalClients, {
  clientIds: [101, 102],
  toCoachId: 'coach_head_1',
  toBranchId: 'br_west'
});

ok(transferred[0].assignedCoachId === 'coach_head_1' && transferred[0].branchId === 'br_west', 'client 101 transferred to new coach and branch');
ok(transferred[1].assignedCoachId === 'coach_head_1' && transferred[1].branchId === 'br_west', 'client 102 transferred to new coach and branch');
ok(transferred[2].assignedCoachId === 'coach_head_1' && transferred[2].branchId === 'br_hq', 'client 103 remained intact');

console.log('== 6. HTTP Handler Smoke Test ==');
// Unauthenticated request
const unauthReq = new Request('http://localhost/api/org/me', { method: 'GET' });
const unauthRes = await handleOrg(unauthReq);
ok(unauthRes.status === 401, 'GET /api/org/me without token returns 401');

console.log(`\n========================================`);
console.log(`GYM_CORE: ${pass} pass, ${fail} fail`);
console.log(`========================================`);

if (fail > 0) process.exit(1);
