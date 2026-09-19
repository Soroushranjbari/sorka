// Coach OS — Phase 1 Auth shared logic: signup/login + session issue.
// Bundled via relative import (netlify/lib), NOT a deployed function.
import {
  store, j, normEmail, newId, newToken,
  hashPassword, verifyPassword,
  accessOf, ownerOf,
  EMAIL_RE, TRIAL_DAYS, SESSION_TTL_MS
} from './saas.mjs';
import { randomBytes } from 'node:crypto';
import { adminEmails, normCoupon, redeemForAccount } from './billing.mjs';
import { readJsonCapped, tooLarge, badJson, withLock } from './guard.mjs';

export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export const publicCoach = (a) =>
  a ? { id: a.id, email: a.email, name: a.name, plan: a.plan || 'trial', role: a.role || 'coach' } : null;

export const publicWs = (w) =>
  w ? { id: w.id, code: w.code, plan: w.plan || 'trial', status: w.status || 'trial' } : null;

export async function issueSession(st, acct) {
  const token = newToken();
  const now = Date.now();
  await st.setJSON(`sess:${token}`, {
    coachId: acct.id, email: acct.email,
    createdAt: now, expiresAt: now + SESSION_TTL_MS
  });
  // Per-coach session index so a password reset can revoke every session.
  try {
    const idx = (await st.get(`sess-idx:${acct.id}`, { type: 'json' })) || [];
    if (!idx.includes(token)) idx.push(token);
    await st.setJSON(`sess-idx:${acct.id}`, idx.slice(-50));
  } catch {}
  return token;
}

/** Revoke every active session of a coach (used after a password reset). */
export async function killSessions(st, coachId) {
  try {
    const idx = (await st.get(`sess-idx:${coachId}`, { type: 'json' })) || [];
    for (const t of idx) { try { await st.delete(`sess:${t}`); } catch {} }
    await st.delete(`sess-idx:${coachId}`);
  } catch {}
}

/* ---------- Password reset ---------- */

/** Delivery: RESEND_API_KEY -> real email; RESET_DELIVERY=return -> link in
 *  the API response (self-host/dev only); otherwise -> server console log. */
async function deliverResetLink(email, link) {
  const key = process.env.RESEND_API_KEY;
  if (key) {
    try {
      const from = process.env.RESET_FROM || 'Coach OS <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [email],
          subject: 'Coach OS — password reset',
          html: `<p>Click the link below to choose a new password (valid for 1 hour):</p>
                 <p><a href="${link}">${link}</a></p>
                 <p>If you did not request this, ignore this email.</p>`
        })
      });
      if (!r.ok) throw new Error(`resend ${r.status}`);
      return 'email';
    } catch (e) {
      // Delivery failure used to bubble up as a 500 AFTER the token was stored,
      // leaving the user with an error and no link anywhere. Fall back to the
      // console log so the link is at least retrieable on the server.
      console.error('[coach-os] reset email delivery failed:', e.message, '— logging link instead');
    }
  }
  if ((process.env.RESET_DELIVERY || '').toLowerCase() === 'return') return 'return';
  console.log(`[coach-os] password reset link for ${email}: ${link}`);
  return 'log';
}

/** Create a reset token for the email (if the account exists).
 *  @returns {sent:boolean, delivery?:string, link?:string} */
export async function requestPasswordReset(st, email, origin) {
  const acct = await st.get(`acct:${email}`, { type: 'json' });
  if (!acct) return { sent: false };
  const token = 'rs_' + randomBytes(24).toString('hex');
  await st.setJSON(`reset:${token}`, {
    coachId: acct.id, email,
    expiresAt: Date.now() + RESET_TTL_MS
  });
  const link = `${origin}/#reset=${token}`;
  const delivery = await deliverResetLink(email, link);
  return { sent: true, delivery, link: delivery === 'return' ? link : undefined };
}

/** Consume a reset token and set the new password. Revokes all sessions.
 *  @returns {ok:boolean, error?:string} */
export async function performPasswordReset(st, token, password) {
  const rec = await st.get(`reset:${token}`, { type: 'json' });
  if (!rec || !rec.coachId) return { ok: false, error: 'bad-token' };
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    try { await st.delete(`reset:${token}`); } catch {}
    return { ok: false, error: 'bad-token' };
  }
  if (String(password || '').length < 8) return { ok: false, error: 'weak-password' };
  const acct = await st.get(`acct:${rec.email}`, { type: 'json' });
  if (!acct || acct.id !== rec.coachId) return { ok: false, error: 'bad-token' };
  acct.pass = hashPassword(password);
  acct.pwChangedAt = Date.now();
  await st.setJSON(`acct:${acct.email}`, acct);
  try { await st.delete(`reset:${token}`); } catch {}
  await killSessions(st, acct.id);
  return { ok: true };
}

/** Ensure the coach owns a workspace; create one on first signup.
 *  Callers (signup/login) MUST hold the `acct:<email>` withLock — this
 *  mutates the account record and creates workspace rows. */
