// Coach OS — Shop checkout API (server-side, keeps ADMIN_API_KEY secret).
// The shop frontend (checkout.html) calls /shop/api/checkout; this module
// verifies the (demo) payment and forwards to the Coach OS issue-coupon API.
//
// PRODUCTION: replace simulatePayment() with your gateway flow:
//   1. POST /shop/api/checkout  -> create order, return gateway redirect URL
//   2. gateway callback/verify  -> confirm payment server-side
//   3. THEN call issueCoupon()  -> store code with the order, email it
// Never trust the browser for "payment succeeded".
import { createHash } from 'node:crypto';

const COACH_OS_URL = (process.env.COACH_OS_URL || '').replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const PRICES = { basic: 290000, professional: 790000, club: 2490000 };

/** Demo payment — always succeeds. Swap for ZarinPal/… verification.
 *  ref is derived deterministically from email+plan so retries of the same
 *  order map to the same payment reference (and thus the same coupon). */
function simulatePayment({ planId, email }) {
  if (!PRICES[planId]) return { ok: false, error: 'bad-plan' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''))) return { ok: false, error: 'bad-email' };
  const ref = 'DEMO-' + createHash('sha256').update(`${email}:${planId}`).digest('hex').slice(0, 12).toUpperCase();
  return { ok: true, ref };
}

/** Deterministic, retry-safe coupon code derived from the payment reference:
 *  the same order always maps to the same code (duplicates -> 409, harmless). */
function codeFor(ref, planId) {
  const h = createHash('sha256').update(`${ref}:${planId}:${ADMIN_API_KEY}`).digest('hex').toUpperCase();
  const C = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += C[parseInt(h[i * 2] + h[i * 2 + 1], 16) % C.length];
  return `${planId.slice(0, 3).toUpperCase()}-${s}`;
}

async function issueCoupon(planId, code) {
  if (!COACH_OS_URL || !ADMIN_API_KEY) {
    // Local/demo fallback: mint the code here so the flow still completes.
    // The code will NOT exist in Coach OS until ADMIN_API_KEY is configured.
    return { ok: true, demo: true, coupons: [code] };
  }
  const r = await fetch(`${COACH_OS_URL}/api/billing/issue-coupon`, {
    method: 'POST',
    headers: { 'x-api-key': ADMIN_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ planId, durationDays: 30, maxUses: 1, count: 1, code })
  });
  const d = await r.json().catch(() => null);
  if (r.status === 409 && d && d.error === 'code-exists') {
    return { ok: true, coupons: [code] }; // retry of the same order — fine
  }
  if (!r.ok || !d || !d.ok) return { ok: false, error: (d && d.error) || `coach-os-${r.status}` };
  return d;
}

const j = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

export default async (req) => {
  if (req.method !== 'POST') return j(405, { ok: false, error: 'method not allowed' });
  let body = null;
  try { body = await req.json(); } catch { return j(400, { ok: false, error: 'bad json' }); }
  const planId = String(body?.planId || '');
  const email = String(body?.email || '').trim().toLowerCase();
  const pay = simulatePayment({ planId, email });
  if (!pay.ok) return j(400, { ok: false, error: pay.error });
  const out = await issueCoupon(planId, codeFor(pay.ref, planId));
  if (!out.ok) return j(502, { ok: false, error: out.error });
  return j(200, { ok: true, coupons: out.coupons, demo: !!out.demo, ref: pay.ref });
};

export const config = { path: '/shop/api/checkout' };
