// CoachMint — Phase 1 Workspace Data API (tenant-isolated).
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
import { readJsonCapped, tooLarge, badJson, secure, withLock } from '../lib/guard.mjs';

/* Workspace payload cap (default 5 MB — hundreds of clients with workouts,
   notes and measurements fit comfortably). Override with DATA_MAX_BYTES. */
const DATA_MAX_BYTES = Number(process.env.DATA_MAX_BYTES) || 5_000_000;

/* Minimal payload shape validation. The workspace blob is stored verbatim and
   countSeats() reads data.CLIENTS — a malformed payload (CLIENTS:"x") used to
   silently count 0 seats and BYPASS the plan quota. Array-typed fields must be
   arrays, DB must be a plain object, and every client needs an id (the whole
   merge/tenant model keys on it). */
const ARRAY_FIELDS = ['CLIENTS', 'EVENTS', 'MSGS', 'NOTES', 'TEMPLATES', 'FILES', 'BUILDER',
  'NPLANS', 'MTPL', 'PTPL', 'NHIST', 'ACTIVITY', 'NOTIFS', 'FOODS', 'PACKS', 'MSGTPL', 'CEXS', 'FORMS'];
function validatePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'bad-payload';
  for (const k of ARRAY_FIELDS) {
    if (data[k] !== undefined && !Array.isArray(data[k])) return 'bad-payload';
  }
  if (data.DB !== undefined && (typeof data.DB !== 'object' || data.DB === null || Array.isArray(data.DB))) return 'bad-payload';
  if (Array.isArray(data.CLIENTS) && data.CLIENTS.some((c) => !c || typeof c !== 'object' || c.id == null)) return 'bad-payload';
  return null;
}

/* The workspace OWNER's account — quota/subscription are properties of the
   workspace's owner, not of whoever happens to hold a Bearer token (students
   sync anonymously by design). */
async function ownerAccount(st, ws) {
  if (!ws || !ws.owner) return null;
  const id = String(ws.owner).replace(/^coach:/, '');
  try {
    const ptr = await st.get(`acct-by-id:${id}`, { type: 'json' });
    if (ptr && ptr.email) return await st.get(`acct:${ptr.email}`, { type: 'json' });
  } catch {}
  return null;
}

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
  /* Cheap poll: ?rev=N returns {unchanged:true} (no payload) when the caller
     already has the current revision — cuts ~95% of polling bandwidth at
     hundreds of connected coaches/clients. */
  const want = Number(new URL(req.url).searchParams.get('rev')) || 0;
  if (ws) {
    const m = await metaOf(st, ws);
    const rev = (m && m.rev) || 0;
    if (want && rev === want) return j(200, { ok: true, rev, unchanged: true });
    const coach = await coachOf(st, req);
    return j(200, {
      ok: true, rev, data: (m && m.data) || null,
      exists: true, owned: !!ws.owner,
      mine: !!(coach && ws.owner && ws.owner === ownerOf(coach))
    });
  }
  if (want && (legacy.rev || 0) === want) return j(200, { ok: true, rev: legacy.rev || 0, unchanged: true });
  return j(200, { ok: true, rev: legacy.rev || 0, data: legacy.data || null, exists: true, owned: false, mine: false, legacy: true });
}

async function handlePut(st, req, code) {
  // Serialize all writes per workspace code. The rev comparison below is
  // optimistic concurrency — two concurrent PUTs carrying the same rev must
  // not BOTH pass the check (lost update), and two racing "create" paths
  // must not both build a workspace for one code. The per-code lock gives
  // both guarantees within an instance (multi-instance deployments still
  // rely on the KV store's last-write-wins semantics).
  return withLock(`data:${code}`, () => handlePutLocked(st, req, code));
}

async function handlePutLocked(st, req, code) {
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, DATA_MAX_BYTES);
  if (big) return tooLarge(DATA_MAX_BYTES);
  if (bad) return badJson();
  const data = body && body.data;
  if (!data || typeof data !== 'object') return j(400, { ok: false, error: 'missing data' });
  const shapeErr = validatePayload(data);
  if (shapeErr) return j(400, { ok: false, error: shapeErr });
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
    // Phase-2 server quota — enforced against the WORKSPACE OWNER's plan for
    // EVERY writer. It used to run only for authenticated PUTs, so a student
    // device holding just the code could push a payload past the plan cap
    // (or keep growing a suspended coach's workspace). Shrinking is always
    // allowed: an expired/suspended coach can still archive clients.
    const ownerAcc = await ownerAccount(st, ws);
    if (ownerAcc) {
      const access = accessOf(ownerAcc);
      const incoming = countSeats(data);
      const current = await metaOf(st, ws).then((m) => countSeats(m && m.data));
      if (access.status === 'expired' || access.status === 'suspended') {
        if (incoming >= current) {
          return j(402, { ok: false, error: access.status === 'suspended' ? 'sub-suspended' : 'sub-expired' });
        }
      }
      const plan = planOf(ownerAcc);
      if (incoming > plan.maxClients && incoming >= current) {
        return j(402, { ok: false, error: 'quota-exceeded', max: plan.maxClients, used: incoming });
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
  if (req.method === 'GET') return secure(handleGet(st, req, code));
  if (req.method === 'PUT') return secure(handlePut(st, req, code));
  return j(405, { ok: false, error: 'method not allowed' });
};

export const config = { path: '/api/data' };