export async function ensureWorkspace(st, acct) {
  if (acct.workspaceId) {
    const w = await st.get(`ws:${acct.workspaceId}`, { type: 'json' });
    if (w) return w;
  }
  const C = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 12; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += C[Math.floor(Math.random() * C.length)];
    if (await st.get(`ws-by-code:${code}`, { type: 'json' })) continue;
    const ws = {
      id: newId('ws'), owner: ownerOf(acct), code,
      plan: acct.plan || 'trial', status: 'trial',
      createdAt: Date.now(), claimedAt: null
    };
    await st.setJSON(`ws:${ws.id}`, ws);
    await st.setJSON(`ws-by-code:${code}`, { wid: ws.id });
    acct.workspaceId = ws.id;
    await st.setJSON(`acct:${acct.email}`, acct);
    try {
      const idx = (await st.get('index:coaches', { type: 'json' })) || [];
      if (!idx.includes(acct.id)) { idx.push(acct.id); await st.setJSON('index:coaches', idx); }
    } catch {}
    return ws;
  }
  throw new Error('code-exhausted');
}

/* Auth bodies are tiny ({name,email,password}) — 16 KB is generous. Every
   other endpoint reads via readJsonCapped; signup/login previously used an
   UNCAPPED req.json(), letting a multi-megabyte body be buffered and parsed. */
const AUTH_BODY_MAX = 16_000;

export async function signup(req, st) {
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, AUTH_BODY_MAX);
  if (big) return tooLarge(AUTH_BODY_MAX);
  if (bad) return badJson();
  const email = normEmail(body?.email);
  const name = String(body?.name || '').trim().slice(0, 80);
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email)) return j(400, { ok: false, error: 'bad-email' });
  if (!name) return j(400, { ok: false, error: 'bad-name' });
  if (password.length < 8) return j(400, { ok: false, error: 'weak-password' });
  // Optional activation code from the shop purchase (coach-os-coupon) — the
  // coach can land in the app with the plan ALREADY active, no Settings detour.
  const coupon = normCoupon(body?.coupon);
  // The existence check + account/workspace creation must be atomic per
  // account: two concurrent signups with the same email could otherwise both
  // pass the check and create duplicate accounts (one acct-by-id orphaned).
  const out = await withLock(`acct:${email}`, async () => {
    if (await st.get(`acct:${email}`, { type: 'json' })) {
      return { err: j(409, { ok: false, error: 'email-taken' }) };
    }
    const now = Date.now();
    const acct = {
      id: newId('coach'), email, name,
      pass: hashPassword(password),
      plan: 'trial', workspaceId: null,
      role: adminEmails().includes(email) ? 'admin' : 'coach',
      sub: null, trialEndsAt: now + TRIAL_DAYS * 86400000,
      createdAt: now
    };
    await st.setJSON(`acct:${email}`, acct);
    await st.setJSON(`acct-by-id:${acct.id}`, { email });
    const ws = await ensureWorkspace(st, acct);
    const token = await issueSession(st, acct);
    return { token, coach: publicCoach(acct), workspace: publicWs(ws), acct };
  });
  if (out.err) return out.err;
  const resp = {
    ok: true, token: out.token,
    coach: out.coach,
    workspace: out.workspace,
    access: accessOf(out.acct)
  };
  // Redeem AFTER the account lock released: redeemForAccount locks
  // coupon → acct, and acquiring the coupon lock while still holding acct here
  // would reverse that global order (deadlock with /api/billing/redeem).
  // A bad/used code NEVER blocks the account — the coach still gets in (trial)
  // and the client surfaces the error, keeping the code for a retry.
  if (coupon) {
    const r = await redeemForAccount(st, out.acct, coupon);
    if (r.ok) { resp.access = r.access; resp.billing = r.billing; resp.redeemed = true; }
    else resp.redeemError = r.error;
  }
  return j(200, resp);
}

export async function login(req, st) {
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, AUTH_BODY_MAX);
  if (big) return tooLarge(AUTH_BODY_MAX);
  if (bad) return badJson();
  const email = normEmail(body?.email);
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email) || !password) return j(400, { ok: false, error: 'bad-credentials' });
  const acct = await st.get(`acct:${email}`, { type: 'json' });
  if (!acct || !verifyPassword(password, acct.pass)) {
    return j(401, { ok: false, error: 'bad-credentials' });
  }
  // Login is email + password ONLY. Activation codes are redeemed at SIGNUP
  // (the post-purchase flow) or manually via /api/billing/redeem (Settings →
  // Account, for renewals) — never here, so a code in the body is ignored and
  // stays redeemable.
  // Promote to admin on login if ADMIN_EMAILS changed since signup — the role
  // flag in the account record is the durable source of truth afterwards.
  // Same lock as signup: role write + workspace ensure + session issue are a
  // read-modify-write sequence on the account record.
  const out = await withLock(`acct:${email}`, async () => {
    if (acct.role !== 'admin' && adminEmails().includes(email)) {
      acct.role = 'admin';
      await st.setJSON(`acct:${email}`, acct);
    }
    const ws = await ensureWorkspace(st, acct);
    const token = await issueSession(st, acct);
    return { token, coach: publicCoach(acct), workspace: publicWs(ws), acct };
  });
  return j(200, {
    ok: true, token: out.token,
    coach: out.coach,
    workspace: out.workspace,
    access: accessOf(out.acct)
  });
}

/** Legacy import helper shared by claim flows: copy old anonymous bytes. */
export async function importLegacy(st, legacy, ws) {
  if (!legacy || !legacy.data || ws.__imported) return false;
  await st.setJSON(`ws-meta:${ws.id}`, {
    rev: legacy.rev || 0, data: legacy.data,
    owner: ws.owner, code: ws.code, updatedAt: Date.now()
  });
  // Persist the flag on the workspace row — without it the guard above could
  // never fire and a re-claim would overwrite the imported meta again.
  ws.__imported = true;
  await st.setJSON(`ws:${ws.id}`, ws);
  return true;
}
