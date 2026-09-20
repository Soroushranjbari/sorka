// Coach OS — Phase-2 billing core logic tests (pure, no network, no env needed).
//   node ./scripts/test-billing-core.mjs
import { PLANS, planOf, countSeats, quotaCheck, publicBilling, normCoupon, grantSub, adminEmails } from '../backend/lib/billing.mjs';
import { accessOf } from '../backend/lib/saas.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};
const days = (n) => n * 86400000;
const fakeClients = (n, archived = 0) => {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ id: i + 1, name: `C${i + 1}`, status: archived > 0 && i >= n - archived ? 'Archived' : 'Active' });
  return arr;
};

console.log('== plans ==');
ok(Object.keys(PLANS).length === 4, `4 plans defined (${Object.keys(PLANS).join(',')})`);
ok(PLANS.trial.maxClients === 5 && PLANS.professional.maxClients === 30 && PLANS.club.maxClients === 200, 'trial5/pro30/club200 seat caps');
ok(planOf({ plan: 'nope' }).id === 'trial', 'unknown plan falls back to trial');
ok(planOf(null).id === 'trial', 'null account falls back to trial');

console.log('== seats / quota ==');
ok(countSeats({ CLIENTS: fakeClients(3, 1) }) === 2, 'archived clients are not seats');
ok(countSeats({ CLIENTS: [] }) === 0, 'empty list = 0 seats');
ok(countSeats(null) === 0, 'null data = 0 seats');
const qOver = quotaCheck({ plan: 'basic' }, { CLIENTS: fakeClients(6) });
ok(qOver.over === true && qOver.used === 6 && qOver.max === 5, 'quota over detected');
const qOk = quotaCheck({ plan: 'club' }, { CLIENTS: fakeClients(50) });
ok(qOk.over === false && qOk.used === 50, 'within quota allowed');

console.log('== coupons ==');
ok(normCoupon('  coach-1  x! ') === 'COACH-1X', 'coupon sanitation uppercases + strips junk');
ok(normCoupon('') === '', 'empty coupon stays empty');

console.log('== grantSub / accessOf ==');
const now = Date.now();
{
  const acct = { plan: 'trial', trialEndsAt: now - days(1), sub: null };
  ok(accessOf(acct).status === 'expired', 'past trial => expired');
}
{
  const acct = { plan: 'trial', trialEndsAt: now + days(5), sub: null };
  ok(accessOf(acct).status === 'trial', 'within trial => trial');
}
{
  const acct = { plan: 'basic', sub_status: 'active', sub_ends_at: now + days(10) };
  ok(accessOf(acct).status === 'active', 'active sub wins over trial');
}
{
  const acct = { plan: 'professional', sub_status: 'active', sub_ends_at: now - days(1) };
  ok(accessOf(acct).status === 'expired', 'past sub end => expired');
}
{
  const acct = { plan: 'trial', trialEndsAt: now + days(2) };
  const g = grantSub(acct, { planId: 'professional', days: 30, provider: 'coupon', tracking: 'X' });
  ok(g.plan === 'professional', 'grantSub upgrades plan');
  ok(g.sub_ends_at >= now + days(29) && g.sub_ends_at <= now + days(31), 'grantSub sets end ~30d out');
  ok(accessOf(g).status === 'active', 'after grant => active');
}
{
  const acct = { plan: 'basic', sub_status: 'active', sub_ends_at: now + days(10) };
  const g = grantSub(acct, { planId: 'club', days: 30, provider: 'manual', tracking: '' });
  ok(g.plan === 'club', 'renewal upgrades plan');
  ok(g.sub_ends_at >= now + days(39), 'renewal extends FROM current end (stacking)',);
}
{
  const acct = { plan: 'basic', sub_status: 'active', sub_ends_at: now - days(3) };
  const g = grantSub(acct, { planId: 'basic', days: 30, provider: 'manual', tracking: '' });
  ok(g.sub_ends_at >= now + days(29), 'renewal after expiry starts from now');
}

console.log('== admin emails ==');
process.env.ADMIN_EMAILS = '  Admin@X.com , B@Y.com ';
const emails = adminEmails();
ok(emails.length === 2 && emails[0] === 'admin@x.com', 'ADMIN_EMAILS parsed + normalized');

console.log('== publicBilling shape ==');
const pb = publicBilling({ plan: 'professional', sub_status: 'active', sub_ends_at: now + days(5), trialEndsAt: now - days(1) });
ok(pb.status === 'active' && pb.plan === 'professional' && pb.subEndsAt === now + days(5), 'publicBilling exposes status/plan/ends');

console.log('== admin role flag ==');
import('../backend/lib/auth-shared.mjs').then(({ publicCoach }) => {
  const c = publicCoach({ id: 'x', email: 'a@b.c', name: 'A', plan: 'club', role: 'admin' });
  ok(c.role === 'admin', 'publicCoach exposes admin role');
  const c2 = publicCoach({ id: 'x', email: 'a@b.c', name: 'A', plan: 'trial' });
  ok(c2.role === 'coach', 'publicCoach defaults role to coach');

  console.log(`\nBILLING_CORE: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
});