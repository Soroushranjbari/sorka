// CoachMint — Gym Free Trial (14-day) Verification Suite
//   node ./scripts/test-gym-free-trial.mjs
import assert from 'node:assert/strict';
import { PLANS, isGymPlan, quotaCheck } from '../backend/lib/billing.mjs';
import { store, accessOf } from '../backend/lib/saas.mjs';
import handleAuth from '../backend/handlers/auth.mjs';
import handleOrg from '../backend/handlers/org.mjs';

console.log('== 14-DAY CLUB / GYM FREE TRIAL TEST SUITE ==');

// 1. Verify Plan Registry
assert.equal(isGymPlan('gym_trial'), true, 'gym_trial must be registered as a gym plan');
assert.equal(PLANS.gym_trial.tier, 'gym', 'gym_trial tier must be gym');
assert.equal(PLANS.gym_trial.maxClients, 25, 'gym_trial maxClients must be 25');
assert.equal(PLANS.gym_trial.maxCoaches, 3, 'gym_trial maxCoaches must be 3');
assert.equal(PLANS.gym_trial.maxBranches, 1, 'gym_trial maxBranches must be 1');
console.log('  PASS  Plan definition & gym tier verified');

// 2. Signup via /api/auth/signup with gym_trial
const testEmail = `gymtrial_${Date.now()}@testclub.ir`;
const signupReq = new Request('http://localhost/api/auth/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'مدیر باشگاه پارس',
    email: testEmail,
    password: 'Password123!',
    portal: 'org',
    accountType: 'org',
    gymName: 'مجموعه ورزشی پارس (HQ)',
    plan: 'gym_trial'
  })
});

const signupRes = await handleAuth(signupReq);
assert.equal(signupRes.status, 200, 'Signup response status must be 200');
const signupData = await signupRes.json();
assert.equal(signupData.ok, true, 'Signup must succeed');
assert.ok(signupData.token, 'Session token must be issued');
assert.equal(signupData.coach.plan, 'gym_trial', 'Account plan must be gym_trial');
assert.equal(signupData.coach.isOrg, true, 'Account isOrg must be true');
console.log('  PASS  Gym Free Trial signup issued session and created account');

// 3. Verify Account trial status in store
const st = store();
const acct = await st.get(`acct:${testEmail}`, { type: 'json' });
assert.ok(acct, 'Account must exist in KV store');
assert.equal(acct.plan, 'gym_trial', 'KV account plan must be gym_trial');
assert.equal(acct.isOrg, true, 'KV account isOrg must be true');
assert.ok(acct.trialEndsAt > Date.now(), 'trialEndsAt must be in the future');
const daysLeft = (acct.trialEndsAt - Date.now()) / (1000 * 60 * 60 * 24);
assert.ok(daysLeft > 13 && daysLeft <= 14.1, 'Trial must be ~14 days');
const access = accessOf(acct);
assert.equal(access.status, 'trial', 'accessOf must return trial status');
assert.equal(access.plan, 'gym_trial', 'accessOf must return gym_trial plan');
console.log('  PASS  14-day trial window and access verified');

// 4. Verify Organization creation via /api/org/me
const orgReq = new Request('http://localhost/api/org/me', {
  method: 'GET',
  headers: { authorization: `Bearer ${signupData.token}` }
});
const orgRes = await handleOrg(orgReq);
assert.equal(orgRes.status, 200, 'Org/me status must be 200');
const orgData = await orgRes.json();
assert.equal(orgData.ok, true, 'Org/me ok must be true');
assert.ok(orgData.org, 'Org must be present');
assert.equal(orgData.org.name, 'مجموعه ورزشی پارس (HQ)', 'Org name must match');
assert.equal(orgData.org.plan, 'gym_trial', 'Org plan must be gym_trial');
assert.equal(orgData.role, 'gym_owner', 'User role must be gym_owner');
assert.equal(orgData.isOwner, true, 'User isOwner must be true');
assert.equal(orgData.org.branches.length, 1, 'Default 1 HQ branch created');
console.log('  PASS  Organization provisioned with Executive Console access');

// 5. Test Quota checks for gym_trial
const quota1 = quotaCheck(acct, { CLIENTS: Array(20).fill({ id: 1 }) }, orgData.org);
assert.equal(quota1.max, 25, 'Max athletes must be 25');
assert.equal(quota1.maxCoaches, 3, 'Max coaches must be 3');
assert.equal(quota1.maxBranches, 1, 'Max branches must be 1');
assert.equal(quota1.over, false, 'Within quota should not be over');

// Exceeding coaches (3 allowed)
const fullStaffOrg = {
  ...orgData.org,
  staff: [
    { coachId: 'c1', role: 'gym_owner' },
    { coachId: 'c2', role: 'trainer' },
    { coachId: 'c3', role: 'trainer' },
    { coachId: 'c4', role: 'trainer' } // 4 coaches > 3
  ]
};
const quotaOverCoaches = quotaCheck(acct, { CLIENTS: [] }, fullStaffOrg);
assert.equal(quotaOverCoaches.overCoaches, true, '4 coaches should exceed quota of 3');
assert.equal(quotaOverCoaches.over, true, 'Overall quota flag should be over');
console.log('  PASS  Quota rules strictly enforced for gym_trial');

console.log('🎉 ALL 14-DAY CLUB / GYM FREE TRIAL TESTS PASSED SUCCESSFULLY!');
