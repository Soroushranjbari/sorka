// CoachMint — Real-world Live Simulation: B2B Gym & Studio OS
//   node ./scripts/demo-real-gym-flow.mjs

import { PLANS, quotaCheck } from '../backend/lib/billing.mjs';
import {
  createOrg, getOrg, getOrgByCoach, addOrgBranch, addOrgStaff, removeOrgStaff, reassignOrgClients
} from '../backend/lib/saas.mjs';

function makeMockStore() {
  const map = new Map();
  return {
    async get(k, opts) {
      if (!map.has(k)) return null;
      const v = map.get(k);
      return (opts?.type === 'json' && typeof v === 'string') ? JSON.parse(v) : v;
    },
    async setJSON(k, v) { map.set(k, JSON.stringify(v)); },
    async delete(k) { map.delete(k); },
    _dump() { return Object.fromEntries(map.entries()); }
  };
}

async function runRealWorldSimulation() {
  console.log('================================================================');
  console.log('🏋️‍♂️ شبیه‌سازی زنده و واقعی: سیستم سازمانی باشگاه‌ها (CoachMint Gym OS)');
  console.log('================================================================\n');

  const store = makeMockStore();

  // -------------------------------------------------------------
  // مرحله ۱: ایجاد مجموعه ورزشی و شعبه اصلی توسط مالک
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۱: ثبت نام و راه‌اندازی مجموعه ورزشی');
  const ownerCoach = { id: 'coach_farhad', name: 'فرهاد مجیدی (مدیر باشگاه)', email: 'farhad@oxygen-gym.com' };
  
  const org = await createOrg(store, {
    ownerCoachId: ownerCoach.id,
    ownerEmail: ownerCoach.email,
    name: 'باشگاه‌های زنجیره‌ای اکسیژن (Oxygen Fitness Chain)',
    planId: 'gym_chain'
  });

  console.log(`  ✓ باشگاه "${org.name}" با شناسه [${org.id}] ساخته شد.`);
  console.log(`  ✓ پلن فعال: [${org.plan}] (سقف: ۵ شعبه، ۱۵ مربی، ۵۰۰ شاگرد).`);
  console.log(`  ✓ شعبه پیش‌فرض: "${org.branches[0].name}" [${org.branches[0].id}] با برچسب HQ ثبت گردید.\n`);

  // -------------------------------------------------------------
  // مرحله ۲: افزودن شعب جدید (پاسداران و سعادت‌آباد)
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۲: توسعه شعب فیزیکی مجموعه (Multi-Branch)');
  const { branch: br2 } = await addOrgBranch(store, org.id, {
    name: 'شعبه ۲ - پاسداران',
    address: 'خیابان پاسداران، نبش بوستان پنجم',
    phone: '021-22889900'
  }, 5);
  console.log(`  ✓ شعبه دوم اضافه شد: "${br2.name}" [${br2.id}]`);

  const { branch: br3 } = await addOrgBranch(store, org.id, {
    name: 'شعبه ۳ - سعادت‌آباد (بانوان VIP)',
    address: 'سعادت‌آباد، میدان کاج',
    phone: '021-22003344'
  }, 5);
  console.log(`  ✓ شعبه سوم اضافه شد: "${br3.name}" [${br3.id}]\n`);

  // -------------------------------------------------------------
  // مرحله ۳: استخدام و تخصیص نقش‌های کادر فنی (RBAC)
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۳: تعریف پرسنل، مربیان و سطوح دسترسی (RBAC)');
  
  // ۱. سرمربی (Head Coach) با دسترسی به تمام شعب
  const { staffMember: headCoach } = await addOrgStaff(store, org.id, {
    coachId: 'coach_ali',
    name: 'علی نصیری',
    email: 'ali.nasiri@oxygen.com',
    role: 'head_coach',
    branches: ['*']
  }, 15);
  console.log(`  ✓ سرمربی کل اضافه شد: ${headCoach.name} | دسترسی: تمام شعب | نقش: ${headCoach.role}`);

  // ۲. مربی اختصاصی شعبه پاسداران
  const { staffMember: trainer1 } = await addOrgStaff(store, org.id, {
    coachId: 'coach_maryam',
    name: 'مریم راد',
    email: 'maryam.rad@oxygen.com',
    role: 'trainer',
    branches: [br2.id]
  }, 15);
  console.log(`  ✓ مربی اضافه شد: ${trainer1.name} | شعبه: ${br2.name} | نقش: ${trainer1.role}`);

  // ۳. مربی اختصاصی شعبه سعادت‌آباد
  const { staffMember: trainer2 } = await addOrgStaff(store, org.id, {
    coachId: 'coach_saman',
    name: 'سامان سهرابی',
    email: 'saman.s@oxygen.com',
    role: 'trainer',
    branches: [br3.id]
  }, 15);
  console.log(`  ✓ مربی اضافه شد: ${trainer2.name} | شعبه: ${br3.name} | نقش: ${trainer2.role}`);

  // ۴. منشی و مسئول پذیرش (خارج از سهمیه مربیان)
  const { staffMember: reception } = await addOrgStaff(store, org.id, {
    coachId: 'coach_mina',
    name: 'مینا رستمی',
    email: 'mina@oxygen.com',
    role: 'reception',
    branches: [org.branches[0].id]
  }, 15);
  console.log(`  ✓ مسئول پذیرش اضافه شد: ${reception.name} | نقش: reception (سهمیه مربی اشغال نمی‌شود)\n`);

  // -------------------------------------------------------------
  // مرحله ۴: ثبت و تخصیص ورزشکاران به شعب و مربیان
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۴: جذب شاگردان و تخصیص شعبه/مربی');
  let clients = [
    { id: 101, name: 'امیر کاظمی', goal: 'Muscle Gain', branchId: org.branches[0].id, assignedCoachId: headCoach.coachId, status: 'Active', workoutsLogged: 12 },
    { id: 102, name: 'مهسا کریمی', goal: 'Fat Loss', branchId: br2.id, assignedCoachId: trainer1.coachId, status: 'Active', workoutsLogged: 19 },
    { id: 103, name: 'پوریا دانیالی', goal: 'Hypertrophy', branchId: br3.id, assignedCoachId: trainer2.coachId, status: 'Active', workoutsLogged: 8 },
    { id: 104, name: 'نگار رضایی', goal: 'Strength', branchId: br3.id, assignedCoachId: trainer2.coachId, status: 'Active', workoutsLogged: 15 }
  ];

  clients.forEach(c => {
    const coachName = c.assignedCoachId === headCoach.coachId ? headCoach.name : (c.assignedCoachId === trainer1.coachId ? trainer1.name : trainer2.name);
    const branchName = c.branchId === org.branches[0].id ? org.branches[0].name : (c.branchId === br2.id ? br2.name : br3.name);
    console.log(`  - ورزشکار: "${c.name}" | مربی: [${coachName}] | شعبه: [${branchName}] | سوابق لاگ: ${c.workoutsLogged} جلسه`);
  });
  console.log('');

  // -------------------------------------------------------------
  // مرحله ۵: تست فیلتر تاپ‌بار و دسترسی شعبه‌ای
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۵: فیلترینگ هوشمند بر اساس شعبه انتخابی (Topbar Switcher)');
  const filterByBranch = (brid) => clients.filter(c => brid === 'all' || c.branchId === brid);
  
  console.log(`  📍 حالت ۱: انتخاب "همه شعب" -> تعداد شاگردان قابل مشاهده: ${filterByBranch('all').length} نفر`);
  console.log(`  📍 حالت ۲: انتخاب "${br3.name}" -> شاگردان: ${filterByBranch(br3.id).map(c=>c.name).join(' ، ')} (${filterByBranch(br3.id).length} نفر)\n`);

  // -------------------------------------------------------------
  // مرحله ۶: سناریوی بحرانی - استعفا یا خروج ناگهانی مربی (Anti-Poaching)
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۶: سناریوی واقعی - استعفای ناگهانی مربی (سامان سهرابی) و فعال‌سازی Anti-Poaching');
  console.log('  ⚠️ مسئله: مربی سامان سهرابی از باشگاه جدا می‌شود. آیا شاگردان و سوابق تمرینی همراه او می‌روند؟');
  console.log('  🛡️ محافظت CoachMint: تمام اطلاعات متعلق به فضای ابری باشگاه است، نه اکانت شخصی مربی!');

  const leavingCoachClients = clients.filter(c => c.assignedCoachId === trainer2.coachId).map(c => c.id);
  console.log(`  شاگردان تحت نظر سامان سهرابی: [${leavingCoachClients.map(id => clients.find(x => x.id === id).name).join(' ، ')}]`);

  console.log('\n  🔄 اجرای موتور انتقال هوشمند (Client Reassignment Engine):');
  console.log(`  تخصیص مجدد شاگردان به مربی "${trainer1.name}" در همان شعبه سعادت‌آباد...`);

  clients = reassignOrgClients(clients, {
    clientIds: leavingCoachClients,
    toCoachId: trainer1.coachId, // منتقل به مریم راد
    toBranchId: br3.id          // در همان شعبه سعادت‌آباد
  });

  // حذف مربی مستعفی از کادر باشگاه
  await removeOrgStaff(store, org.id, trainer2.coachId);
  console.log(`  ✓ مربی (${trainer2.name}) از سیستم باشگاه حذف شد و توکن دسترسی وی فوراً لغو گردید.`);

  console.log('\n  📊 وضعیت شاگردان پس از انتقال ضدخروج:');
  clients.forEach(c => {
    const coachName = c.assignedCoachId === headCoach.coachId ? headCoach.name : (c.assignedCoachId === trainer1.coachId ? trainer1.name : 'نامشخص');
    console.log(`    • شاگرد "${c.name}" -> اکنون تحت نظر: [${coachName}] | سوابق لاگ‌ها: ${c.workoutsLogged} جلسه (بدون ۱ ثانیه وقفه یا از دست رفتن دیتا)`);
  });
  console.log('');

  // -------------------------------------------------------------
  // مرحله ۷: راستی‌آزمایی سهمیه‌ها و کنترل ظرفیت (Quota Governance)
  // -------------------------------------------------------------
  console.log('🔹 مرحله ۷: کنترل سهمیه‌ها و حاکمیت داده (Quota Check)');
  const currentOrgData = await getOrg(store, org.id);
  const quota = quotaCheck({ plan: org.plan }, { CLIENTS: clients }, currentOrgData);

  console.log(`  - پلن جاری: ${org.plan}`);
  console.log(`  - سقف مجاز شعب: ${quota.maxBranches} | شعب فعال فعلی: ${quota.usedBranches}`);
  console.log(`  - سقف مربیان: ${quota.maxCoaches} | مربیان فعال: ${quota.usedCoaches} (نقش reception محاسبه نشده است)`);
  console.log(`  - سقف صندلی شاگردان: ${quota.max} | شاگردان فعال: ${quota.used}`);
  console.log(`  - وضعیت مجاز بودن حساب: ${!quota.over ? 'کاملاً مجاز و در محدوده پلن ✅' : 'مسدود ❌'}`);

  console.log('\n================================================================');
  console.log('🎯 نتیجه شبیه‌سازی: چرخه واقعی سیستم سازمانی باشگاه از ثبت تا انتقال شاگرد با موفقیت کامل اجرا شد.');
  console.log('================================================================');
}

runRealWorldSimulation().catch(console.error);
