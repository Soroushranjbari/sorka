// CoachMint — Phase 1 Auth API: me/logout/claim + router.
import {
  store, j, normCode, bearerOf,
  sessionOf, accountById, accessOf, ownerOf,
  CODE_RE, newId
} from '../lib/saas.mjs';
import {
  signup, login, publicWs, importLegacy,
  requestPasswordReset, performPasswordReset,
  changePassword, killSessionsExcept
} from '../lib/auth-shared.mjs';
import { legacyBlobs } from '../lib/saas.mjs';
import { rateLimit, ipOf, originOf, readJsonCapped, tooMany, tooLarge, badJson, secure, withLock } from '../lib/guard.mjs';

const legacyStore = () => legacyBlobs();

/* Rate limits (per IP, fixed window):
   login 10/min · signup 5/min · forgot 3/10min · reset 10/10min · claim 10/min
   · profile/password 10/min (logout-others reuses the profile bucket) */
const RL = {
  login: [10, 60_000],
  signup: [5, 60_000],
  forgot: [3, 600_000],
  reset: [10, 600_000],
  claim: [10, 60_000],
  profile: [10, 60_000],
  password: [10, 60_000]
};
function limited(req, kind) {
  const [limit, win] = RL[kind];
  const r = rateLimit(`${kind}:${ipOf(req)}`, limit, win);
  return r.ok ? null : tooMany(r.retryAfter);
}

async function me(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const ws = acct.workspaceId ? await st.get(`ws:${acct.workspaceId}`, { type: 'json' }) : null;
  return j(200, { ok: true, coach: acct && { id: acct.id, email: acct.email, name: acct.name, plan: acct.plan || 'trial', role: acct.role || 'coach' }, workspace: publicWs(ws), access: accessOf(acct) });
}

async function logout(req, st) {
  const t = bearerOf(req);
  if (t) { try { await st.delete(`sess:${t}`); } catch {} }
  return j(200, { ok: true });
}

/** POST /api/auth/password {current, password} — change the signed-in
 *  coach's password. The Settings → Security form used to be a dead toast:
 *  the ONLY way to change a password was the forgot/reset email round-trip.
 *  Verifies the current password, then signs out every OTHER device (the
 *  current session token is kept so the tab stays logged in). */
async function password(req, st) {
  const lim = limited(req, 'password');
  if (lim) return lim;
  const token = bearerOf(req);
  const s = await sessionOf(st, token);
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 10_000);
  if (big) return tooLarge(10_000);
  if (bad) return badJson();
  return withLock(`acct:${acct.email}`, async () => {
    const cur = (await st.get(`acct:${acct.email}`, { type: 'json' })) || acct;
    const out = await changePassword(st, cur, body?.current, body?.password, token);
    if (!out.ok) {
      return j(out.error === 'wrong-password' ? 403 : 400, { ok: false, error: out.error });
    }
    return j(200, { ok: true, message: 'Password updated — other devices were signed out' });
  });
}

/** POST /api/auth/logout-others — revoke every session of this coach except
 *  the caller's own. Pairs with the "Sign out others" button in Settings →
 *  Security (which was also a dead toast). */
async function logoutOthers(req, st) {
  const lim = limited(req, 'profile');
  if (lim) return lim;
  const token = bearerOf(req);
  const s = await sessionOf(st, token);
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  await killSessionsExcept(st, s.coachId, token);
  return j(200, { ok: true, message: 'Signed out of all other devices' });
}

/** POST /api/auth/profile {name} — rename the signed-in coach. The app's
 *  profile form used to be display-only while every screen hardcoded a demo
 *  persona, so the signup name never showed anywhere. */
async function profile(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 10_000);
  if (big) return tooLarge(10_000);
  if (bad) return badJson();
  const name = String(body?.name || '').trim().slice(0, 80);
  if (name.length < 2) return j(400, { ok: false, error: 'bad-name' });
  return withLock(`acct:${acct.email}`, async () => {
    const cur = (await st.get(`acct:${acct.email}`, { type: 'json' })) || acct;
    cur.name = name;
    await st.setJSON(`acct:${cur.email}`, cur);
    return j(200, {
      ok: true,
      coach: { id: cur.id, email: cur.email, name: cur.name, plan: cur.plan || 'trial', role: cur.role || 'coach' }
    });
  });
}

