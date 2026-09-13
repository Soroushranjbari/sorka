// Coach OS — Phase 1 Workspace Data API (tenant-isolated).
//   GET /api/data?code=XXXX            -> {ok, rev, data|null, exists, owned, mine, legacy?}
//   PUT /api/data?code=XXXX {rev,data} -> {ok, rev, mine}
// Auth OPTIONAL (Bearer coach-token): students sync by code alone, but only
// for workspaces that already exist; anonymous creation is rejected (403).
// A coach token auto-binds an anonymous workspace on first authenticated
// write; a different coach can never write a foreign workspace (403).
import {
  store, legacyBlobs, j, normCode, bearerOf, sessionOf, accountById,
  ownerOf, accessOf, CODE_RE, newId
} from '../lib/saas.mjs';
import { planOf, countSeats } from '../lib/billing.mjs';

const legacyStore = () => legacyBlobs();

async function resolveWs(st, code) {
  try {
    const ptr = await st.get(`ws-by-code:${code}`, { type: 'json' });
    if (ptr && ptr.wid) {
      const ws = await st.get(`ws:${ptr.wid}`, { type: 'json' });
      if (ws) return { ws };
    }
  } catch {}
  try {
    const leg = await legacyStore().get(code, { type: 'json' });
    if (leg) return { ws: null, legacy: leg };
  } catch {}
  return { ws: null, legacy: null };
}

async function coachOf(st, req) {
  try {
    const s = await sessionOf(st, bearerOf(req));
    if (!s) return null;
    return (await accountById(st, s.coachId)) || null;
  } catch { return null }
}

async function metaOf(st, ws) {
  try { return (await st.get(`ws-meta:${ws.id}`, { type: 'json' })) || null; }
  catch { return null }
}

async function handleGet(st, req, code) {
  const { ws, legacy } = await resolveWs(st, code);
  if (!ws && !legacy) {
    return j(200, { ok: true, rev: 0, data: null, exists: false, owned: false, mine: false });
  }
  if (ws) {
    const m = await metaOf(st, ws);
    const coach = await coachOf(st, req);
    return j(200, {
      ok: true, rev: (m && m.rev) || 0, data: (m && m.data) || null,
      exists: true, owned: !!ws.owner,
      mine: !!(coach && ws.owner && ws.owner === ownerOf(coach))
    });
  }
  return j(200, { ok: true, rev: legacy.rev || 0, data: legacy.data || null, exists: true, owned: false, mine: false, legacy: true });
}

async function handlePut(st, req, code) {
  let body;
  try { body = await req.json(); } catch { return j(400, { ok: false, error: 'bad json' }); }
  const data = body && body.data;
  if (!data || typeof data !== 'object') return j(400, { ok: false, error: 'missing data' });
  const want = Number(body.rev) || 0;
  const coach = await coachOf(st, req);
  const now = Date.now();
  const found = await resolveWs(st, code);
  let ws = found.ws || null;
  const legacy = found.legacy || null;

  // Case 1: brand-new code — only an authenticated coach may create it.
  if (!ws && !legacy) {
    if (!coach) return j(403, { ok: false, error: 'not-claimed' });
    ws = { id: newId('ws'), owner: ownerOf(coach), code, plan: coach.plan || 'trial',
      status: 'trial', createdAt: now, claimedAt: now };
    await st.setJSON(`ws:${ws.id}`, ws);
    await st.setJSON(`ws-by-code:${code}`, { wid: ws.id });
    if (!coach.workspaceId) {
      coach.workspaceId = ws.id;
      await st.setJSON(`acct:${coach.email}`, coach);
    }
    await st.setJSON(`ws-meta:${ws.id}`, { rev: now, data, owner: ws.owner, code, updatedAt: now });
    return j(200, { ok: true, rev: now, mine: true });
  }

  // Case 2: managed workspace (code pointer exists).
  if (ws) {
    if (ws.owner && coach && ws.owner !== ownerOf(coach)) {
      return j(403, { ok: false, error: 'foreign' });
    }
    // Phase-2 server quota: count seats in the INCOMING payload (client could
    // have added clients offline); anonymous student writes bypass the coach
    // seat check but expired coaches are read-only (except deletions/shrinks).
    if (coach) {
      const acc = await accountById(st, coach.id);
      if (acc) {
        const access = accessOf(acc);
        const incoming = countSeats(data);
        const current = await metaOf(st, ws).then((m) => countSeats(m && m.data));
        if (access.status === 'expired' || access.status === 'suspended') {
          if (incoming >= current) {
            return j(402, { ok: false, error: access.status === 'suspended' ? 'sub-suspended' : 'sub-expired' });
          }
        }
        const plan = planOf(acc);
        if (incoming > plan.maxClients && incoming >= current) {
          return j(402, { ok: false, error: 'quota-exceeded', max: plan.maxClients, used: incoming });
        }
      }
    }
    const cur = await metaOf(st, ws);
    const curRev = (cur && cur.rev) || 0;
    if (want !== curRev) return j(409, { ok: false, rev: curRev });
    if (coach && !ws.owner) {
      ws.owner = ownerOf(coach);
      ws.claimedAt = now;
      await st.setJSON(`ws:${ws.id}`, ws);
      if (!coach.workspaceId) {
        coach.workspaceId = ws.id;
        await st.setJSON(`acct:${coach.email}`, coach);
      }
    }
    const rev = Date.now();
    await st.setJSON(`ws-meta:${ws.id}`, { rev, data, owner: ws.owner || null, code, updatedAt: rev });
    return j(200, { ok: true, rev, mine: !!(coach && ws.owner && ws.owner === ownerOf(coach)) });
  }

  // Case 3: legacy-only blob (pre-Phase-1 code, never claimed).
  if (coach) {
    ws = { id: newId('ws'), owner: ownerOf(coach), code, plan: coach.plan || 'trial',
      status: 'trial', createdAt: now, claimedAt: now };
    await st.setJSON(`ws:${ws.id}`, ws);
    await st.setJSON(`ws-by-code:${code}`, { wid: ws.id });
    if (!coach.workspaceId) {
      coach.workspaceId = ws.id;
      await st.setJSON(`acct:${coach.email}`, coach);
    }
    const rev = Date.now();
    await st.setJSON(`ws-meta:${ws.id}`, { rev, data, owner: ws.owner, code, updatedAt: rev });
    return j(200, { ok: true, rev, mine: true, imported: true });
  }
  // Anonymous student sync to a legacy code (backward compatible).
  const curRev = (legacy && legacy.rev) || 0;
  if (want !== curRev) return j(409, { ok: false, rev: curRev });
  const rev = Date.now();
  await legacyStore().setJSON(code, { rev, data });
  return j(200, { ok: true, rev });
}

export default async (req) => {
  const st = store();
  const url = new URL(req.url);
  const code = normCode(url.searchParams.get('code'));
  if (!CODE_RE.test(code)) return j(400, { ok: false, error: 'bad code' });
  if (req.method === 'GET') return handleGet(st, req, code);
  if (req.method === 'PUT') return handlePut(st, req, code);
  return j(405, { ok: false, error: 'method not allowed' });
};

export const config = { path: '/api/data' };
