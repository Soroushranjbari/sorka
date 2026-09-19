# Coach OS — Deployment Checklist (چک‌لیست استقرار)

این چک‌لیست را موقع انتقال پروژه از سیستم لوکال به سرور واقعی قدم‌به‌قدم اجرا کنید.
هر آیتم یک «چرا» دارد تا بدانید اگر رعایت نشود چه ریسکی ایجاد می‌شود.

---

## ۱. فایل‌هایی که آپلود می‌شوند / نمی‌شوند

**آپلود کنید:**
```
index.html          ← اپلیکیشن
server.mjs          ← سرور مستقل
netlify/            ← بک‌اند (lib + functions)
shop/               ← سایت فروش (index.html, checkout.html, api/, assets/)
scripts/            ← create-admin و تست‌ها
db/                 ← schema-fresh.sql (اسکیمای خالی — برای production) + schema.sql (اسکیما + داده‌ی دمو — فقط لوکال)
package.json        ← برای npm install
netlify.toml        ← برای دیپلوی Netlify (اختیاری)
sw.js, manifest.json, icons/
```

**آپلود نکنید:**

| فایل | چرا |
|---|---|
| `data/kv.json` | ⚠️ داده‌های تست لوکال: ادمین با رمز معلوم، مربی‌های آزمایشی، کوپن‌های تست. اگر برود، امنیت سایت از لحظه صفر لوکال از بین می‌رود |
| `node_modules/` | روی سرور با `npm install` ساخته می‌شود (سازگاری پلتفرم) |
| `.git/` | تاریخچه توسعه — نیازی نیست و حجم زیاد دارد |
| `shop/*Gyms 2*` و `shop/*Coaches.html` | نسخه‌های تکراری/قدیمی لندینگ — فقط `shop/index.html` و `shop/checkout.html` لازم است |
| `.env` | کلیدها را روی سرور مستقیم ست کنید، فایل لوکال را نبرید |

---

## ۲. نصب روی سرور

```bash
# روی سرور (مثلاً /opt/coach-os):
npm install
node --check server.mjs   # سلامت فایل‌ها
```

---

## ۳. متغیرهای محیطی (مهم‌ترین بخش)

| متغیر | الزامی؟ | توضیح |
|---|---|---|
| `KV_FILE` | یکی از دو گزینه | مسیر فایل KV (تک‌سرور). مثال: `/opt/coach-os/data/kv.json` — فایل خالی باشد خودش می‌سازد |
| `DATABASE_URL` | یا این | رشته اتصال PostgreSQL خودتان (توصیه‌شده برای production و چند-سروری). اسکیمای **خالی** `db/schema-fresh.sql` را یک‌بار اجرا کنید: `psql "$DATABASE_URL" -f db/schema-fresh.sql` — بعد ادمین را با `npm run admin:create` بسازید. ⚠️ `db/schema.sql` حاوی dump دیتای پروداکشن (هش رمز + توکن سشن فعال) است و هرگز نباید روی production اجرا شود |
| `ADMIN_API_KEY` | ✅ الزامی | کلید سرور-به-سرور سایت فروش برای صدور کوپن. بدون آن endpoint فروش غیرفعال است |
| `COACH_OS_URL` | ✅ الزامی | آدرس عمومی اپ (مثلاً `https://app.coachos.ir`) — checkout سایت با آن کوپن صادر می‌کند |
| `ADMIN_EMAILS` | ✅ الزامی | ایمیل ادمین اصلی (با کاما جدا کنید اگر چند نفرند) |
| `RESEND_API_KEY` | اختیاری | برای ایمیل واقعی لینک بازیابی رمز |
| `RESET_DELIVERY` | ❌ روی production **نذارید** | اگر `return` باشد لینک ریست در پاسخ API لو می‌رود (فقط برای لوکال/دمو) |
| `PORT` / `HOST` | اختیاری | پیش‌فرض 8888 / 0.0.0.0 |

**تولید کلید امن:**
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## ۴. ساخت ادمین اصلی — روی سرور، نه کپی از لوکال