async function claim(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (acct.workspaceId) {
    const w = await st.get(`ws:${acct.workspaceId}`, { type: 'json' });
    return j(200, { ok: true, workspace: publicWs(w), note: 'already-owned' });
  }
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 10_000);
  if (big) return tooLarge(10_000);
  if (bad) return badJson();
  const code = normCode(body?.legacyCode);
  if (!CODE_RE.test(code)) return j(400, { ok: false, error: 'bad-code' });
  // Claim mutates the account + creates/adopts a workspace — same lock the
  // signup/login paths hold, so a concurrent login cannot interleave.
  return withLock(`acct:${acct.email}`, async () => {
    const ptr = await st.get(`ws-by-code:${code}`, { type: 'json' });
    let ws = ptr ? await st.get(`ws:${ptr.wid}`, { type: 'json' }) : null;
    if (ws && ws.owner && ws.owner !== ownerOf(acct)) {
      return j(409, { ok: false, error: 'already-claimed' });
    }
    // Adopt legacy anonymous bytes (pre-Phase-1 store) when present.
    let legacy = null;
    if (!ws) { try { legacy = await legacyStore().get(code, { type: 'json' }); } catch {} }
    if (!ws) {
      ws = { id: newId('ws'), owner: ownerOf(acct), code, plan: acct.plan || 'trial', status: 'trial', createdAt: Date.now(), claimedAt: Date.now() };
      await st.setJSON(`ws:${ws.id}`, ws);
      await st.setJSON(`ws-by-code:${code}`, { wid: ws.id });
    } else {
      ws.owner = ownerOf(acct);
      ws.claimedAt = Date.now();
      await st.setJSON(`ws:${ws.id}`, ws);
    }
    const imported = await importLegacy(st, legacy, ws);
    acct.workspaceId = ws.id;
    await st.setJSON(`acct:${acct.email}`, acct);
    return j(200, { ok: true, workspace: publicWs(ws), imported });
  });
}

async function forgot(req, st) {
  const lim = limited(req, 'forgot');
  if (lim) return lim;
  const { data, tooLarge: big, bad } = await readJsonCapped(req, 10_000);
  if (big) return tooLarge(10_000);
  if (bad) return badJson();
  const email = String(data?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return j(400, { ok: false, error: 'bad-email' });
  const out = await requestPasswordReset(st, email, originOf(req));
  // Never reveal whether the account exists. The response shape must be
  // IDENTICAL for "account exists" and "account does not exist" — previously
  // `delivered:'email'` was only added when the account existed, which let
  // anyone enumerate registered coach emails through this endpoint.
  const resp = { ok: true, message: 'If the account exists, a reset link has been sent' };
  // RESET_DELIVERY=return is a self-host/dev-only mode that hands the link
  // back in the response; it is never enabled in production (deploy-check
  // fails the build if it is).
  if (out.sent && out.delivery === 'return') resp.resetLink = out.link;
  return j(200, resp);
}

async function reset(req, st) {
  const lim = limited(req, 'reset');
  if (lim) return lim;
  const { data, tooLarge: big, bad } = await readJsonCapped(req, 10_000);
  if (big) return tooLarge(10_000);
  if (bad) return badJson();
  const token = String(data?.token || '').trim();
  const out = await performPasswordReset(st, token, data?.password);
  if (!out.ok) return j(400, { ok: false, error: out.error || 'bad-token' });
  return j(200, { ok: true, message: 'Password updated — sign in with your new password' });
}

export default async (req) => {
  const st = store();
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const action = (segs[2] || '').toLowerCase();
  try {
    if (req.method === 'POST' && action === 'signup') { const lim = limited(req, 'signup'); return secure(lim || await signup(req, st)); }
    if (req.method === 'POST' && action === 'login') { const lim = limited(req, 'login'); return secure(lim || await login(req, st)); }
    if (req.method === 'POST' && action === 'logout') return secure(await logout(req, st));
    if (req.method === 'POST' && action === 'password') { const lim = limited(req, 'password'); return secure(lim || await password(req, st)); }
    if (req.method === 'POST' && action === 'logout-others') return secure(await logoutOthers(req, st));
    if (req.method === 'GET' && action === 'me') return secure(await me(req, st));
    if (req.method === 'POST' && action === 'profile') { const lim = limited(req, 'profile'); return secure(lim || await profile(req, st)); }
    if (req.method === 'POST' && action === 'claim') { const lim = limited(req, 'claim'); return secure(lim || await claim(req, st)); }
    if (req.method === 'POST' && action === 'forgot') return secure(await forgot(req, st));
    if (req.method === 'POST' && action === 'reset') return secure(await reset(req, st));
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/auth/*' };
