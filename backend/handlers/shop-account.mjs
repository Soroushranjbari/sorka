// CoachMint — Shop account API (server-side proxy to the app's auth/billing).
// Lets the buyer sign in on the SHOP with their CoachMint email+password and
// see their subscription state and purchase history — without exposing any
// secrets to the browser and without a second account system.
//   POST /shop/api/account/login   {email,password} -> {ok,token,coach,workspace,billing,quota}
//   GET  /shop/api/account/session (Bearer)         -> {ok,coach,workspace,access,billing,quota}
//   GET  /shop/api/account/orders  (Bearer)         -> {ok,orders:[...]}
// All CoachMint calls happen here (server-to-server) so this page keeps working
// even if the shop later moves to its own domain.
//
// NOTE (v16.2): moved here from shop/api/account.mjs — Netlify only bundles the
// single [functions] directory from netlify.toml, so the old location was never
// deployed and the shop account page could never sign in on Netlify.
import { kv } from '../lib/db.mjs';
import { readJsonCapped, tooLarge, tooMany, badJson, rateLimit, ipOf, secure } from '../lib/guard.mjs';

const COACH_OS_URL = (process.env.COACH_OS_URL || '').replace(/\/+$/, '');
const st = kv('shop-orders');
const MAX_BYTES = 10_000;

const j = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

async function verifyToken(token) {
  if (!COACH_OS_URL || !token) return null;
  try {
    const r = await fetch(`${COACH_OS_URL}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch { return null; }
}

async function billingOf(token) {
  try {
    const r = await fetch(`${COACH_OS_URL}/api/billing/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch { return null; }
}

export default async (req) => {
  const url = new URL(req.url);
  const action = (url.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();

  if (req.method === 'POST' && action === 'login') {
    const lim = rateLimit(`shopacct:${ipOf(req)}`, 10, 60_000);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const { data: body, tooLarge: big, bad } = await readJsonCapped(req, MAX_BYTES);
    if (big) return tooLarge(MAX_BYTES);
    if (bad) return badJson();
    if (!COACH_OS_URL) return j(503, { ok: false, error: 'account-service-not-configured' });
    // Forward the buyer's IP: without this the app-side rate limiter sees every
    // shop request as one client, so ALL shop signups/logins shared a single
    // 5/min (signup) / 10/min (login) bucket — a busy shop locked everyone out.
    const fwd = { 'content-type': 'application/json', 'x-forwarded-for': ipOf(req) };
    let upstream;
    try {
      upstream = await fetch(`${COACH_OS_URL}/api/auth/login`, {
        method: 'POST', headers: fwd,
        body: JSON.stringify({ email: body?.email, password: body?.password })
      });
    } catch { return j(502, { ok: false, error: 'coachmint-unreachable' }); }
    const d = await upstream.json().catch(() => null);
    if (!upstream.ok || !d || !d.ok) return j(401, { ok: false, error: 'bad-credentials' });
    const bill = await billingOf(d.token);
    return secure(j(200, {
      ok: true, token: d.token, coach: d.coach, workspace: d.workspace,
      access: d.access, billing: bill && bill.billing, quota: bill && bill.quota
    }));
  }

  /* POST /shop/api/account/signup {name,email,password,coupon?}
     Lets a buyer create their CoachMint account WITHOUT leaving the shop —
     the checkout success page embeds this form, so the plan activates right
     here instead of "go to the app, sign up, hope the code pre-fills".
     The app's /api/auth/signup already accepts an optional `coupon` and
     redeems it server-side in the same request (a bad code never blocks the
     account — it comes back as redeemError), so the proxy only forwards. */
  if (req.method === 'POST' && action === 'signup') {
    const lim = rateLimit(`shopacct:${ipOf(req)}`, 10, 60_000);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const { data: body, tooLarge: big, bad } = await readJsonCapped(req, MAX_BYTES);
    if (big) return tooLarge(MAX_BYTES);
    if (bad) return badJson();
    if (!COACH_OS_URL) return j(503, { ok: false, error: 'account-service-not-configured' });
    // Same IP forwarding as login — see the comment there.
    let upstream;
    try {
      upstream = await fetch(`${COACH_OS_URL}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ipOf(req) },
        body: JSON.stringify({
          name: body?.name, email: body?.email,
          password: body?.password, coupon: body?.coupon
        })
      });
    } catch { return j(502, { ok: false, error: 'coachmint-unreachable' }); }
    const d = await upstream.json().catch(() => null);
    if (!upstream.ok || !d || !d.ok) {
      // Forward the app's own validation errors (bad-email, bad-name,
      // weak-password, email-taken) so the shop UI can show a precise message
      // instead of a generic failure.
      return j(upstream.status === 409 ? 409 : 400, { ok: false, error: (d && d.error) || 'signup-failed' });
    }
    const bill = await billingOf(d.token);
    return secure(j(200, {
      ok: true, token: d.token, coach: d.coach, workspace: d.workspace,
      access: d.access, billing: bill && bill.billing, quota: bill && bill.quota,
      redeemed: !!d.redeemed, redeemError: d.redeemError || null
    }));
  }

  if (req.method === 'GET' && (action === 'session' || action === 'orders')) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const me = await verifyToken(token);
    if (!me) return j(401, { ok: false, error: 'unauthorized' });
    if (action === 'session') {
      const bill = await billingOf(token);
      // `workspace` is part of /api/auth/me's payload — without forwarding it the
      // account page could never show the workspace code after a page reload.
      return secure(j(200, {
        ok: true, coach: me.coach, workspace: me.workspace, access: me.access,
        billing: bill && bill.billing, quota: bill && bill.quota
      }));
    }
    const email = String((me.coach && me.coach.email) || '').toLowerCase();
    const idx = (await st.get(`idx:${email}`, { type: 'json' })) || [];
    const orders = [];
    for (const ref of idx.slice(0, 100)) {
      try { const o = await st.get(`order:${ref}`, { type: 'json' }); if (o) orders.push(o); } catch {}
    }
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return secure(j(200, { ok: true, orders }));
  }

  return j(404, { ok: false, error: 'not-found' });
};

export const config = { path: '/shop/api/account/*' };
