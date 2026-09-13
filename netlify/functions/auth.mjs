// Coach OS — Phase 1 Auth API: me/logout/claim + router.
import {
  store, j, normCode, bearerOf, readJson,
  sessionOf, accountById, accessOf, ownerOf,
  CODE_RE, newId
} from '../lib/saas.mjs';
import { signup, login, publicWs, importLegacy } from '../lib/auth-shared.mjs';
import { legacyBlobs } from '../lib/saas.mjs';

const legacyStore = () => legacyBlobs();

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

async function claim(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (acct.workspaceId) {
    const w = await st.get(`ws:${acct.workspaceId}`, { type: 'json' });
    return j(200, { ok: true, workspace: publicWs(w), note: 'already-owned' });
  }
  const body = await readJson(req);
  const code = normCode(body?.legacyCode);
  if (!CODE_RE.test(code)) return j(400, { ok: false, error: 'bad-code' });
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
}

export default async (req) => {
  const st = store();
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const action = (segs[2] || '').toLowerCase();
  try {
    if (req.method === 'POST' && action === 'signup') return await signup(req, st);
    if (req.method === 'POST' && action === 'login') return await login(req, st);
    if (req.method === 'POST' && action === 'logout') return await logout(req, st);
    if (req.method === 'GET' && action === 'me') return await me(req, st);
    if (req.method === 'POST' && action === 'claim') return await claim(req, st);
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/auth/*' };