```bash
KV_FILE=/opt/coach-os/data/kv.json \
node ./scripts/create-admin.mjs admin@yourdomain.com 'رمز-قوی-جدید' 'Main Admin'
```

- **چرا از نو؟** چون `data/kv.json` لوکال را اصلاً نمی‌برید؛ و رمز تستی لوکال (در `data/prod-admin-pass.txt`) هرگز نباید روی production باشد.
- این اسکریپت عمداً از فرم ثبت‌نام عمومی رد می‌شود تا کسی نتواند ایمیل ادمین را قبل از شما بگیرد.
- ادمین خودکار پلن `club` با اشتراک باز می‌گیرد و تب **Admin** در تنظیمات برایش ظاهر می‌شود.

---

## ۵. HTTPS (الزامی)

- با nginx یا Caddy جلوی `server.mjs` بگذارید و گواهی Let's Encrypt بگیرید.
- چرا: رمز ورود و توکن نشست بدون HTTPS قابل شنود است؛ HSTS هم در هدرها ست شده و فقط معنایش روی HTTPS است.
- نمونه کانفیگ nginx در `SELFHOST.md` هست.

---

## ۶. تست بعد از استقرار (۵ دقیقه)

```bash
# ۱. سلامت
curl https://yourdomain.com/api/health
# → باید "backend":"postgres" یا "file" بدهد

# ۲. ثبت‌نام یک مربی آزمایشی از UI
# ۳. خرید آزمایشی: /shop → Buy Now → کد بگیرید → در اپ ریدیم کنید
# ۴. ورود ادمین → تب Admin → مربی آزمایشی را ببینید؟
# ۵. لاگ سرور را چک کنید: خطای [api] نباید باشد
```

---

## ۷. نگهداری دوره‌ای

| کار | دوره |
|---|---|
| بکاپ `data/kv.json` (اگر file backend) یا `pg_dump -Fc coach_os` (اگر PostgreSQL) | روزانه — یک cron ساده کافی است |
| چک `/api/health` | مانیتور uptime (مثلاً UptimeRobot مجانی) |
| reconcile پلن مربی‌ها با سفارش‌های فروشگاه | هفتگی — از تب Admin |
| rotate کردن `ADMIN_API_KEY` | هر ۶ ماه یا بعد از هر خروج اعضای تیم |

---

## ۸. اگر فایل KV یا schema.sql لو رفته باشد

هر فایلی که داخلش `acct:` / `sess:` / `coupon:` باشد، یک نسخه‌ی کامل از اطلاعات ورود است:

| چه چیزی داخلش است | چرا خطرناک است |
|---|---|
| `sess:<token>` | **خودِ توکن در نام کلید است** — تا ۳۰ روز بدون رمز وارد حساب می‌شود |
| `acct:<email>.pass` | `{salt,hash}` — آفلاین قابل کرک است |
| `coupon:<CODE>` | هر کسی می‌تواند ریدیم کند |

**راه‌حل — بدون دست‌زدن به گیت، خودِ اطلاعات را بی‌ارزش کن:**

```bash
# ۱. اول ببین چه چیزی هدف قرار می‌گیرد (هیچ تغییری نمی‌دهد)
npm run security:sanitize

# ۲. اعمال کن: سشن‌ها پاک، رمزها با رمز تصادفی جدید عوض، کوپن‌ها غیرفعال
npm run security:sanitize -- --apply

# ۳. dump داخل SQL را هم از نو بساز تا آن هم پاک شود
npm run db:dump
```

- رمزهای جدید در `data/rotated-pass.txt` نوشته می‌شوند (طبق `.gitignore` هرگز commit نمی‌شود) — بعد از تحویل دادن به صاحبانشان **حذفش کنید**.
- `data/kv.json` داده‌ی تست لوکال است؛ اگر نمی‌خواهید رمز لوکال عوض شود: `--no-passwords`.
- بعد از این کار، dump منتشرشده دیگر هیچ ارزشی ندارد.
- اگر `ADMIN_API_KEY` هم منتشر شده بود، از پنل ادمین کلید جدید بسازید و در Netlify ست کنید.

---

## ۹. استقرار روی Vercel

