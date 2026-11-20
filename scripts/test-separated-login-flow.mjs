// CoachMint — Separated Login & Entry Routes (Solo Coach vs Club/Org) Test.
import assert from 'node:assert';
import authHandler from '../backend/handlers/auth.mjs';
import orgHandler from '../backend/handlers/org.mjs';

console.log('== SEPARATED LOGIN & ENTRY ROUTES TEST ==');

async function testFlows() {
  const ts = Date.now();

  // 1. Solo Coach Signup
  console.log('1. Testing Solo Coach Signup...');
  const soloEmail = `solo_coach_${ts}@test.com`;
  const soloReq = new Request('http://localhost:8888/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Solo Trainer Reza',
      email: soloEmail,
      password: 'password123',
      accountType: 'coach',
      portal: 'coach'
    })
  });
  const soloRes = await authHandler(soloReq);
  assert.strictEqual(soloRes.status, 200, 'Solo coach signup should succeed');
  const soloData = await soloRes.json();
  assert.strictEqual(soloData.ok, true);
  assert.strictEqual(soloData.coach.name, 'Solo Trainer Reza');
  assert.strictEqual(soloData.coach.isOrg, false);
  assert.strictEqual(soloData.coach.plan, 'trial');
  console.log('   ✓ Solo coach account created as single-trainer workspace');

  // Verify Solo Coach org check
  const soloOrgReq = new Request('http://localhost:8888/api/org/me', {
    method: 'GET',
    headers: { 'authorization': `Bearer ${soloData.token}` }
  });
  const soloOrgRes = await orgHandler(soloOrgReq);
  const soloOrgData = await soloOrgRes.json();
  assert.strictEqual(soloOrgData.ok, true);
  assert.strictEqual(soloOrgData.org, null, 'Solo coach should not have an auto-provisioned organization');
  console.log('   ✓ Solo coach does not have an org workspace');

  // 2. Organization / Club Signup
  console.log('\n2. Testing Organization / Club Signup...');
  const orgEmail = `gym_manager_${ts}@testclub.com`;
  const orgReq = new Request('http://localhost:8888/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Manager Kaveh',
      email: orgEmail,
      password: 'password123',
      accountType: 'org',
      portal: 'org',
      orgName: 'Oxygen Fitness Club'
    })
  });
  const orgRes = await authHandler(orgReq);
  assert.strictEqual(orgRes.status, 200, 'Org signup should succeed');
  const orgData = await orgRes.json();
  assert.strictEqual(orgData.ok, true);
  assert.strictEqual(orgData.coach.name, 'Manager Kaveh');
  assert.strictEqual(orgData.coach.isOrg, true);
  assert.strictEqual(orgData.coach.plan, 'gym_studio');
  console.log('   ✓ Club/Org account created with gym_studio plan & isOrg flag');

  // Verify Org was auto-provisioned upon registration
  const clubOrgReq = new Request('http://localhost:8888/api/org/me', {
    method: 'GET',
    headers: { 'authorization': `Bearer ${orgData.token}` }
  });
  const clubOrgRes = await orgHandler(clubOrgReq);
  const clubOrgData = await clubOrgRes.json();
  assert.strictEqual(clubOrgData.ok, true);
  assert.ok(clubOrgData.org, 'Org must be provisioned');
  assert.strictEqual(clubOrgData.org.name, 'Oxygen Fitness Club');
  assert.strictEqual(clubOrgData.role, 'gym_owner');
  assert.strictEqual(clubOrgData.branches.length, 1);
  console.log('   ✓ Organization headquarters auto-provisioned: ' + clubOrgData.org.name);

  // 3. Login through specific portals
  console.log('\n3. Testing Portal-Specific Sign In...');
  const loginSoloReq = new Request('http://localhost:8888/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: soloEmail,
      password: 'password123',
      portal: 'coach'
    })
  });
  const loginSoloRes = await authHandler(loginSoloReq);
  assert.strictEqual(loginSoloRes.status, 200);
  const loginSoloData = await loginSoloRes.json();
  assert.strictEqual(loginSoloData.portal, 'coach');
  console.log('   ✓ Solo coach signed in via coach portal');

  const loginOrgReq = new Request('http://localhost:8888/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: orgEmail,
      password: 'password123',
      portal: 'org'
    })
  });
  const loginOrgRes = await authHandler(loginOrgReq);
  assert.strictEqual(loginOrgRes.status, 200);
  const loginOrgData = await loginOrgRes.json();
  assert.strictEqual(loginOrgData.portal, 'org');
  console.log('   ✓ Organization manager signed in via org portal');

  console.log('\nALL SEPARATED LOGIN TESTS PASSED! ✓');
}

testFlows().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
