// CoachMint — Full Journey Audit: Shop -> Signup -> Auth -> Org -> Staff -> Reassign -> Machines -> Multi-tenant Data
import handleShopCheckout from '../backend/handlers/shop-checkout.mjs';
import handleShopAccount from '../backend/handlers/shop-account.mjs';
import handleAuth from '../backend/handlers/auth.mjs';
import handleOrg from '../backend/handlers/org.mjs';
import handleData from '../backend/handlers/data.mjs';
import { store } from '../backend/lib/saas.mjs';

function mockReq(method, path, body = null, headers = {}) {
  const url = `http://localhost:8888${path}`;
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

async function runAudit() {
  console.log('=====================================================');
  console.log('   COACHMINT ARCHITECTURE AUDIT: GYM / ORG JOURNEY   ');
  console.log('=====================================================\n');

  const st = store();
  const timestamp = Date.now();
  const ownerEmail = `gym_founder_${timestamp}@chainfit.com`;
  const trainerEmail = `trainer_ali_${timestamp}@chainfit.com`;

  // ----------------------------------------------------
  // STEP 1: Shop Checkout (simulate shop/checkout.html -> /shop/api/checkout)
  // ----------------------------------------------------
  console.log('--- STEP 1: Shop Checkout for Gym Chain ---');
  // In demo mode, shop checkout creates a coupon. Let's seed an issued coupon directly if COACH_OS_URL is not set
  const checkoutReq = mockReq('POST', '/shop/api/checkout', {
    planId: 'gym_chain',
    email: ownerEmail,
    name: 'Kaveh Khosravi',
    phone: '09121234567'
  });
  const checkoutRes = await handleShopCheckout(checkoutReq);
  const checkoutData = await checkoutRes.json();
  console.log('Checkout response status:', checkoutRes.status, checkoutData);

  const couponCode = checkoutData.coupons?.[0];
  if (checkoutData.demo && couponCode) {
    console.log('[Notice] Demo coupon generated. Storing in DB to simulate coupon issuance...');
    await st.setJSON(`coupon:${couponCode}`, {
      code: couponCode,
      planId: 'gym_chain',
      durationDays: 30,
      maxUses: 1,
      usedCount: 0,
      isActive: true,
      createdAt: Date.now()
    });
  }

  // ----------------------------------------------------
  // STEP 2: Registration / Signup (shop/checkout.html -> /api/auth/signup)
  // ----------------------------------------------------
  console.log('\n--- STEP 2: Signup with Gym Coupon ---');
  const signupReq = mockReq('POST', '/api/auth/signup', {
    name: 'Kaveh Khosravi',
    email: ownerEmail,
    password: 'securePassword123!',
    coupon: couponCode
  });
  const signupRes = await handleAuth(signupReq);
  const signupData = await signupRes.json();
  console.log('Signup status:', signupRes.status, {
    ok: signupData.ok,
    coachId: signupData.coach?.id,
    plan: signupData.coach?.plan,
    access: signupData.access,
    redeemed: signupData.redeemed,
    redeemError: signupData.redeemError
  });

  const ownerToken = signupData.token;
  const ownerAuthHeader = { 'authorization': `Bearer ${ownerToken}` };

  // ----------------------------------------------------
  // STEP 3: Login & /api/auth/me
  // ----------------------------------------------------
  console.log('\n--- STEP 3: App Boot /api/auth/me ---');
  const meReq = mockReq('GET', '/api/auth/me', null, ownerAuthHeader);
  const meRes = await handleAuth(meReq);
  const meData = await meRes.json();
  console.log('Auth Me status:', meRes.status, {
    coach: meData.coach,
    access: meData.access,
    workspace: meData.workspace
  });

  // ----------------------------------------------------
  // STEP 4: Org Me BEFORE Creation (/api/org/me)
  // ----------------------------------------------------
  console.log('\n--- STEP 4: Org Me Before Creation ---');
  const orgMeReq1 = mockReq('GET', '/api/org/me', null, ownerAuthHeader);
  const orgMeRes1 = await handleOrg(orgMeReq1);
  const orgMeData1 = await orgMeRes1.json();
  console.log('Org Me 1 status:', orgMeRes1.status, orgMeData1);

  // ----------------------------------------------------
  // STEP 5: Create Org (/api/org/create)
  // ----------------------------------------------------
  console.log('\n--- STEP 5: Create Org (/api/org/create) with primaryBranchName ---');
  const createOrgReq = mockReq('POST', '/api/org/create', {
    name: 'ChainFit Fitness Club',
    primaryBranchName: 'Zafaranieh Central HQ'
  }, ownerAuthHeader);
  const createOrgRes = await handleOrg(createOrgReq);
  const createOrgData = await createOrgRes.json();
  console.log('Create Org status:', createOrgRes.status, createOrgData);
  console.log('Primary Branch Name created on server:', createOrgData.org?.branches?.[0]?.name);

  // ----------------------------------------------------
  // STEP 6: Add Branch (/api/org/branch)
  // ----------------------------------------------------
  console.log('\n--- STEP 6: Add Branch (/api/org/branch) ---');
  const addBranchReq = mockReq('POST', '/api/org/branch', {
    name: 'Shahrak Gharb Branch',
    address: 'Dadman Blvd',
    phone: '021-88334455',
    isHQ: false
  }, ownerAuthHeader);
  const addBranchRes = await handleOrg(addBranchReq);
  const addBranchData = await addBranchRes.json();
  console.log('Add Branch status:', addBranchRes.status, addBranchData);

  // ----------------------------------------------------
  // STEP 7: Add Staff Member (/api/org/staff)
  // ----------------------------------------------------
  console.log('\n--- STEP 7: Add Staff Member Ali (/api/org/staff) ---');
  const addStaffReq = mockReq('POST', '/api/org/staff', {
    name: 'Ali Trainer',
    email: trainerEmail,
    role: 'trainer',
    branches: ['*']
  }, ownerAuthHeader);
  const addStaffRes = await handleOrg(addStaffReq);
  const addStaffData = await addStaffRes.json();
  console.log('Add Staff status:', addStaffRes.status, {
    ok: addStaffData.ok,
    hasStaffMemberProp: 'staffMember' in addStaffData,
    hasStaffProp: 'staff' in addStaffData, // Frontend expects d.staff!
    staffMember: addStaffData.staffMember
  });

  // ----------------------------------------------------
  // STEP 8: Staff Member Signup & /api/org/me Check!
  // ----------------------------------------------------
  console.log('\n--- STEP 8: Staff Member Ali Signs Up & Checks Org Me ---');
  const trainerSignupReq = mockReq('POST', '/api/auth/signup', {
    name: 'Ali Trainer',
    email: trainerEmail,
    password: 'aliPassword123!'
  });
  const trainerSignupRes = await handleAuth(trainerSignupReq);
  const trainerSignupData = await trainerSignupRes.json();
  console.log('Trainer Signup status:', trainerSignupRes.status, {
    coachId: trainerSignupData.coach?.id,
    plan: trainerSignupData.coach?.plan
  });

  const trainerToken = trainerSignupData.token;
  const trainerAuthHeader = { 'authorization': `Bearer ${trainerToken}` };

  const trainerOrgMeReq = mockReq('GET', '/api/org/me', null, trainerAuthHeader);
  const trainerOrgMeRes = await handleOrg(trainerOrgMeReq);
  const trainerOrgMeData = await trainerOrgMeRes.json();
  console.log('Trainer Org Me result:', trainerOrgMeRes.status, {
    ok: trainerOrgMeData.ok,
    orgId: trainerOrgMeData.org?.id,
    role: trainerOrgMeData.role,
    isOwner: trainerOrgMeData.isOwner
  });

  // ----------------------------------------------------
  // STEP 9: Reassign Athletes (Testing frontend payload shape!)
  // ----------------------------------------------------
  console.log('\n--- STEP 9: Reassign Athletes (/api/org/reassign) ---');
  // First test with FRONTEND payload ({ clientIds, targetCoachId, targetBranchId })
  const frontendReassignReq = mockReq('POST', '/api/org/reassign', {
    clientIds: [101, 102],
    targetCoachId: trainerSignupData.coach?.id || addStaffData.staffMember?.coachId,
    targetBranchId: 'br_hq'
  }, ownerAuthHeader);
  const frontendReassignRes = await handleOrg(frontendReassignReq);
  const frontendReassignData = await frontendReassignRes.json();
  console.log('Reassign with FRONTEND payload ({ targetCoachId }): status:', frontendReassignRes.status, frontendReassignData);

  // Now test with BACKEND payload ({ clientIds, toCoachId, toBranchId })
  const backendReassignReq = mockReq('POST', '/api/org/reassign', {
    clientIds: [101, 102],
    toCoachId: trainerSignupData.coach?.id || addStaffData.staffMember?.coachId,
    toBranchId: 'br_hq'
  }, ownerAuthHeader);
  const backendReassignRes = await handleOrg(backendReassignReq);
  const backendReassignData = await backendReassignRes.json();
  console.log('Reassign with BACKEND payload ({ toCoachId }): status:', backendReassignRes.status, backendReassignData);

  // ----------------------------------------------------
  // STEP 10: Multi-Tenant Data Access (/api/data)
  // ----------------------------------------------------
  console.log('\n--- STEP 10: Multi-Tenant Workspace Sync (/api/data) ---');
  const ownerWsCode = meData.workspace?.code;
  console.log('Owner Workspace Code:', ownerWsCode);

  // Owner writes gym clients to their workspace
  const ownerDataPutReq = mockReq('PUT', `/api/data?code=${ownerWsCode}`, {
    rev: 0,
    data: {
      CLIENTS: [
        { id: 101, name: 'Reza Rezaei', assignedCoachId: trainerSignupData.coach?.id, branchId: 'br_hq' },
        { id: 102, name: 'Sara Mohammadi', assignedCoachId: trainerSignupData.coach?.id, branchId: 'br_hq' }
      ]
    }
  }, ownerAuthHeader);
  const ownerDataPutRes = await handleData(ownerDataPutReq);
  const ownerDataPutData = await ownerDataPutRes.json();
  console.log('Owner PUT data status:', ownerDataPutRes.status, ownerDataPutData);

  // Can Trainer Ali READ the owner workspace?
  const trainerReadReq = mockReq('GET', `/api/data?code=${ownerWsCode}`, null, trainerAuthHeader);
  const trainerReadRes = await handleData(trainerReadReq);
  const trainerReadData = await trainerReadRes.json();
  console.log('Trainer GET owner workspace status:', trainerReadRes.status, {
    ok: trainerReadData.ok,
    mine: trainerReadData.mine,
    clientsCount: trainerReadData.data?.CLIENTS?.length
  });

  // Can Trainer Ali WRITE or UPDATE client progress in the owner workspace?
  const trainerWriteReq = mockReq('PUT', `/api/data?code=${ownerWsCode}`, {
    rev: ownerDataPutData.rev || 1,
    data: {
      CLIENTS: [
        { id: 101, name: 'Reza Rezaei', notes: 'Completed session 1', assignedCoachId: trainerSignupData.coach?.id, branchId: 'br_hq' }
      ]
    }
  }, trainerAuthHeader);
  const trainerWriteRes = await handleData(trainerWriteReq);
  const trainerWriteData = await trainerWriteRes.json();
  console.log('Trainer PUT owner workspace status:', trainerWriteRes.status, trainerWriteData);

  // ----------------------------------------------------
  // STEP 11: Smart Machine API (/api/org/machine)
  // ----------------------------------------------------
  console.log('\n--- STEP 11: Add Machine (/api/org/machine) ---');
  const machineReq = mockReq('POST', '/api/org/machine', {
    code: 'LP-01',
    name: 'Leg Press 45',
    brand: 'Technogym',
    adjustments: { seatPin: 4, backrestPos: 2 },
    cues: 'Keep knees aligned'
  }, ownerAuthHeader);
  const machineRes = await handleOrg(machineReq);
  const machineData = await machineRes.json();
  console.log('Machine Add status:', machineRes.status, {
    ok: machineData.ok,
    machineId: machineData.machine?.id,
    adjustments: machineData.machine?.adjustments
  });

  console.log('\n=====================================================');
  console.log('                  AUDIT FINISHED                     ');
  console.log('=====================================================');
}

runAudit().catch(console.error);
