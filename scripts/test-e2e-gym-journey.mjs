import { store } from '../backend/lib/saas.mjs';
import handleAuth from '../backend/handlers/auth.mjs';
import handleOrg from '../backend/handlers/org.mjs';
import handleBilling from '../backend/handlers/billing.mjs';

console.log('=== RUNNING REAL COUPON TEST ===');

async function mockReq(method, path, body = null, headers = {}) {
  const url = `http://localhost:3000${path}`;
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  };
  if (body) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(url, init);
}

async function run() {
  const st = store();
  const testEmail = `gym_owner_${Date.now()}@testgym.com`;

  // 1. Issue a real coupon for gym_studio in the database
  const code = 'GYM-REALTEST123';
  await st.setJSON(`coupon:${code}`, {
    code,
    planId: 'gym_studio',
    durationDays: 30,
    maxUses: 1,
    usedCount: 0,
    isActive: true,
    createdAt: Date.now()
  });
  console.log('Coupon stored in DB:', code);

  // 2. Signup with this coupon
  const signupReq = await mockReq('POST', '/api/auth/signup', {
    name: 'Tehran Gym HQ',
    email: testEmail,
    password: 'password12345',
    coupon: code
  });
  const signupRes = await handleAuth(signupReq);
  const signupData = await signupRes.json();
  console.log('Signup status:', signupRes.status, 'Response:', {
    ok: signupData.ok,
    coach: signupData.coach,
    access: signupData.access,
    redeemed: signupData.redeemed,
    redeemError: signupData.redeemError
  });

  const token = signupData.token;

  // 3. /api/auth/me
  const meReq = await mockReq('GET', '/api/auth/me', null, { 'authorization': `Bearer ${token}` });
  const meRes = await handleAuth(meReq);
  const meData = await meRes.json();
  console.log('\nAuth Me:', {
    plan: meData.coach?.plan,
    role: meData.coach?.role,
    access: meData.access
  });

  // 4. /api/org/me BEFORE createOrg
  const orgMeReq1 = await mockReq('GET', '/api/org/me', null, { 'authorization': `Bearer ${token}` });
  const orgMeRes1 = await handleOrg(orgMeReq1);
  const orgMeData1 = await orgMeRes1.json();
  console.log('\nOrg Me BEFORE create:', orgMeData1);

  // 5. /api/org/create
  const createOrgReq = await mockReq('POST', '/api/org/create', {
    name: 'Tehran Gym & Fitness Club',
    primaryBranchName: 'Zafaranieh HQ'
  }, { 'authorization': `Bearer ${token}` });
  const createOrgRes = await handleOrg(createOrgReq);
  const createOrgData = await createOrgRes.json();
  console.log('\nCreate Org result:', createOrgRes.status, createOrgData);

  // 6. /api/org/me AFTER createOrg
  const orgMeReq2 = await mockReq('GET', '/api/org/me', null, { 'authorization': `Bearer ${token}` });
  const orgMeRes2 = await handleOrg(orgMeReq2);
  const orgMeData2 = await orgMeRes2.json();
  console.log('\nOrg Me AFTER create:', orgMeData2);

  // 7. Add branch
  const addBranchReq = await mockReq('POST', '/api/org/branch', {
    name: 'Farmanieh VIP',
    address: 'Farmanieh St',
    phone: '021-22223333'
  }, { 'authorization': `Bearer ${token}` });
  const addBranchRes = await handleOrg(addBranchReq);
  const addBranchData = await addBranchRes.json();
  console.log('\nAdd Branch result:', addBranchRes.status, addBranchData);

  // 8. Add staff (Trainer)
  const addStaffReq = await mockReq('POST', '/api/org/staff', {
    name: 'Ali Coach',
    email: 'ali@testgym.com',
    role: 'trainer',
    branches: ['*']
  }, { 'authorization': `Bearer ${token}` });
  const addStaffRes = await handleOrg(addStaffReq);
  const addStaffData = await addStaffRes.json();
  console.log('\nAdd Staff (Trainer):', addStaffRes.status, addStaffData);

  // 9. Add Smart NFC Machine
  const addMachineReq = await mockReq('POST', '/api/org/machine', {
    code: 'LP-01',
    name: 'Leg Press 45',
    brand: 'Technogym',
    branchId: 'br_hq',
    ex: 'Leg Press',
    adjustments: { seatPin: 4, backrestPos: 2 },
    cues: 'Keep feet hip-width apart'
  }, { 'authorization': `Bearer ${token}` });
  const addMachineRes = await handleOrg(addMachineReq);
  const addMachineData = await addMachineRes.json();
  console.log('\nAdd Smart Machine:', addMachineRes.status, addMachineData);

  // 10. Reassign athletes
  const reassignReq = await mockReq('POST', '/api/org/reassign', {
    clientIds: ['c_101'],
    toCoachId: addStaffData.staff?.coachId,
    toBranchId: 'br_hq'
  }, { 'authorization': `Bearer ${token}` });
  const reassignRes = await handleOrg(reassignReq);
  const reassignData = await reassignRes.json();
  console.log('\nReassign Athletes:', reassignRes.status, reassignData);
}

run().catch(console.error);
