import fs from 'node:fs';
import assert from 'node:assert/strict';

console.log('Testing Shop Pricing and Checkout Portal Separation...');

// 1. Verify shop/index.html
const indexHtml = fs.readFileSync('shop/index.html', 'utf8');

// 1.1 Nav & Menu Portals
assert.ok(indexHtml.includes('nav-portals'), 'Nav should include nav-portals container');
assert.ok(indexHtml.includes('/index.html#coach-login&portal=coach'), 'Nav should link to solo coach login');
assert.ok(indexHtml.includes('/index.html#org-login&portal=org&mode=executive&view=org'), 'Nav should link to gym executive login');
assert.ok(indexHtml.includes('Sign In: Solo Coach Desk'), 'Menu should have solo coach login');
assert.ok(indexHtml.includes('Sign In: Club &amp; Gym'), 'Menu should have club gym login');

// 1.2 Pricing switcher & portal banners
assert.ok(indexHtml.includes('id="tier-desc-solo"'), 'Should have solo tier portal description banner');
assert.ok(indexHtml.includes('id="tier-desc-gym"'), 'Should have gym tier portal description banner');
assert.ok(indexHtml.includes('class="tier-portal-box"'), 'Should have tier portal boxes');
assert.ok(indexHtml.includes('href="/index.html#coach-login&portal=coach"'), 'Solo banner should link to coach login');
assert.ok(indexHtml.includes('href="/index.html#org-login&portal=org&mode=executive&view=org"'), 'Gym banner should link to org login');

// 1.3 Solo Grid plans & checkout links
assert.ok(indexHtml.includes('id="pgrid-solo"'), 'Must have pgrid-solo');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=trial&portal=coach"'), 'Trial checkout must include portal=coach');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=basic&portal=coach"'), 'Basic checkout must include portal=coach');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=professional&portal=coach"'), 'Professional checkout must include portal=coach');
// Solo grid shouldn't include gym plans
assert.ok(!indexHtml.includes('data-checkout="club"'), 'Solo grid must not have club plan mixed in');

// 1.4 Gym Grid plans & checkout links
assert.ok(indexHtml.includes('id="pgrid-gym"'), 'Must have pgrid-gym');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=gym_trial&portal=org"'), 'Club Free Trial checkout must include portal=org');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=gym_studio&portal=org"'), 'Gym Studio checkout must include portal=org');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=gym_chain&portal=org"'), 'Gym Chain checkout must include portal=org');
assert.ok(indexHtml.includes('href="/shop/checkout.html?plan=gym_enterprise&portal=org"'), 'Gym Enterprise checkout must include portal=org');
assert.ok(indexHtml.includes('Club Free Trial'), 'Must have Club Free Trial card');

// 1.5 Card sublinks for direct sign-in
assert.ok(indexHtml.includes('class="pcard-sublink"'), 'Cards must have sign-in sublinks');

// 1.6 Script uses $$ for tier-tabs
assert.ok(indexHtml.includes("var tierTabs = $$('.tier-tab');"), 'Tier tabs script must use $$ to bind all tabs');

// 1.7 Translations for FA & TR
assert.ok(indexHtml.includes("'Gyms & Organizations':'باشگاه‌ها و سازمان‌ها'"), 'FA must include Gyms & Organizations');
assert.ok(indexHtml.includes("'Gyms & Organizations': 'Kulüpler ve Organizasyonlar'"), 'TR must include Gyms & Organizations');
assert.ok(indexHtml.includes("'Executive Console Sign In':'ورود مدیریت باشگاه'"), 'FA must include Executive Console Sign In');
assert.ok(indexHtml.includes("'Sign In to Solo Desk':'ورود مربی تکی'"), 'FA must include Sign In to Solo Desk');

console.log('✓ shop/index.html checks passed');

// 2. Verify shop/checkout.html
const chHtml = fs.readFileSync('shop/checkout.html', 'utf8');

// 2.1 Tab switcher & gym field
assert.ok(chHtml.includes('id="portalTabs"'), 'Checkout must include portalTabs');
assert.ok(chHtml.includes('id="subtab-coach"'), 'Checkout must include subtab-coach');
assert.ok(chHtml.includes('id="subtab-org"'), 'Checkout must include subtab-org');
assert.ok(chHtml.includes('id="gymNameField"'), 'Checkout must include gymNameField');

// 2.2 JS Logic
assert.ok(chHtml.includes('const SOLO_PLANS='), 'Checkout must define SOLO_PLANS');
assert.ok(chHtml.includes('const GYM_PLANS='), 'Checkout must define GYM_PLANS');
assert.ok(chHtml.includes("currentPortal === 'org'"), 'Checkout renderPlans must branch on currentPortal');
assert.ok(chHtml.includes("const t=k=>"), 'Checkout must have t function defined');
assert.ok(chHtml.includes("const setT="), 'Checkout must have setT function defined');
assert.ok(chHtml.includes("const payLabel="), 'Checkout must have payLabel function defined');

// 2.3 Portal routing on checkout completion
assert.ok(chHtml.includes("gym_trial:{"), 'Checkout PLANS must include gym_trial');
assert.ok(chHtml.includes("const isOrgPlan = ['club', 'gym_trial', 'gym_studio', 'gym_chain', 'gym_enterprise'].includes(plan);"), 'Must identify org plans');
assert.ok(chHtml.includes("const portalHash = isOrgPlan ? '#org-login' : '#coach-login';"), 'Must route to org-login vs coach-login');
assert.ok(chHtml.includes("&portal=coach"), 'Trial redirect must include portal=coach');

// 2.4 Checkout translations
assert.ok(chHtml.includes("'Start free club trial':'شروع رایگان باشگاه'"), 'Checkout FA must translate Start free club trial');
assert.ok(chHtml.includes("'Solo Coach':'مربی تک‌نفره و مستقل'"), 'Checkout FA must translate Solo Coach');
assert.ok(chHtml.includes("'Gym & Club':'باشگاه و سازمان'"), 'Checkout FA must translate Gym & Club');
assert.ok(chHtml.includes("'Gym / Club Name':'نام باشگاه / مجموعه ورزشی'"), 'Checkout FA must translate Gym / Club Name');
assert.ok(chHtml.includes("'Solo Coach':'Bireysel Antrenör'"), 'Checkout TR must translate Solo Coach');

console.log('✓ shop/checkout.html checks passed');
console.log('All Shop Pricing and Checkout separation checks PASSED successfully!');
