// Coach OS — Phase 1 Auth shared logic: signup/login + session issue.
// Bundled via relative import (netlify/lib), NOT a deployed function.
import {
  store, j, normEmail, newId, newToken,
  hashPassword, verifyPassword, readJson,
  accessOf, ownerOf,
  EMAIL_RE, TRIAL_DAYS
} from './saas.mjs';
import { randomBytes } from 'node:crypto';
import { adminEmails } from './billing.mjs';

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
    createdAt: now, expiresAt: now + 1000 * 60 * 60 * 24 * 30
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

/** Ensure the coach owns a workspace; create one on first signup. */
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

export async function signup(req, st) {
  const body = await readJson(req);
  const email = normEmail(body?.email);
  const name = String(body?.name || '').trim().slice(0, 80);
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email)) return j(400, { ok: false, error: 'bad-email' });
  if (!name) return j(400, { ok: false, error: 'bad-name' });
  if (password.length < 8) return j(400, { ok: false, error: 'weak-password' });
  if (await st.get(`acct:${email}`, { type: 'json' })) {
    return j(409, { ok: false, error: 'email-taken' });
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
  return j(200, {
    ok: true, token,
    coach: publicCoach(acct),
    workspace: publicWs(ws),
    access: accessOf(acct)
  });
}

export async function login(req, st) {
  const body = await readJson(req);
  const email = normEmail(body?.email);
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email) || !password) return j(400, { ok: false, error: 'bad-credentials' });
  const acct = await st.get(`acct:${email}`, { type: 'json' });
  if (!acct || !verifyPassword(password, acct.pass)) {
    return j(401, { ok: false, error: 'bad-credentials' });
  }
  // Promote to admin on login if ADMIN_EMAILS changed since signup — the role
  // flag in the account record is the durable source of truth afterwards.
  if (acct.role !== 'admin' && adminEmails().includes(email)) {
    acct.role = 'admin';
    await st.setJSON(`acct:${email}`, acct);
  }
  const ws = await ensureWorkspace(st, acct);
  const token = await issueSession(st, acct);
  return j(200, {
    ok: true, token,
    coach: publicCoach(acct),
    workspace: publicWs(ws),
    access: accessOf(acct)
  });
}

/** Legacy import helper shared by claim flows: copy old anonymous bytes. */
export async function importLegacy(st, legacy, ws) {
  if (!legacy || !legacy.data || ws.__imported) return false;
  await st.setJSON(`ws-meta:${ws.id}`, {
    rev: legacy.rev || 0, data: legacy.data,
    owner: ws.owner, code: ws.code, updatedAt: Date.now()
  });
  return true;
}
