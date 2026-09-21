// CoachMint — branded transactional email (Resend).
// ONE sender identity for the whole product: the welcome email (app signup),
// the purchase confirmation with the activation code (shop checkout) and the
// password-reset link all go out from the same address.
//
// Delivery rules (shared with the reset flow):
//   RESEND_API_KEY set  -> real email via api.resend.com
//   otherwise           -> skipped silently (dev/test); the reset flow has its
//                          own console/return fallbacks, transactional mail
//                          (welcome/coupon) simply does not send.
//
// `sendMail` NEVER throws and NEVER rejects — a mail outage must never fail a
// signup or a checkout that already succeeded server-side.
//
// Env:
//   RESEND_API_KEY  api key from https://resend.com (optional)
//   MAIL_FROM       "CoachMint <noreply@yourdomain>" — needs a verified domain
//                   in Resend. Default works for testing (delivers only to the
//                   Resend account owner's own address).

const FROM = () => process.env.MAIL_FROM || process.env.RESET_FROM
  || 'CoachMint <onboarding@resend.dev>';

export const mailEnabled = () => !!process.env.RESEND_API_KEY;

/** Send one email. Resolves to 'email' | 'skipped' | 'failed' — never throws. */
export async function sendMail({ to, subject, html }) {
  if (!mailEnabled()) return 'skipped';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return 'email';
  } catch (e) {
    console.error('[coachmint] email delivery failed:', subject, '→', e.message);
    return 'failed';
  }
}

/* ---------- shared brand chrome ---------- */

const SHELL = (titleFa, bodyEn, bodyFa, cta) => `
<div style="font-family:Tahoma,'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;direction:ltr">
  <div style="text-align:center;padding-bottom:18px;border-bottom:2px solid #B5E048">
    <span style="font-size:22px;font-weight:800;color:#161C04;letter-spacing:2px">COACH<span style="color:#7BA912">MINT</span></span>
  </div>
  <div style="padding:22px 4px;font-size:14.5px;line-height:1.9;color:#24292F">
    <p style="margin:0 0 14px">${bodyEn}</p>
    <p style="margin:0 0 18px;direction:rtl;text-align:right;color:#4B5563">${bodyFa}</p>
    ${cta || ''}
  </div>
  <div style="border-top:1px solid #E5E7EB;padding-top:14px;font-size:11.5px;color:#9CA3AF;text-align:center">
    CoachMint — One coach. One workspace. · <span dir="rtl">یک مربی، یک فضای کاری</span>
  </div>
</div>`;

const CTA = (href, en, fa) => `
  <div style="text-align:center;margin:20px 0 6px">
    <a href="${href}" style="display:inline-block;background:#B5E048;color:#161C04;font-weight:800;font-size:15px;padding:12px 30px;border-radius:12px;text-decoration:none">${en}</a>
  </div>
  <p style="text-align:center;font-size:12px;color:#9CA3AF;margin:4px 0 0" dir="rtl">${fa}</p>`;

/* ---------- 1) welcome (app signup) ---------- */

export function welcomeMail(name, email, appUrl) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'Coach';
  return sendMail({
    to: email,
    subject: 'Welcome to CoachMint 🎉',
    html: SHELL(
      'خوش آمدی',
      `<b>Hi ${first}!</b> Your CoachMint workspace is ready — your 14-day free trial is active, no card required. Add your first client, build a workout and connect their phone with a personal code.`,
      `<b>سلام ${first}!</b> فضای کاری CoachMint شما آماده است — ۱۴ روز اشتراک آزمایشی رایگان فعال شد، بدون نیاز به کارت. اولین شاگردت را اضافه کن، تمرین بساز و با کد اختصاصی گوشی‌اش را متصل کن.`,
      appUrl ? CTA(appUrl, 'Open your workspace', 'ورود به فضای کاری') : ''
    )
  });
}

/* ---------- 2) purchase confirmation + activation code (shop) ---------- */

export function couponMail(name, email, code, planLabel, appUrl) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const hi = first ? `Hi ${first}!` : 'Thank you for your purchase!';
  const hiFa = first ? `سلام ${first}!` : 'از خرید شما سپاسگزاریم!';
  return sendMail({
    to: email,
    subject: `Your CoachMint activation code — ${code}`,
    html: SHELL(
      'کد فعال‌سازی',
      `<b>${hi}</b> Your <b>${planLabel}</b> purchase is confirmed. Keep this single-use activation code — you will enter it once at signup (or later in Settings → Account):`,
      `<b>${hiFa}</b> خرید پلن <b>${planLabel}</b> تأیید شد. این کد فعال‌سازی یک‌بار‌مصرف را نگه دارید — هنگام ثبت‌نام (بعداً در تنظیمات ← حساب) آن را وارد کنید:`,
      `<div style="text-align:center;margin:18px 0">
         <div style="display:inline-block;background:#F4F8E4;border:2px dashed #7BA912;border-radius:12px;padding:14px 26px;font-size:22px;font-weight:800;letter-spacing:2px;color:#161C04;direction:ltr">${code}</div>
       </div>` + (appUrl ? CTA(appUrl, 'Create your account', 'ساخت حساب کاربری') : '')
    )
  });
}
