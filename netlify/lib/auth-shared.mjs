// Coach OS — Phase 1 Auth shared logic: signup/login + session issue.
// Bundled via relative import (netlify/lib), NOT a deployed function.
import {
  store, j, normEmail, newId, newToken,
  hashPassword, verifyPassword, readJson,
  accessOf, ownerOf,
  EMAIL_RE, TRIAL_DAYS
} from './saas.mjs';
import { adminEmails } from './billing.mjs';

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
  return token;
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
