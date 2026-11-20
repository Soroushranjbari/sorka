// Test: B2B Organizational Plan Purchase -> Account Signup -> Direct App Entry
import assert from 'node:assert';
import checkoutHandler from '../backend/handlers/shop-checkout.mjs';
import accountHandler from '../backend/handlers/shop-account.mjs';
import authHandler from '../backend/handlers/auth.mjs';
import orgHandler from '../backend/handlers/org.mjs';
import { store } from '../backend/lib/saas.mjs';

async function run() {
  console.log('🧪 Running Test: B2B Checkout -> Account Signup -> App Entry...\n');

  const st = store();
  const testEmail = `gymboss_${Date.now()}@olympia-chain.test`;
  const testPassword = 'Password1234!';
  const testName = 'مدیر مجموعه زنجیره‌ای المپیا';
  const testPhone = '09121234567';

  // 1. Simulating POST /shop/api/checkout with gym_chain plan
  console.log('1. Purchasing organizational plan "gym_chain" on shop checkout...');
  const checkoutReq = new Request('http://localhost:8888/shop/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      planId: 'gym_chain',
      email: testEmail,
      name: testName,
      phone: testPhone
    })
  });

  const checkoutRes = await checkoutHandler(checkoutReq);
  assert.strictEqual(checkoutRes.status, 200, `Checkout must succeed (got ${checkoutRes.status})`);
  const checkoutData = await checkoutRes.json();
  assert.strictEqual(checkoutData.ok, true, 'Checkout response ok must be true');
  assert.ok(checkoutData.coupons && checkoutData.coupons.length > 0, 'Coupons list must be present');
  assert.strictEqual(checkoutData.demo, false, 'Coupon must NOT be marked demo when stored in DB');
  const couponCode = checkoutData.coupons[0];
  console.log(`   ✓ Coupon issued: ${couponCode}`);

  // Verify coupon actually exists in KV store
  const couponInDb = await st.get(`coupon:${couponCode}`, { type: 'json' });
  assert.ok(couponInDb, 'Coupon must exist in database');
  assert.strictEqual(couponInDb.planId, 'gym_chain', 'Coupon plan must be gym_chain');
  console.log('   ✓ Verified coupon saved in KV store successfully');

  // 2. Simulating POST /shop/api/account/signup with password and coupon
  console.log('\n2. Signing up via /shop/api/account/signup with issued coupon...');
  const signupReq = new Request('http://localhost:8888/shop/api/account/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: testName,
      email: testEmail,
      password: testPassword,
      coupon: couponCode
    })
  });

  const signupRes = await accountHandler(signupReq);
  assert.strictEqual(signupRes.status, 200, `Signup must succeed (got ${signupRes.status})`);
  const signupData = await signupRes.json();
  assert.strictEqual(signupData.ok, true, 'Signup response ok must be true');
  assert.ok(signupData.token, 'Signup must return session token');
  assert.strictEqual(signupData.redeemed, true, 'Coupon must be redeemed');
  assert.strictEqual(signupData.access.plan, 'gym_chain', 'Account plan must be gym_chain');
  const token = signupData.token;
  console.log(`   ✓ Account created with session token: ${token.slice(0, 10)}...`);
  console.log(`   ✓ Coupon redeemed! Plan activated: ${signupData.access.plan}`);

  // 3. Simulating GET /api/auth/me in app with session token
  console.log('\n3. Validating session in app via GET /api/auth/me...');
  const meReq = new Request('http://localhost:8888/api/auth/me', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });

  const meRes = await authHandler(meReq);
  assert.strictEqual(meRes.status, 200, `Auth me must succeed (got ${meRes.status})`);
  const meData = await meRes.json();
  assert.strictEqual(meData.ok, true);
  assert.strictEqual(meData.coach.email, testEmail);
  assert.strictEqual(meData.coach.plan, 'gym_chain');
  console.log('   ✓ Authenticated coach verified with gym_chain plan');

  // 4. Simulating GET /api/org/me in app
  console.log('\n4. Loading organization via GET /api/org/me...');
  const orgReq = new Request('http://localhost:8888/api/org/me', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });

  const orgRes = await orgHandler(orgReq);
  assert.strictEqual(orgRes.status, 200, `Org me must succeed (got ${orgRes.status})`);
  const orgData = await orgRes.json();
  assert.strictEqual(orgData.ok, true);
  assert.ok(orgData.org, 'Organization must exist');
  assert.strictEqual(orgData.isOwner, true, 'User must be recognized as Gym Owner');
  assert.strictEqual(orgData.role, 'gym_owner', 'User role in org must be gym_owner');
  assert.strictEqual(orgData.org.plan, 'gym_chain');
  console.log(`   ✓ Organization ready: "${orgData.org.name}"`);
  console.log(`   ✓ Branches provisioned: ${orgData.org.branches.length} branch(es)`);
  console.log(`   ✓ Executive role: ${orgData.role} (isOwner: ${orgData.isOwner})`);

  // 5. Testing subsequent login via /shop/api/account/login
  console.log('\n5. Testing login via /shop/api/account/login...');
  const loginReq = new Request('http://localhost:8888/shop/api/account/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword
    })
  });

  const loginRes = await accountHandler(loginReq);
  assert.strictEqual(loginRes.status, 200, `Login must succeed (got ${loginRes.status})`);
  const loginData = await loginRes.json();
  assert.strictEqual(loginData.ok, true);
  assert.strictEqual(loginData.access.plan, 'gym_chain');
  console.log('   ✓ Shop login succeeded cleanly with subscription data');

  console.log('\n🎉 ALL B2B CHECKOUT TO APP ENTRY TESTS PASSED!');
}

run().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