پروژه به‌صورت بومی Netlify-shaped است، اما لایه‌ی سازگاری Vercel داخل ریپو هست و
**هیچ کدی از `netlify/functions` کپی یا بازنویسی نمی‌شود**:

| فایل | نقش |
|---|---|
| `api/[...path].mjs` | تابع catch-all — درخواست Node را به `Request` استاندارد تبدیل می‌کند، به همان هندلرهای `netlify/functions` می‌سپارد و `Response` را برمی‌گرداند |
| `middleware.js` | قبل از سرو فایل استاتیک اجرا می‌شود و مسیرهای حساس (`/db/*`, `/scripts/*`, `/netlify/*`, `/data/*`, `server.mjs`, …) را 404 می‌کند — معادل ریدایرکت‌های force-404 در `netlify.toml` |
| `vercel.json` | rewrite مسیرهای `/shop/api/*` به تابع + هدرهای CSP/کش/امنیتی (معادل `netlify.toml`) + `maxDuration: 60` برای هندلرهای AI |

### ۹.۱ مراحل (داشبورد Vercel)

1. ریپو را push کنید و در Vercel: **Add New → Project → Import** (فریم‌ورک «Other» — تشخیص خودکار).
2. **قبل از اولین deploy** دیتابیس را وصل کنید: تب **Storage → Marketplace → Neon/Postgres → Connect**.
   این کار `POSTGRES_URL` را خودکار ست می‌کند — `netlify/lib/db.mjs` همین متغیر را هم می‌شناسد.
   ⚠️ روی Vercel **فقط PostgreSQL** کار می‌کند: دیسک serverless پایدار نیست (`KV_FILE` داده را بین درخواست‌ها گم می‌کند) و Netlify Blobs هم آنجا وجود ندارد. اگر دیتابیس وصل نباشد، API با 503 و پیام واضح جواب می‌دهد.
3. یک بار `db/schema-fresh.sql` را در SQL Editor دیتابیس اجرا کنید (Neon → Console).
4. Environment Variables (Settings → Environment Variables):
   - `POSTGRES_URL` — خودکار با اتصال Neon (یا دستی `DATABASE_URL`)
   - `ADMIN_API_KEY` — ۲۴+ کاراکتر hex (خرید فروشگاه به آن وابسته است)
   - `ADMIN_EMAILS` — ایمیل ادمین
   - `COACH_OS_URL` — `https://<project>.vercel.app` (بعد از اولین deploy ست کنید و redeploy بگیرید)
   - `AI_API_KEY` — اختیاری (دستیار هوشمند)
   - `NODE_ENV` لازم نیست — Vercel خودش `production` می‌گذارد
5. Deploy → بعد از بالا آمدن سایت، `COACH_OS_URL` را ست و **Redeploy** کنید.
6. ادمین: `npm run admin:create` با `DATABASE_URL` همان دیتابیس، یا signup از UI + ارتقا با `ADMIN_EMAILS`.

### ۹.۲ نکته‌های Vercel

- **Region:** در Settings → Functions → Function Region، همان نزدیکی دیتابیس را انتخاب کنید
  (Neon us-east-2 → `iad1`) — تأخیر pg در هر درخواست sync دیده می‌شود.
- **AI و timeout:** مدل‌های رایگان OpenRouter (reasoning) گاهی کندند؛ `maxDuration: 60` ست شده
  که روی پلن Hobby هم مجاز است.
- **Rate-limit/lock:** مثل Netlify، محدودیت نرخ و `withLock` per-instance است (serverless چند نمونه دارد) —
  محدودیت واقعی و سخت‌گیرانه روی خود دیتابیس اعمال می‌شود، این‌ها فقط لایه‌ی کمکی‌اند.
- **تست بعد از deploy:** `/api/health` باید `"backend":"postgres"` بدهد؛ بعد همان چک‌لیست بخش ۶.

---

## خلاصه‌ی یک‌خطی

**بدون `data/kv.json` آپلود کن، متغیرهای محیطی را روی سرور ست کن، ادمین را روی سرور بساز، HTTPS بگذار، ۵ دقیقه تست کن.**
