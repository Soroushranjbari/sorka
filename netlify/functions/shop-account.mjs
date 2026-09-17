// Coach OS — Shop account API (server-side proxy to the app's auth/billing).
// Lets the buyer sign in on the SHOP with their Coach OS email+password and
// see their subscription state and purchase history — without exposing any
// secrets to the browser and without a second account system.
//   POST /shop/api/account/login   {email,password} -> {ok,token,coach,workspace,billing,quota}
//   GET  /shop/api/account/session (Bearer)         -> {ok,coach,workspace,access,billing,quota}
//   GET  /shop/api/account/orders  (Bearer)         -> {ok,orders:[...]}
// All Coach OS calls happen here (server-to-server) so this page keeps working
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
    let upstream;
    try {
      upstream = await fetch(`${COACH_OS_URL}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: body?.email, password: body?.password })
      });
    } catch { return j(502, { ok: false, error: 'coach-os-unreachable' }); }
    const d = await upstream.json().catch(() => null);
    if (!upstream.ok || !d || !d.ok) return j(401, { ok: false, error: 'bad-credentials' });
    const bill = await billingOf(d.token);
    return secure(j(200, {
      ok: true, token: d.token, coach: d.coach, workspace: d.workspace,
      access: d.access, billing: bill && bill.billing, quota: bill && bill.quota
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
