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
// NOTE (v16.2): moved here from shop/api/account.mjs — the shop account routes
// were originally outside the deployed functions directory, so the old location
// was never bundled and the shop account page could never sign in.
// It now lives in backend/ and keeps the public path /shop/api/account/*
// via `export const config` below (server.mjs maps it for self-hosting, and
// api/[...path].mjs re-dispatches /api/shop/api/account/* for Vercel).
import { kv } from '../lib/db.mjs';
import { readJsonCapped, tooLarge, tooMany, badJson, rateLimit, ipOf, secure } from '../lib/guard.mjs';
import { store, sessionOf, accountById, accessOf } from '../lib/saas.mjs';
import { signup as authSignup, login as authLogin, publicCoach, publicWs } from '../lib/auth-shared.mjs';
import { publicBilling, planOf, countSeats } from '../lib/billing.mjs';

const COACH_OS_URL = (process.env.COACH_OS_URL || '').replace(/\/+$/, '');
const st = kv('shop-orders');
const MAX_BYTES = 10_000;

const j = (status, obj) => secure(new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
}));

async function verifyToken(token) {
  if (!token) return null;
  if (COACH_OS_URL) {
    try {
      const r = await fetch(`${COACH_OS_URL}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        if (d && d.ok) return d;
      }
    } catch {}
  }
  const appSt = store();
  const s = await sessionOf(appSt, token);
  if (!s) return null;
  const acct = await accountById(appSt, s.coachId);
  if (!acct) return null;
  let ws = null;
  try {
    if (acct.workspaceId) ws = await appSt.get(`ws:${acct.workspaceId}`, { type: 'json' });
  } catch {}
  return { ok: true, coach: publicCoach(acct), workspace: publicWs(ws), access: accessOf(acct) };
}

async function billingOf(token) {
  if (!token) return null;
  if (COACH_OS_URL) {
    try {
      const r = await fetch(`${COACH_OS_URL}/api/billing/me`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        if (d && d.ok) return d;
      }
    } catch {}
  }
  const appSt = store();
  const s = await sessionOf(appSt, token);
  if (!s) return null;
  const acct = await accountById(appSt, s.coachId);
  if (!acct) return null;
  let seats = 0;
  try {
    if (acct.workspaceId) {
      const m = await appSt.get(`ws-meta:${acct.workspaceId}`, { type: 'json' });
      if (m && m.data) seats = countSeats(m.data);
    }
  } catch {}
  const plan = planOf(acct);
  return {
    ok: true,
    billing: publicBilling(acct),
    quota: { plan: plan.id, max: plan.maxClients, used: seats }
  };
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

    let d = null;
    let ok = false;
    if (COACH_OS_URL) {
      const fwd = { 'content-type': 'application/json', 'x-forwarded-for': ipOf(req) };
      try {
        const upstream = await fetch(`${COACH_OS_URL}/api/auth/login`, {
          method: 'POST', headers: fwd,
          body: JSON.stringify({ email: body?.email, password: body?.password })
        });
        d = await upstream.json().catch(() => null);
        ok = upstream.ok && d && d.ok;
      } catch {}
    }

    if (!ok) {
      const inReq = new Request(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: body?.email, password: body?.password })
      });
      const inRes = await authLogin(inReq, store());
      d = await inRes.json().catch(() => null);
      if (!inRes.ok || !d || !d.ok) {
        return j(inRes.status || 401, { ok: false, error: (d && d.error) || 'bad-credentials' });
      }
    }

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

    let d = null;
    let ok = false;
    let upstreamStatus = 400;

    if (COACH_OS_URL) {
      try {
        const upstream = await fetch(`${COACH_OS_URL}/api/auth/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ipOf(req) },
          body: JSON.stringify({
            name: body?.name, email: body?.email,
            password: body?.password, coupon: body?.coupon
          })
        });
        upstreamStatus = upstream.status;
        d = await upstream.json().catch(() => null);
        ok = upstream.ok && d && d.ok;
      } catch {}
    }

    if (!ok && (!COACH_OS_URL || upstreamStatus !== 409)) {
      const inReq = new Request(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: body?.name, email: body?.email,
          password: body?.password, coupon: body?.coupon
        })
      });
      const inRes = await authSignup(inReq, store());
      d = await inRes.json().catch(() => null);
      if (!inRes.ok || !d || !d.ok) {
        return j(inRes.status === 409 ? 409 : 400, { ok: false, error: (d && d.error) || 'signup-failed' });
      }
    } else if (!ok) {
      return j(upstreamStatus === 409 ? 409 : 400, { ok: false, error: (d && d.error) || 'signup-failed' });
    }

    const bill = await billingOf(d.token);
    return secure(j(200, {
      ok: true, token: d.token, coach: d.coach, workspace: d.workspace,
      access: d.access, billing: (bill && bill.billing) || d.billing, quota: (bill && bill.quota) || null,
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
