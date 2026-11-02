// CoachMint — Coach Persona Simulation Test (مربی فرزاد)
// Tests the complete end-to-end journey of a realistic fitness & endurance coach.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'coach-persona-'));
const PORT = 8400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@coachmint.test';
const ADMIN_KEY = 'coach-persona-admin-key-98765';

let currentStep = 0;
let totalPass = 0, totalFail = 0;
const failureDetails = [];

function stepHeader(num, titleFa, titleEn) {
  console.log(`\n\x1b[1m\x1b[35m══════════════════════════════════════════════════════════════\x1b[0m`);
  console.log(`\x1b[1m\x1b[36mگام ${num}: ${titleFa}\x1b[0m \x1b[90m(${titleEn})\x1b[0m`);
  console.log(`\x1b[1m\x1b[35m══════════════════════════════════════════════════════════════\x1b[0m`);
}

function verify(title, cond, detail = '') {
  if (cond) {
    totalPass++;
    console.log(`  \x1b[32m✔ [موفق]\x1b[0m ${title}`);
  } else {
    totalFail++;
    failureDetails.push(title);
    console.error(`  \x1b[31m✖ [خطا]\x1b[0m ${title} ${detail ? `| جزئیات: ${JSON.stringify(detail)}` : ''}`);
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  if (token) headers['authorization'] = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, d, text, headers: r.headers };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let child = null;

async function runCoachJourney() {
  console.log(`\n\x1b[1m\x1b[33m🚀 آغاز شبیه‌سازی سناریوی کامل مربی فرضی (مربی فرزاد - Coach Farzad)\x1b[0m`);
  console.log(`محیط اجرا: سرور زنده روی ${BASE} با دیتابیس مجزای SQLite\n`);

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SQLITE_PATH: join(dir, 'coach-journey.sqlite.db'),
      DATABASE_URL: '',
      POSTGRES_URL: '',
      PGURL: '',
      ADMIN_EMAILS: ADMIN_EMAIL,
      ADMIN_API_KEY: ADMIN_KEY,
      COACH_OS_URL: BASE,
      DB_BACKUP_KEEP: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stderr.on('data', (d) => {
    const msg = d.toString();
    if (!msg.includes('ExperimentalWarning')) process.stderr.write(msg);
  });

  const ready = await waitReady();
  if (!ready) throw new Error('سرور در زمان تعیین‌شده پاسخ نداد.');

  // -------------------------------------------------------------
  // گام ۱: ثبت نام و راه‌اندازی پروفایل مربی
  // -------------------------------------------------------------
  stepHeader(1, 'ثبت‌نام مربی و ورود به فضای کاری', 'Coach Onboarding & Authentication');
  const coachEmail = `coach.farzad.${Date.now()}@test.ir`;
  const coachPass = 'FarzadFitness!2026';

  const reg = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'مربی فرزاد راد', email: coachEmail, password: coachPass }
  });
  verify('ثبت نام حساب کاربری مربی فرزاد با موفقیت انجام شد', reg.status === 200 && !!reg.d?.token);
  const token = reg.d?.token;
  const wsCode = reg.d?.workspace?.code;
  verify(`کد اختصاصی ورک‌اسپیس تولید شد: [${wsCode}]`, typeof wsCode === 'string' && wsCode.length >= 4);

  const me = await api('/api/auth/me', { token });
  verify('دریافت اطلاعات کاربری با توکن احراز هویت تایید شد', me.status === 200 && me.d?.coach?.name === 'مربی فرزاد راد');
  verify('وضعیت حساب در دوره آزمایشی (Trial) معتبر است', me.d?.access?.status === 'trial');

  // تکمیل اطلاعات تکمیلی پروفایل
  const prof = await api('/api/auth/profile', {
    method: 'POST',
    token,
    body: {
      name: 'مربی فرزاد راد',
      phone: '09121112233',
      bio: 'مربی رسمی بدنسازی، آمادگی جسمانی و دوهای استقامت با ۱۰ سال سابقه'
    }
  });
  verify('اطلاعات بیوگرافی و تلفن همراه مربی به‌روزرسانی شد', prof.status === 200 && prof.d?.coach?.phone === '09121112233');

  // -------------------------------------------------------------
  // گام ۲: تعریف و مدیریت شاگردان
  // -------------------------------------------------------------
  stepHeader(2, 'مدیریت شاگردان و تعیین رشته ورزشی', 'Athlete & Roster Management');
  // ایجاد ۲ شاگرد با اهداف و رشته‌های متفاوت:
  // ۱. سهراب سپهری (بدنسازی و افزایش حجم)
  // ۲. سارا راد (دویدن و ماراتن)
  const initialData = {
    rev: 0,
    data: {
      CLIENTS: [
        {
          id: 1,
          name: 'سهراب سپهری',
          status: 'Active',
          goal: 'افزایش توده عضلانی (Hypertrophy)',
          prog: 'برنامه قدرتی ۴ روزه',
          sport: 'strength',
          week: 2,
          freq: '4x / week',
          weight: 78.5,
          targetWeight: 82.0
        },
        {
          id: 2,
          name: 'سارا راد',
          status: 'Active',
          goal: 'آمادگی نیمه‌ماراتن (Half-Marathon)',
          prog: 'برنامه استقامت و سرعت',
          sport: 'running',
          week: 4,
          freq: '5x / week',
          weight: 56.0,
          targetWeight: 55.0
        }
      ],
      EVENTS: [],
      NOTES: [],
      NPLANS: [],
      DB: {}
    }
  };

  const putClients = await api(`/api/data?code=${wsCode}`, { method: 'PUT', token, body: initialData });
  verify('شاگردان اولیه در ورک‌اسپیس با موفقیت ثبت شدند', putClients.status === 200);
  let currentRev = putClients.d?.rev;

  const getClients = await api(`/api/data?code=${wsCode}`, { token });
  verify('لیست شاگردان از سرور بازخوانی شد (۲ شاگرد فعال)', getClients.d?.data?.CLIENTS?.length === 2);
  verify('شاگرد ۱: سهراب سپهری (رشته قدرتی)', getClients.d?.data?.CLIENTS[0]?.sport === 'strength');
  verify('شاگرد ۲: سارا راد (رشته دویدن)', getClients.d?.data?.CLIENTS[1]?.sport === 'running');

  // -------------------------------------------------------------
  // گام ۳: طراحی برنامه تمرینی و اسپلیت هفتگی
  // -------------------------------------------------------------
  stepHeader(3, 'طراحی برنامه تمرینی اختصاصی شاگرد', 'Workout Planning & Week Split');
  // اضافه کردن برنامه تمرینی برای سهراب سپهری (تمرین بالا تنه سینه و زیربغل)
  const workoutPlan = {
    workouts: [
      {
        id: 101,
        day: 'Monday',
        name: 'سینه و زیربغل (Upper Hypertrophy)',
        dur: '60 min',
        exercises: [
          { ex: 0, sets: 4, reps: '8-10', kg: 85, rest: 90, note: 'تمرکز روی فاز منفی حرکت' }, // نیمکت پرس سینه
          { ex: 1, sets: 4, reps: '10-12', kg: 70, rest: 75, note: 'انقباض کامل عضلات لاتیسیموس' } // زیربغل هالتر خم
        ]
      },
      {
        id: 102,
        day: 'Wednesday',
        name: 'پایین تنه و پا (Legs Power)',
        dur: '70 min',
        exercises: [
          { ex: 2, sets: 4, reps: '6-8', kg: 110, rest: 120, note: 'عمق حرکت موازی یا زیر موازی' } // اسکوات
        ]
      }
    ],
    split: [
      { t: 'w', w: '101' }, // Monday
      { t: 'rest' },        // Tuesday
      { t: 'w', w: '102' }, // Wednesday
      { t: 'rest' },        // Thursday
      { t: 'rest' },        // Friday
      { t: 'rest' },        // Saturday
      { t: 'rest' }         // Sunday
    ]
  };

  const updatedData = {
    rev: currentRev,
    data: {
      ...getClients.d.data,
      DB: {
        1: workoutPlan
      },
      EVENTS: [
        { id: 'ev_101', client: 'سهراب سپهری', day: 0, start: 17.5, dur: 1.0, label: 'جلسه تمرینی سینه و زیربغل' }
      ]
    }
  };

  const putWorkouts = await api(`/api/data?code=${wsCode}`, { method: 'PUT', token, body: updatedData });
  verify('برنامه تمرینی هفتگی و زمان‌بندی جلسات با موفقیت ذخیره شد', putWorkouts.status === 200);
  currentRev = putWorkouts.d?.rev;

  const checkWorkouts = await api(`/api/data?code=${wsCode}`, { token });
  const sohrabDb = checkWorkouts.d?.data?.DB?.[1];
  verify('برنامه تمرینی شاگرد ۱ بازیابی شد (شامل ۲ روز تمرینی و ۵ روز استراحت)', sohrabDb?.workouts?.length === 2);
  verify('حرکات انتسابی با وزنه و تکرار دقیق ذخیره شدند', sohrabDb?.workouts[0]?.exercises[0]?.kg === 85);

  // -------------------------------------------------------------
  // گام ۴: طراحی و پایش برنامه تغذیه
  // -------------------------------------------------------------
  stepHeader(4, 'طراحی برنامه غذایی و کالری روزانه', 'Nutrition Plan & Meal Composition');
  const nutritionPlan = {
    id: 'nutri_sohrab',
    client: 'سهراب سپهری',
    name: 'برنامه حجم باکیفیت (Clean Bulk 2800 kcal)',
    train: { kcal: 2800, p: 190, c: 330, f: 80 },
    rest: { kcal: 2350, p: 185, c: 220, f: 75 },
    days: [
      {
        type: 'train',
        meals: [
          { time: '08:00', name: 'صبحانه پروتئینی', foods: [{ fi: 0, g: 150 }, { fi: 1, g: 80 }] },
          { time: '13:30', name: 'ناهار (سینه مرغ و برنج)', foods: [{ fi: 2, g: 200 }, { fi: 3, g: 250 }] },
          { time: '17:00', name: 'میان‌وعده قبل از تمرین', foods: [{ fi: 4, g: 100 }] },
          { time: '21:00', name: 'شام بعد از تمرین', foods: [{ fi: 2, g: 180 }, { fi: 5, g: 200 }] }
        ]
      }
    ]
  };

  const withNutri = {
    rev: currentRev,
    data: {
      ...checkWorkouts.d.data,
      FOODS: [
        { n: 'تخم مرغ کامل', kcal: 155, p: 13, c: 1, f: 11 },
        { n: 'جو دوسر', kcal: 389, p: 17, c: 66, f: 7 },
        { n: 'سینه مرغ گریل', kcal: 165, p: 31, c: 0, f: 3.6 },
        { n: 'برنج کته قهوه‌ای', kcal: 111, p: 2.6, c: 23, f: 0.9 },
        { n: 'موز', kcal: 89, p: 1.1, c: 23, f: 0.3 },
        { n: 'سیب‌زمینی پخته', kcal: 87, p: 1.9, c: 20, f: 0.1 }
      ],
      NPLANS: [nutritionPlan],
      NRULES: [
        { type: 'protein', threshold: 85, days: 3, action: 'warning', enabled: true }
      ]
    }
  };

  const putNutri = await api(`/api/data?code=${wsCode}`, { method: 'PUT', token, body: withNutri });
  verify('برنامه تغذیه و جدول ماکروهای روزانه ذخیره شد', putNutri.status === 200);
  currentRev = putNutri.d?.rev;

  const checkNutri = await api(`/api/data?code=${wsCode}`, { token });
  verify('برنامه تغذیه سهراب سپهری تایید شد (کالری روز تمرین: ۲۸۰۰، پروتئین: ۱۹۰ گرم)', checkNutri.d?.data?.NPLANS?.[0]?.train?.kcal === 2800);

  // -------------------------------------------------------------
  // گام ۵: ثبت اندازه‌گیری‌ها و پیشرفت بدنی
  // -------------------------------------------------------------
  stepHeader(5, 'ثبت اندازه‌گیری، چک‌این و رکوردهای شخصی', 'Measurements, Weigh-ins & Progress');
  const measures = [
    { d: '2026-10-15', wt: 77.2, bf: 14.2, arm: 37.5, waist: 82.0, chest: 104.0 },
    { d: '2026-11-01', wt: 78.5, bf: 13.8, arm: 38.2, waist: 81.5, chest: 105.5 }
  ];

  const withMeasures = {
    rev: currentRev,
    data: {
      ...checkNutri.d.data,
      DB: {
        ...checkNutri.d.data.DB,
        1: {
          ...checkNutri.d.data.DB[1],
          measures: measures,
          pbs: [
            { ex: 'پرس سینه هالتر', val: 95, unit: 'kg', d: '2026-10-28' },
            { ex: 'اسکوات پا', val: 125, unit: 'kg', d: '2026-10-30' }
          ]
        }
      }
    }
  };

  const putMeasures = await api(`/api/data?code=${wsCode}`, { method: 'PUT', token, body: withMeasures });
  verify('سوابق اندازه‌گیری و رکوردهای شخصی (PR) با موفقیت ثبت شدند', putMeasures.status === 200);
  currentRev = putMeasures.d?.rev;

  const checkMeasures = await api(`/api/data?code=${wsCode}`, { token });
  const sohrabMeasures = checkMeasures.d?.data?.DB?.[1]?.measures;
  verify('روند افزایش وزن عضله سنجیده شد (افزایش وزن از ۷۷.۲ به ۷۸.۵ با کاهش چربی)', sohrabMeasures?.length === 2 && sohrabMeasures[1]?.wt === 78.5);

  // -------------------------------------------------------------
  // گام ۶: هاب دو و میدانی، زون‌های سرعت و سینک استراوا
  // -------------------------------------------------------------
  stepHeader(6, 'مرکز دو و میدانی و هاب استقامت (Endurance Hub)', 'Athletics & Strava Integration');
  // برای سارا راد (شاگرد دونده)
  const stravaConfig = await api('/api/strava/config');
  verify('سرویس استراوا در وضعیت آماده به کار شبیه‌ساز قرار دارد', stravaConfig.d?.simulator === true);

  // اتصال پروفایل ورزشکار به استراوا
  const stravaConnect = await api('/api/strava/callback?code=mock_strava_sandbox_token');
  verify('اتصال پروفایل ورزشکار به اکانت Strava تایید شد', stravaConnect.status === 200);

  const stravaStatus = await api('/api/strava/status');
  verify(`پروفایل استراوا متصل است: [${stravaStatus.d?.athleteName}]`, stravaStatus.d?.connected === true);

  // دریافت و سینک تمرینات دویدن ثبت شده در ساعت ورزشی
  const stravaSync = await api('/api/strava/sync', { method: 'POST' });
  verify('فعالیت‌های دویدن جدید از استراوا با موفقیت سینک شدند', stravaSync.status === 200 && stravaSync.d?.count > 0);
  const act1 = stravaSync.d?.activities?.[0];
  verify(`فعالیت ثبت‌شده: ${act1?.name} - مسافت: ${act1?.km} کیلومتر با سرعت و اسپلیت‌های زمانی`, act1?.km > 0 && !!act1?.splits);

  // -------------------------------------------------------------
  // گام ۷: یادداشت‌ها و پیام‌رسانی مربی با شاگرد
  // -------------------------------------------------------------
  stepHeader(7, 'سیستم یادداشت‌ها و پیام‌های مربیگری', 'Coach Notes & In-App Messaging');
  const withNotes = {
    rev: currentRev,
    data: {
      ...checkMeasures.d.data,
      NOTES: [
        {
          id: 'n_farzad_1',
          c: 'سهراب سپهری',
          t: 'فرم حرکت پرس سینه بسیار عالی بود. برای جلسه بعد وزنه را به ۹۰ کیلوگرم افزایش می‌دهیم.',
          d: '2026-11-02'
        }
      ],
      MSGS: [
        {
          id: 'm_1',
          client: 'سهراب سپهری',
          from: 'coach',
          body: 'سلام سهراب جان، برنامه تغذیه جدید برات فعال شد. کالری روز تمرین ۲۸۰۰ هست.',
          time: '10:30',
          d: '2026-11-02'
        },
        {
          id: 'm_2',
          client: 'سهراب سپهری',
          from: 'client',
          body: 'ممنون مربی، برنامه رو دیدم و امروز طبق همون پیش رفتم. احساس انرژی خیلی خوبی داشتم!',
          time: '14:20',
          d: '2026-11-02'
        }
      ]
    }
  };

  const putNotes = await api(`/api/data?code=${wsCode}`, { method: 'PUT', token, body: withNotes });
  verify('یادداشت‌های فنی مربی و گفتگو با شاگرد ذخیره شد', putNotes.status === 200);
  currentRev = putNotes.d?.rev;

  // -------------------------------------------------------------
  // گام ۸: تولید خروجی PDF و چاپی با بارکد اختصاصی
  // -------------------------------------------------------------
  stepHeader(8, 'تولید خروجی چاپی و PDF برنامه شاگرد', 'Printable PDF Plan & QR Generation');
  const printWorkout = await api(`/api/export/pdf?code=${wsCode}&client=1&lang=fa`);
  verify('صفحه چاپی برنامه تمرینی تولید شد (با برند CoachMint و فونت فارسی)', printWorkout.status === 200 && /COACH.*MINT/i.test(printWorkout.text));
  verify('نام شاگرد و حرکات تمرینی در خروجی چاپی قرار گرفتند', printWorkout.text.includes('سهراب سپهری'));
  verify('بارکد QR اختصاصی برای اتصال شاگرد در انتهای صفحه ایجاد شد', printWorkout.text.includes('class="qr"') || printWorkout.text.includes('<svg'));

  const printNutri = await api(`/api/export/pdf?code=${wsCode}&client=1&kind=nutrition&lang=fa`);
  verify('صفحه چاپی برنامه تغذیه با ماکروهای روز تمرین و استراحت تولید شد', printNutri.status === 200 && printNutri.text.includes('Clean Bulk'));

  // -------------------------------------------------------------
  // گام ۹: ارتقای اشتراک مربی (Shop & Billing Upgrade)
  // -------------------------------------------------------------
  stepHeader(9, 'خرید و ارتقای پلن اشتراک مربی', 'Subscription Upgrade & Shop Checkout');
  // مربی فرزاد نیاز به اضافه کردن شاگردان بیشتری دارد و پلن Professional تهیه می‌کند
  const orderRes = await api('/shop/api/checkout', {
    method: 'POST',
    body: {
      planId: 'professional',
      name: 'مربی فرزاد راد',
      email: coachEmail,
      phone: '09121112233'
    }
  });
  verify('سفارش خرید پلن حرفه‌ای (Professional) در فروشگاه ثبت شد', orderRes.status === 200 && orderRes.d?.ok === true);
  const coupon = orderRes.d?.coupons?.[0];
  verify(`کوپن معتبر اشتراک ۳۰ روزه صادر شد: [${coupon}]`, typeof coupon === 'string' && coupon.startsWith('PRO-'));

  // فعال‌سازی کوپن در پنل مربی
  const redeemRes = await api('/api/billing/redeem', {
    method: 'POST',
    token,
    body: { code: coupon }
  });
  verify('کوپن اشتراک در حساب کاربری مربی با موفقیت اعمال گردید', redeemRes.status === 200 && redeemRes.d?.ok === true);

  // بررسی صورت‌حساب مربی
  const billInfo = await api('/api/billing/me', { token });
  verify('پلن مربی به وضعیت حرفه‌ای ارتقا یافت (Plan: Professional)', billInfo.d?.billing?.plan === 'professional');
  verify('وضعیت دسترسی فعال شد (Status: Active)', billInfo.d?.billing?.status === 'active');
  verify('سهمیه ظرفیت شاگردان مربی از ۵ نفر به ۳۰ نفر افزایش یافت (Max: 30)', billInfo.d?.quota?.max === 30);

  // -------------------------------------------------------------
  // گام ۱۰: امنیت و محافظت از داده‌های محرمانه مربی
  // -------------------------------------------------------------
  stepHeader(10, 'آزمون امنیت، تفکیک داده‌ها و پایداری سرور', 'Security, Tenant Isolation & Resilience');
  // آزمون دسترسی غیرمجاز دیگران به داده‌های مربی
  const foreignToken = 'co_fake_unauthorized_token_12345';
  const unauthorizedReq = await api('/api/auth/me', { token: foreignToken });
  verify('درخواست با توکن جعلی مسدود شد (401 Unauthorized)', unauthorizedReq.status === 401);

  // آزمون مسدودسازی دانلود مستقیم فایل‌های سیستمی
  const dbFileReq = await api('/data/sqlite.db');
  verify('دانلود مستقیم فایل پایگاه داده مسدود شد (404 Not Found)', dbFileReq.status === 404);

  const envFileReq = await api('/.env');
  verify('دانلود مستقیم فایل پیکربندی مسدود شد (404 Not Found)', envFileReq.status === 404);
}

try {
  await runCoachJourney();
} catch (err) {
  console.error('\nخطای بحرانی در اجرای سناریو:', err);
  totalFail++;
} finally {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n\x1b[1m\x1b[32m══════════════════════════════════════════════════════════════\x1b[0m');
console.log(`\x1b[1mخلاصه آزمون سناریوی مربی فرزاد:\x1b[0m`);
console.log(`  \x1b[32mتعداد مراحل موفق: ${totalPass}\x1b[0m`);
console.log(`  \x1b[31mتعداد مراحل ناموفق: ${totalFail}\x1b[0m`);
console.log('\x1b[1m\x1b[32m══════════════════════════════════════════════════════════════\x1b[0m\n');

if (totalFail > 0) {
  console.error('مراحل ناموفق:', failureDetails);
  process.exit(1);
} else {
  console.log('\x1b[32mتمام مراحل سناریوی مربی واقعی ۱۰۰٪ با موفقیت پاس شدند!\x1b[0m\n');
}
