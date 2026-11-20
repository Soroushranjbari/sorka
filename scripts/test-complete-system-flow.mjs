// CoachMint — Complete Master System Flow Verification Test
// Tests:
//   Phase 1: Solo Coach Purchase & Workspace Isolation
//   Phase 2: Gym Club Purchase & Executive Console Setup
//   Phase 3: Staff Invitation & Trainer Dashboard Onboarding
//   Phase 4: Multi-Tenant Data Sync & Security Boundary
//   Phase 5: Anti-Poaching Client Reassignment & Offboarding
//   Phase 6: Quota Enforcement & Boundary Defenses
//   Phase 7: Full UI/UX App Shell Rendering in Desktop & Mobile (EN, FA, TR)

import handleShopCheckout from '../backend/handlers/shop-checkout.mjs';
import handleAuth from '../backend/handlers/auth.mjs';
import handleOrg from '../backend/handlers/org.mjs';
import handleData from '../backend/handlers/data.mjs';
import { store } from '../backend/lib/saas.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(desc, condition, extra = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${desc}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${desc} ${extra}`);
  }
}

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

// Setup VM Sandbox for App Shell testing
function createUiSandbox(html, appJs) {
  class MockElement {
    constructor(tag, id = '') {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.className = '';
      this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
      this.style = { setProperty: (k, v) => { this.style[k] = v; }, removeProperty: (k) => { delete this.style[k]; } };
      this.dataset = {};
      this.children = [];
      this.innerHTML = '';
      this.value = '';
      this.textContent = '';
    }
    setAttribute(k, v) { this[k] = v; }
    getAttribute(k) { return this[k] || null; }
    querySelector() { return new MockElement('div'); }
    querySelectorAll() { return [new MockElement('div')]; }
    addEventListener() {}
    removeEventListener() {}
    appendChild(el) { this.children.push(el); return el; }
    removeChild() {}
    focus() {}
    blur() {}
    scrollIntoView() {}
  }

  const elementsById = new Map();
  elementsById.set('app', new MockElement('div', 'app'));

  const mockDoc = {
    getElementById: (id) => {
      if (!elementsById.has(id)) elementsById.set(id, new MockElement('div', id));
      return elementsById.get(id);
    },
    querySelector: (sel) => {
      if (sel && sel.startsWith('#')) return mockDoc.getElementById(sel.slice(1));
      return new MockElement('div');
    },
    querySelectorAll: () => [new MockElement('div')],
    createElement: (tag) => new MockElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new MockElement('html'),
    body: new MockElement('body'),
    title: 'CoachMint',
    cookie: '',
    location: { href: 'http://localhost:8888/', pathname: '/', search: '', hash: '' }
  };

  const storeMap = new Map();
  const mockLocalStorage = {
    getItem: (k) => storeMap.get(k) || null,
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: (k) => storeMap.delete(k),
    clear: () => storeMap.clear()
  };

  class MockAudio {
    constructor() { this.paused = true; }
    play() { return Promise.resolve(); }
    pause() {}
  }

  const sandbox = {
    document: mockDoc,
    localStorage: mockLocalStorage,
    sessionStorage: mockLocalStorage,
    navigator: { userAgent: 'Mozilla/5.0 Chrome', onLine: true },
    location: mockDoc.location,
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    lucide: null,
    Audio: MockAudio,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    Notification: { permission: 'default', requestPermission: async () => 'granted' },
    performance: globalThis.performance || { now: () => Date.now() },
    console, URL, URLSearchParams, Date, Math, JSON, Intl
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(appJs, ctx);
  return { ctx, sandbox };
}

async function runMasterTest() {
  console.log('================================================================');
  console.log('   COACHMINT MASTER END-TO-END VERIFICATION: SOLO vs B2B GYM   ');
  console.log('================================================================\n');

  const st = store();
  const ts = Date.now();
  const appJs = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  // ====================================================================
  // PHASE 1: Solo Coach Purchase & Workspace Isolation
  // ====================================================================
  console.log('--- PHASE 1: Solo Freelance Coach Flow ---');
  const soloEmail = `solo_coach_${ts}@example.com`;
  
  // 1.1 Shop Checkout for Solo Pro
  // 1.1 Shop Checkout for Solo Pro (professional tier)
  const soloCheckoutReq = mockReq('POST', '/shop/api/checkout', {
    planId: 'professional',
    email: soloEmail,
    name: 'Mahan Farhadi',
    phone: '09121112233'
  });
  const soloCheckoutRes = await handleShopCheckout(soloCheckoutReq);
  const soloCheckoutData = await soloCheckoutRes.json();
  assert('Solo coach checkout returns 200', soloCheckoutRes.status === 200 && soloCheckoutData.ok);
  const soloCoupon = soloCheckoutData.coupons?.[0];

  // Seed coupon into DB if demo
  if (soloCoupon) {
    await st.setJSON(`coupon:${soloCoupon}`, {
      code: soloCoupon,
      planId: 'professional',
      durationDays: 30,
      maxUses: 1,
      usedCount: 0,
      isActive: true,
      createdAt: Date.now()
    });
  }

  // 1.2 Solo Coach Signup with Coupon
  const soloSignupReq = mockReq('POST', '/api/auth/signup', {
    name: 'Mahan Farhadi',
    email: soloEmail,
    password: 'soloPassword123!',
    coupon: soloCoupon
  });
  const soloSignupRes = await handleAuth(soloSignupReq);
  const soloSignupData = await soloSignupRes.json();
  assert('Solo coach signup succeeds and activates Professional plan', soloSignupRes.status === 200 && soloSignupData.access?.plan === 'professional');
  const soloToken = soloSignupData.token;
  const soloWsCode = soloSignupData.workspace?.code;

  // 1.3 Solo Coach Org Check (/api/org/me returns null)
  const soloOrgReq = mockReq('GET', '/api/org/me', null, { authorization: `Bearer ${soloToken}` });
  const soloOrgRes = await handleOrg(soloOrgReq);
  const soloOrgData = await soloOrgRes.json();
  assert('Solo coach has no org (org is null)', soloOrgData.org === null && !soloOrgData.isGym);

  // 1.4 Solo Coach UI Shell Verification in VM
  const { ctx: soloCtx } = createUiSandbox(indexHtml, appJs);
  vm.runInContext(`
    AUTH.token = "${soloToken}";
    AUTH.coach = ${JSON.stringify(soloSignupData.coach)};
    AUTH.ws = ${JSON.stringify(soloSignupData.workspace)};
    S.org = null;
    S.isGymOwner = false;
    S.orgRole = null;
    S.workspaceMode = 'coach';
    S.view = 'dash';
  `, soloCtx);
  const soloShellHtml = vm.runInContext(`shell(currentView())`, soloCtx);
  assert('Solo coach shell renders COACHMINT solo branding', soloShellHtml.includes('ONE COACH. ONE WORKSPACE.'));
  assert('Solo coach shell does NOT show Executive Console header', !soloShellHtml.includes('EXECUTIVE CONSOLE'));
  assert('Solo coach shell does NOT show Workspace Switcher', !soloShellHtml.includes('data-act="set-ws-mode"'));
  assert('Solo coach shell does NOT show Quotas Badge', !soloShellHtml.includes('Organization Resource Quotas'));
  assert('Solo coach nav includes Dashboard and Workouts', soloShellHtml.includes('data-view="dash"') && soloShellHtml.includes('data-view="builder"'));

  // ====================================================================
  // PHASE 2: Gym Organization Purchase & Executive Console Setup
  // ====================================================================
  console.log('\n--- PHASE 2: Gym Organization Flow ---');
  const gymOwnerEmail = `gym_owner_${ts}@titanfit.com`;

  // 2.1 Checkout for Gym Chain
  const gymCheckoutReq = mockReq('POST', '/shop/api/checkout', {
    planId: 'gym_chain',
    email: gymOwnerEmail,
    name: 'Arash Rad',
    phone: '09129998877'
  });
  const gymCheckoutRes = await handleShopCheckout(gymCheckoutReq);
  const gymCheckoutData = await gymCheckoutRes.json();
  assert('Gym checkout returns 200 and coupon', gymCheckoutRes.status === 200 && gymCheckoutData.ok);
  const gymCoupon = gymCheckoutData.coupons?.[0];

  if (gymCoupon) {
    await st.setJSON(`coupon:${gymCoupon}`, {
      code: gymCoupon,
      planId: 'gym_chain',
      durationDays: 30,
      maxUses: 1,
      usedCount: 0,
      isActive: true,
      createdAt: Date.now()
    });
  }

  // 2.2 Gym Owner Signup
  const gymSignupReq = mockReq('POST', '/api/auth/signup', {
    name: 'Arash Rad',
    email: gymOwnerEmail,
    password: 'gymOwnerPass123!',
    coupon: gymCoupon
  });
  const gymSignupRes = await handleAuth(gymSignupReq);
  const gymSignupData = await gymSignupRes.json();
  assert('Gym owner signup succeeds with gym_chain plan', gymSignupRes.status === 200 && gymSignupData.access?.plan === 'gym_chain');
  const gymOwnerToken = gymSignupData.token;
  const gymOwnerCoachId = gymSignupData.coach?.id;
  const gymWsCode = gymSignupData.workspace?.code;

  // 2.3 Create Org (/api/org/create) with custom primary branch
  const createOrgReq = mockReq('POST', '/api/org/create', {
    name: 'Titan Fitness Clubs',
    primaryBranchName: 'Zafaranieh Central HQ'
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const createOrgRes = await handleOrg(createOrgReq);
  const createOrgData = await createOrgRes.json();
  assert('Organization created with custom HQ branch name', createOrgRes.status === 200 && createOrgData.org?.branches?.[0]?.name === 'Zafaranieh Central HQ');
  const orgId = createOrgData.org.id;
  const hqBranchId = createOrgData.org.branches[0].id;

  // 2.4 Add Second Branch (/api/org/branch)
  const addBranchReq = mockReq('POST', '/api/org/branch', {
    name: 'Shahrak Gharb Studio',
    address: 'Dadman Blvd',
    phone: '021-88442211',
    isHQ: false
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const addBranchRes = await handleOrg(addBranchReq);
  const addBranchData = await addBranchRes.json();
  assert('Second branch added successfully', addBranchRes.status === 200 && addBranchData.branch?.name === 'Shahrak Gharb Studio');
  const branch2Id = addBranchData.branch.id;

  // 2.5 Add Smart Machine (/api/org/machine)
  const addMachineReq = mockReq('POST', '/api/org/machine', {
    code: 'LP-01',
    name: 'Incline Leg Press 45',
    brand: 'Technogym Pure',
    branchId: hqBranchId,
    adjustments: { seatPin: 4, safetyPin: 2 },
    cues: 'Full depth knee flexion'
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const addMachineRes = await handleOrg(addMachineReq);
  const addMachineData = await addMachineRes.json();
  assert('Smart machine added to org with JSON adjustments', addMachineRes.status === 200 && addMachineData.machine?.code === 'LP-01');

  // ====================================================================
  // PHASE 3: Staff Invitation & Trainer Dashboard Onboarding
  // ====================================================================
  console.log('\n--- PHASE 3: Staff Invitation & Trainer Onboarding Flow ---');
  const trainer1Email = `trainer_reza_${ts}@titanfit.com`;
  const trainer2Email = `trainer_sara_${ts}@titanfit.com`;

  // 3.1 Owner adds Trainer 1 (Reza) to HQ
  const addTrainer1Req = mockReq('POST', '/api/org/staff', {
    name: 'Reza Trainer',
    email: trainer1Email,
    role: 'trainer',
    branches: [hqBranchId]
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const addTrainer1Res = await handleOrg(addTrainer1Req);
  const addTrainer1Data = await addTrainer1Res.json();
  assert('Trainer 1 added to organization staff', addTrainer1Res.status === 200 && addTrainer1Data.staffMember?.email === trainer1Email);

  // 3.2 Owner adds Trainer 2 (Sara) to Branch 2
  const addTrainer2Req = mockReq('POST', '/api/org/staff', {
    name: 'Sara Trainer',
    email: trainer2Email,
    role: 'trainer',
    branches: [branch2Id]
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const addTrainer2Res = await handleOrg(addTrainer2Req);
  const addTrainer2Data = await addTrainer2Res.json();
  assert('Trainer 2 added to organization staff', addTrainer2Res.status === 200 && addTrainer2Data.staffMember?.email === trainer2Email);

  // 3.3 Trainer 1 signs up with their invited email
  const trainer1SignupReq = mockReq('POST', '/api/auth/signup', {
    name: 'Reza Trainer',
    email: trainer1Email,
    password: 'rezaPassword123!'
  });
  const trainer1SignupRes = await handleAuth(trainer1SignupReq);
  const trainer1SignupData = await trainer1SignupRes.json();
  assert('Trainer 1 sign-up succeeds', trainer1SignupRes.status === 200 && trainer1SignupData.ok);
  const trainer1Token = trainer1SignupData.token;
  const trainer1CoachId = trainer1SignupData.coach?.id;

  // 3.4 Trainer 1 checks /api/org/me
  const trainer1OrgReq = mockReq('GET', '/api/org/me', null, { authorization: `Bearer ${trainer1Token}` });
  const trainer1OrgRes = await handleOrg(trainer1OrgReq);
  const trainer1OrgData = await trainer1OrgRes.json();
  assert('Trainer 1 is recognized as org member with role "trainer"', trainer1OrgData.role === 'trainer' && !trainer1OrgData.isOwner);

  // 3.5 Trainer 1 UI Shell in VM: Must land on Coach Desk (Dashboard), NOT Executive Console
  const { ctx: trainerCtx } = createUiSandbox(indexHtml, appJs);
  vm.runInContext(`
    AUTH.token = "${trainer1Token}";
    AUTH.coach = ${JSON.stringify(trainer1SignupData.coach)};
    S.org = ${JSON.stringify(trainer1OrgData.org)};
    S.orgRole = "${trainer1OrgData.role}";
    S.isGymOwner = false;
    S.workspaceMode = 'coach';
    S.view = 'dash';
  `, trainerCtx);
  const trainerShellHtml = vm.runInContext(`shell(currentView())`, trainerCtx);
  assert('Trainer shell renders solo coach branding (COACHMINT)', trainerShellHtml.includes('ONE COACH. ONE WORKSPACE.'));
  assert('Trainer shell does NOT render Executive Console banner', !trainerShellHtml.includes('EXECUTIVE CONSOLE'));
  assert('Trainer shell does NOT render Workspace Switcher', !trainerShellHtml.includes('data-act="set-ws-mode"'));
  assert('Trainer shell renders Rest Timer and Coach sport badge', trainerShellHtml.includes('topbar-timer-btn') || trainerShellHtml.includes('Timer'));

  // ====================================================================
  // PHASE 4: Multi-Tenant Data Sync & Tenant Isolation
  // ====================================================================
  console.log('\n--- PHASE 4: Multi-Tenant Sync & Tenant Isolation Flow ---');

  // 4.1 Owner seeds clients into Gym Workspace
  const initialClients = [
    { id: 101, name: 'Arman Athlete', assignedCoachId: trainer1CoachId, branchId: hqBranchId, status: 'Active' },
    { id: 102, name: 'Neda Athlete', assignedCoachId: trainer1CoachId, branchId: hqBranchId, status: 'Active' },
    { id: 103, name: 'Siamak Athlete', assignedCoachId: trainer1CoachId, branchId: hqBranchId, status: 'Active' }
  ];
  const ownerPutReq = mockReq('PUT', `/api/data?code=${gymWsCode}`, {
    rev: 0,
    data: { CLIENTS: initialClients }
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const ownerPutRes = await handleData(ownerPutReq);
  const ownerPutData = await ownerPutRes.json();
  assert('Owner successfully writes data to gym workspace', ownerPutRes.status === 200 && ownerPutData.ok);

  // 4.2 Trainer 1 reads the Gym Workspace
  const trainerGetReq = mockReq('GET', `/api/data?code=${gymWsCode}`, null, { authorization: `Bearer ${trainer1Token}` });
  const trainerGetRes = await handleData(trainerGetReq);
  const trainerGetData = await trainerGetRes.json();
  assert('Trainer 1 reads gym workspace without foreign error', trainerGetRes.status === 200 && trainerGetData.mine && trainerGetData.data?.CLIENTS?.length === 3);

  // 4.3 Trainer 1 writes workout update to Gym Workspace using the latest rev
  initialClients[0].lastWorkout = 'Chest Day 4x10';
  const trainerPutReq = mockReq('PUT', `/api/data?code=${gymWsCode}`, {
    rev: trainerGetData.rev,
    data: { CLIENTS: initialClients }
  }, { authorization: `Bearer ${trainer1Token}` });
  const trainerPutRes = await handleData(trainerPutReq);
  const trainerPutData = await trainerPutRes.json();
  assert('Trainer 1 successfully updates workout in gym workspace (no 403 foreign)', trainerPutRes.status === 200 && trainerPutData.ok);

  // 4.4 Solo Coach from Phase 1 attempts to write to Gym Workspace (Security Breach Test)
  const soloHackerPutReq = mockReq('PUT', `/api/data?code=${gymWsCode}`, {
    rev: trainerPutData.rev,
    data: { CLIENTS: initialClients }
  }, { authorization: `Bearer ${soloToken}` });
  const soloHackerPutRes = await handleData(soloHackerPutReq);
  const soloHackerPutData = await soloHackerPutRes.json();
  assert('Unauthorized Solo coach is BLOCKED from writing to gym workspace (403 foreign)', soloHackerPutRes.status === 403 && soloHackerPutData.error === 'foreign');

  // ====================================================================
  // PHASE 5: Anti-Poaching Client Reassignment & Offboarding Flow
  // ====================================================================
  console.log('\n--- PHASE 5: Anti-Poaching Roster Transfer Flow ---');

  // 5.1 Trainer 2 signs up
  const trainer2SignupReq = mockReq('POST', '/api/auth/signup', {
    name: 'Sara Trainer',
    email: trainer2Email,
    password: 'saraPassword123!'
  });
  const trainer2SignupRes = await handleAuth(trainer2SignupReq);
  const trainer2SignupData = await trainer2SignupRes.json();
  const trainer2CoachId = trainer2SignupData.coach?.id;
  assert('Trainer 2 signs up successfully', trainer2SignupRes.status === 200 && !!trainer2CoachId);

  // 5.2 Trainer 1 departs gym. Owner transfers all athletes of Trainer 1 to Trainer 2 at Branch 2
  const reassignReq = mockReq('POST', '/api/org/reassign', {
    clientIds: [101, 102, 103],
    targetCoachId: trainer2CoachId,
    targetBranchId: branch2Id
  }, { authorization: `Bearer ${gymOwnerToken}` });
  const reassignRes = await handleOrg(reassignReq);
  const reassignData = await reassignRes.json();
  assert('Anti-Poaching transfer reassigns all 3 athletes successfully', reassignRes.status === 200 && reassignData.reassignedCount === 3);

  // 5.3 Verify data in gym workspace reflects the transfer
  const gymDataCheckReq = mockReq('GET', `/api/data?code=${gymWsCode}`, null, { authorization: `Bearer ${gymOwnerToken}` });
  const gymDataCheckRes = await handleData(gymDataCheckReq);
  const gymDataCheck = await gymDataCheckRes.json();
  const allReassigned = gymDataCheck.data?.CLIENTS?.every(c => c.assignedCoachId === trainer2CoachId && c.branchId === branch2Id);
  assert('All 3 athletes now belong to Trainer 2 at Branch 2 in cloud DB', allReassigned);

  // 5.4 Remove Trainer 1 from staff
  const removeStaffReq = mockReq('DELETE', `/api/org/staff?coachId=${trainer1CoachId}`, null, { authorization: `Bearer ${gymOwnerToken}` });
  const removeStaffRes = await handleOrg(removeStaffReq);
  const removeStaffData = await removeStaffRes.json();
  assert('Departed Trainer 1 successfully removed from staff', removeStaffRes.status === 200 && removeStaffData.ok);

  // ====================================================================
  // PHASE 6: Boundary Defense & Quota Enforcement
  // ====================================================================
  console.log('\n--- PHASE 6: Boundary & Quota Enforcement ---');

  // 6.1 Owner cannot be removed
  const removeOwnerReq = mockReq('DELETE', `/api/org/staff?coachId=${gymOwnerCoachId}`, null, { authorization: `Bearer ${gymOwnerToken}` });
  const removeOwnerRes = await handleOrg(removeOwnerReq);
  const removeOwnerData = await removeOwnerRes.json();
  assert('Attempt to remove owner is strictly rejected', removeOwnerRes.status === 400 && removeOwnerData.error === 'cannot-remove-owner');

  // 6.2 Trainer 2 cannot call manager endpoints (e.g. add branch)
  const unauthorizedBranchReq = mockReq('POST', '/api/org/branch', {
    name: 'Illegal Branch'
  }, { authorization: `Bearer ${trainer2SignupData.token}` });
  const unauthorizedBranchRes = await handleOrg(unauthorizedBranchReq);
  assert('Trainer 2 cannot add branches (403 forbidden)', unauthorizedBranchRes.status === 403);

  // ====================================================================
  // PHASE 7: App Shell UI Rendering Across All Locales (EN, FA, TR)
  // ====================================================================
  console.log('\n--- PHASE 7: UI & Internationalization Parity (EN, FA, TR) ---');
  const { ctx: execCtx } = createUiSandbox(indexHtml, appJs);
  vm.runInContext(`
    AUTH.token = "${gymOwnerToken}";
    AUTH.coach = ${JSON.stringify(gymSignupData.coach)};
    S.org = {
      id: "${orgId}",
      name: "Titan Fitness Clubs",
      plan: "gym_chain",
      quotas: { branches: 5, staff: 25, athletes: 500 },
      branches: [
        { id: "${hqBranchId}", name: "Zafaranieh Central HQ", isHQ: true },
        { id: "${branch2Id}", name: "Shahrak Gharb Studio", isHQ: false }
      ],
      staff: [
        { coachId: "${gymOwnerCoachId}", name: "Arash Rad", role: "gym_owner", email: "${gymOwnerEmail}", branches: ["*"] },
        { coachId: "${trainer2CoachId}", name: "Sara Trainer", role: "trainer", email: "${trainer2Email}", branches: ["${branch2Id}"] }
      ]
    };
    S.isGymOwner = true;
    S.orgRole = "gym_owner";
    S.workspaceMode = "executive";
    S.view = "org";
    S.orgTab = "overview";
  `, execCtx);

  const testLangs = ['en', 'fa', 'tr'];
  for (const l of testLangs) {
    vm.runInContext(`lang = "${l}"; applyLang();`, execCtx);
    
    // Executive Overview
    vm.runInContext(`S.view = "org"; S.orgTab = "overview";`, execCtx);
    const execOverview = vm.runInContext(`shell(currentView())`, execCtx);
    assert(`Executive Overview renders cleanly in [${l}]`, execOverview.includes('Titan Fitness Clubs'));

    // Executive Staff Tab
    vm.runInContext(`S.orgTab = "staff";`, execCtx);
    const execStaff = vm.runInContext(`currentView()`, execCtx);
    assert(`Staff & Trainers tab renders cleanly in [${l}]`, execStaff.includes('Sara Trainer'));

    // Executive Branches Tab
    vm.runInContext(`S.orgTab = "branches";`, execCtx);
    const execBranches = vm.runInContext(`currentView()`, execCtx);
    assert(`Branches tab renders cleanly in [${l}]`, execBranches.includes('Zafaranieh Central HQ'));

    // Executive Anti-Poaching Reassign Tab
    vm.runInContext(`S.orgTab = "reassign";`, execCtx);
    const execReassign = vm.runInContext(`currentView()`, execCtx);
    assert(`Anti-Poaching Transfer tab renders cleanly in [${l}]`, execReassign.includes('Sara Trainer') || execReassign.includes('Transfer'));

    // Master Roster View
    vm.runInContext(`S.view = "clients";`, execCtx);
    const masterRoster = vm.runInContext(`currentView()`, execCtx);
    assert(`Master Roster view renders cleanly in [${l}]`, masterRoster.includes('tbl') || masterRoster.includes('cgrid'));

    // Switch to Personal Coach Desk Mode
    vm.runInContext(`S.workspaceMode = "coach"; S.view = "dash";`, execCtx);
    const coachDesk = vm.runInContext(`shell(currentView())`, execCtx);
    assert(`Personal Coach Desk mode renders cleanly in [${l}]`, coachDesk.includes('ONE COACH. ONE WORKSPACE.'));
    
    // Switch back to Executive Mode
    vm.runInContext(`S.workspaceMode = "executive"; S.view = "org"; S.orgTab = "overview";`, execCtx);
  }

  console.log('\n================================================================');
  console.log(`MASTER TEST SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} total tests`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runMasterTest().catch(err => {
  console.error('Master Test Fatal Error:', err);
  process.exit(1);
});
