import assert from 'node:assert/strict';
import { store, newId, normEmail } from '../backend/lib/saas.mjs';
import { signup, login } from '../backend/lib/auth-shared.mjs';
import handleOrg from '../backend/handlers/org.mjs';
import handleData from '../backend/handlers/data.mjs';
import handleAuth from '../backend/handlers/auth.mjs';
import fs from 'node:fs';

function mockReq(method, path, body = null, token = null) {
  const url = `http://localhost:3000${path}`;
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body) headers.set('content-type', 'application/json');
  return new Request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
}

function pass(name) { console.log(`  PASS ${name}`); }

async function run() {
  console.log('== DIRECT COACH ACCESS VERIFICATION SUITE ==');
  const st = store();

  // 1. Gym Owner Setup
  const ownerEmail = `boss_${Date.now()}@titan.com`;
  const ownerRes = await signup(mockReq('POST', '/api/auth/signup', {
    name: 'Boss Gym', email: ownerEmail, password: 'password123',
    accountType: 'org', gymName: 'Titan Arena'
  }), st);
  const ownerData = await ownerRes.json();
  assert.equal(ownerData.ok, true, 'Owner signup must succeed');
  const ownerToken = ownerData.token;
  pass('Gym Owner registered and org created');

  // 2. Owner adds staff (Trainer) with custom password
  const trainerEmail = `coach_reza_${Date.now()}@titan.com`;
  const addStaffRes = await handleOrg(mockReq('POST', '/api/org/staff', {
    name: 'Reza Moradi',
    email: trainerEmail,
    role: 'trainer',
    password: 'CustomPass789!',
    branches: ['*']
  }, ownerToken));
  const addStaffData = await addStaffRes.json();
  assert.equal(addStaffData.ok, true, 'Staff add must succeed');
  assert.equal(addStaffData.newlyProvisioned, true, 'Account should be auto-provisioned');
  assert.equal(addStaffData.initialPass, 'CustomPass789!', 'Custom password should be returned');
  pass('Manager registered coach with direct auto-provisioned account & password');

  // 3. Coach logs in directly with the credentials (no signup needed)
  const loginRes = await login(mockReq('POST', '/api/auth/login', {
    email: trainerEmail, password: 'CustomPass789!'
  }), st);
  const loginData = await loginRes.json();
  assert.equal(loginData.ok, true, 'Coach login must succeed immediately');
  assert.equal(loginData.coach.plan, 'gym_staff', 'Coach plan should be gym_staff');
  assert.equal(loginData.access.status, 'active', 'Coach access status must be active');
  const trainerToken = loginData.token;
  pass('Coach logged in directly with full active status (no trial expiration)');

  // 4. Verify /api/auth/me retains active status
  const authMeRes = await handleAuth(mockReq('GET', '/api/auth/me', null, trainerToken));
  const authMe = await authMeRes.json();
  assert.equal(authMe.ok, true);
  assert.equal(authMe.access.status, 'active');
  assert.equal(authMe.coach.plan, 'gym_staff');
  pass('GET /api/auth/me confirms active gym_staff plan');

  // 5. Verify GET /api/org/me includes gym workspaceCode
  const orgMeRes = await handleOrg(mockReq('GET', '/api/org/me', null, trainerToken));
  const orgMe = await orgMeRes.json();
  assert.equal(orgMe.ok, true);
  assert.equal(orgMe.role, 'trainer');
  assert.equal(orgMe.org.workspaceCode, ownerData.workspace.code, 'Org workspace code must match owner');
  pass('GET /api/org/me returns gym workspaceCode to coach');

  // 6. Direct Workout Programming & Nutrition Data Access
  // Owner populates gym clients
  await handleData(mockReq('PUT', `/api/data?code=${ownerData.workspace.code}`, {
    rev: 0,
    data: {
      CLIENTS: [{ id: 501, name: 'Gym Athlete 1', assignedCoachId: loginData.coach.id, status: 'Active' }],
      TEMPLATES: [{ id: 'tpl_1', title: 'Powerlifting Base' }],
      NPLANS: [{ id: 'np_1', title: 'High Protein Cutting' }]
    }
  }, ownerToken));

  // Coach reads gym workspace data
  const coachDataGet = await handleData(mockReq('GET', `/api/data?code=${orgMe.org.workspaceCode}`, null, trainerToken));
  const coachData = await coachDataGet.json();
  assert.equal(coachData.ok, true);
  assert.equal(coachData.mine, true, 'Coach must have full mine=true access to gym workspace');
  assert.equal(coachData.data.CLIENTS.length, 1);
  assert.equal(coachData.data.TEMPLATES.length, 1);
  assert.equal(coachData.data.NPLANS.length, 1);
  pass('Coach reads gym workspace with athletes, workouts, and nutrition plans');

  // Coach programs a workout and creates a nutrition plan
  const coachPutRes = await handleData(mockReq('PUT', `/api/data?code=${orgMe.org.workspaceCode}`, {
    rev: coachData.rev,
    data: {
      CLIENTS: coachData.data.CLIENTS,
      TEMPLATES: [
        ...coachData.data.TEMPLATES,
        { id: 'tpl_2', title: 'Hypertrophy Block (Programmed by Coach Reza)' }
      ],
      NPLANS: [
        ...coachData.data.NPLANS,
        { id: 'np_2', title: 'Keto Macro Target (By Coach Reza)' }
      ]
    }
  }, trainerToken));
  const coachPut = await coachPutRes.json();
  assert.equal(coachPut.ok, true);
  assert.equal(coachPut.mine, true);
  pass('Coach writes workout programs & nutrition plans into workspace with full permissions');

  // 7. Verify UI elements in app.js
  const appJs = fs.readFileSync('client/app.js', 'utf8');
  assert.ok(appJs.includes('nost-pass'), 'Initial password field in orgAddStaffModal');
  assert.ok(appJs.includes('Full direct access granted to Workout Builder, Nutrition'), 'Full access notice in orgAddStaffModal');
  assert.ok(appJs.includes('org-open-coach-programming'), 'Direct programming action button in staff table');
  assert.ok(appJs.includes('org-open-coach-nutrition'), 'Direct nutrition action button in staff table');
  assert.ok(appJs.includes("['builder', 'Workout Programming', 'dumbbell']"), 'Workout Programming in Executive Nav');
  assert.ok(appJs.includes("['nutrition', 'Nutrition Hub', 'utensils']"), 'Nutrition Hub in Executive Nav');
  assert.ok(appJs.includes('حساب مربیگری شما در «'), 'Persian invite includes direct access credentials & link');
  pass('UI elements for direct coach access in app.js verified');

  console.log('\nDIRECT_COACH_ACCESS: All 8 checks passed successfully!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
