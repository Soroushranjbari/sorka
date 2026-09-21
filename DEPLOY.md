# CoachMint — راهنمای استقرار (Vercel + SQLite)

معماری جدید: بک‌اند در `backend/` (lib + handlers) است و دیتا به‌صورت پیشفرض در
**یک فایل SQLite** (`data/sqlite.db`) ذخیره میشود — بدون Neon، بدون Supabase،
بدون Netlify.

```
api/[...path].mjs     ← تابع catch-all ورکسل (تنها glue مخصوص Vercel)
backend/
  handlers/           ← هندلرهای API (auth, billing, data, ai, health, shop-*)
  lib/                ← db.mjs (SQLite/Postgres) · saas · billing · guard · env
middleware.js         ← 404 کردن مسیرهای حساس قبل از فایل‌سیستم ورکسل
vercel.json           ← rewrite فروشگاه + هدرهای CSP/امنیتی
server.mjs            ← سرور مستقل برای لوکال/VPS (همان هندلرها)
scripts/              ← create-admin · migrate-kv-to-sqlite · deploy-check · تستها
data/sqlite.db        ← دیتابیس (gitignore شده — هرگز commit نشود)
```

## ۱) اجرای لوکال

```bash
npm install
npm start             # http://localhost:8888 — دیتا در data/sqlite.db
```

فایل `.env` خودکار load میشود. متغیرهای لازم: `ADMIN_EMAILS`، `ADMIN_API_KEY`،
`COACH_OS_URL` (لوکال: `http://localhost:8888`).

ساخت ادمین اصلی:

```bash
node ./scripts/create-admin.mjs <email> <password> [Name]
```

انتقال دیتای قدیمی `data/kv.json` به SQLite (یکبار):

```bash
npm run db:migrate
```

## ۲) استقرار روی Vercel (پروژه sorka1/sorka)

1. push به گیت — ورکسل خودکار import میکند (Framework: Other).
2. Environment Variables در داشبورد ورکسل:
   - `ADMIN_EMAILS` — ایمیل ادمین
   - `ADMIN_API_KEY` — کلید سرور-به-سرور فروشگاه (۲۴+ کاراکتر hex)
   - `COACH_OS_URL` — `https://<project>.vercel.app` (بعد از اولین دیپلوی)
   - `NODE_ENV=production`
   - اختیاری — `RESEND_API_KEY` + `MAIL_FROM`: ارسال ایمیل‌های برند CoachMint
     (خوش‌آمدگویی بعد از ثبت‌نام، تأیید خرید + کد فعال‌سازی، بازیابی رمز).
     بدون این کلید هیچ ایمیلی ارسال نمیشود؛ برای دامنه اختصاصی اول دامنه را در
     resend.com/domains تأیید کنید.
3. Deploy.

### نکته مهم درباره دیتا روی ورکسل

ورکسل دیسک دائمی ندارد. بک‌اند SQLite در `/tmp` مینویسد که با هر cold start
**خالی میشود**. برای دیتای دائمی روی ورکسل یکی از این دو را انتخاب کنید:

- **PostgreSQL** (توصیهشده): `DATABASE_URL` را ست کنید (مثلاً Neon از بخش
  Storage). جدول `kv_store` خودکار ساخته میشود — هیچ اسکیمایی لازم نیست.
- **Vercel Blobs / دیسک خارجی**: نیاز به تغییر کد دارد.

## ۳) چک پیش از استقرار

```bash
npm run check:deploy   # بدون env فقط هشدارهای موردانتظار را میدهد
npm test               # ۱۰۲ تست — همه باید pass شوند
```

## ۴) امنیت

- `data/sqlite.db` و `.env` در `.gitignore` هستند — هرگز commit نشوند.
- `middleware.js` مسیرهای `/data/*`, `/backend/*`, `/scripts/*`, `server.mjs`,
  `.env` و… را قبل از فایل‌سیستم 404 میکند.
- اگر کلید یا پسوردی لو رفت: پسورد ادمین را با
  `node ./scripts/create-admin.mjs <email> <newpass> --force` عوض کنید.
