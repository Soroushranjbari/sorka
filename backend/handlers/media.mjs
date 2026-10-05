// CoachMint — media blobs (v18.103).
//
// Voice notes (and other binaries) used to live INSIDE the workspace payload as
// base64, sharing the same 5 MB cap as every workout, plan, note and photo.
// A single 15 s voice note (VMAX) is ~120 KB of audio ≈ 160 KB of base64 — about
// 30 of them would blow the whole sync and the device would retry a 413 forever.
//
//   POST   /api/media?code=XXXX  {data:'data:audio/...;base64,...'}
//                                 -> {ok, id, url, mime, n}
//   GET    /api/media/<id>?code=XXXX -> the raw bytes (immutable cache)
//   DELETE /api/media/<id>?code=XXXX -> {ok}  (own blob only)
//
// Storage is the SAME portable KV as everything else (SQLite by default,
// Postgres with DATABASE_URL). The filesystem was never an option on the two
// deploy targets: Vercel's deploy dir is read-only (only /tmp, per-request) and
// Render Free's disk is ephemeral — a restart wipes it.
//
// GET is a capability URL: `<audio>` and `<img>` cannot send an Authorization
// header, so the workspace code rides in the query string and must match the
// blob's owner — exactly the trust model /api/data already uses.
//
// CSP: `connect-src 'self'` + `media-src 'self' blob:` already allow every call
// here, so no security header has to change.
import { store, j, newId, normCode, CODE_RE } from '../lib/saas.mjs';
import { readJsonCapped, tooLarge, badJson, rateLimit, ipOf, tooMany, secure } from '../lib/guard.mjs';
import { kvDown } from '../lib/db.mjs';

/* A 15 s opus note at 64 kbps ≈ 120 KB raw ≈ 160 KB base64, so 2 MB a file is
   ~12× the longest note this app will ever record. MEDIA_WS_MAX is the whole
   workspace's slice of media (200 MB ≈ 1 200 voice notes). */
const FILE_MAX = Number(process.env.MEDIA_FILE_MAX) || 2_000_000;
const WS_MAX = Number(process.env.MEDIA_WS_MAX) || 200_000_000;
/* Only real media data-URLs — never a remote URL (SSRF) and never a bare blob
   (not persistable). Mirrors the photo rule in backend/handlers/ai.mjs. */
const DATA_RE = /^data:(audio|image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
/* The index is capped so one very chatty workspace cannot grow a single row
   without bound; the BYTE total is kept separately and is never trimmed. */
const IDX_KEEP = 4000;

const blobKey = (id) => `media:${id}`;
const idxKey = (code) => `media-idx:${code}`;

async function quotaOf(st, code) {
  const rec = (await st.get(idxKey(code))) || {};
  return { bytes: +rec.bytes || 0, list: Array.isArray(rec.list) ? rec.list : [] };
}

async function upload(st, req, code) {
  const lim = rateLimit(`media:${ipOf(req)}`, 60, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, FILE_MAX + 8192);
  if (big) return tooLarge(FILE_MAX + 8192);
  if (bad) return badJson();
  const src = String((body && body.data) || '');
  if (!DATA_RE.test(src)) return j(400, { ok: false, error: 'bad-media' });
  /* base64 → bytes: 4 chars per 3 bytes, minus the data: prefix and padding. */
  const b64 = src.slice(src.indexOf(',') + 1);
  const n = Math.max(0, Math.round((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
  if (n > FILE_MAX) return j(413, { ok: false, error: 'file-too-large', max: FILE_MAX });
  const q = await quotaOf(st, code);
  if (q.bytes + n > WS_MAX) return j(413, { ok: false, error: 'quota', max: WS_MAX, used: q.bytes });

  const id = newId('m');
  const mime = src.slice(5, src.indexOf(';')); // data:<mime>;base64
  await st.setJSON(blobKey(id), { code, mime, n, b64: src, at: Date.now() });
  q.list.push({ id, n });
  await st.setJSON(idxKey(code), { bytes: q.bytes + n, list: q.list.slice(-IDX_KEEP) });
  return j(200, { ok: true, id, url: `/api/media/${id}?code=${code}`, mime, n });
}

async function download(st, id, code) {
  const rec = (await st.get(blobKey(id))) || null;
  if (!rec || rec.code !== code || !rec.b64) return j(404, { ok: false, error: 'not-found' });
  const buf = Buffer.from(String(rec.b64).slice(String(rec.b64).indexOf(',') + 1), 'base64');
  return secure(new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'content-type': rec.mime || 'application/octet-stream',
      'content-length': String(buf.length),
      /* ids are unique per blob — the bytes never change under an id. */
      'cache-control': 'private, max-age=31536000, immutable'
    }
  }));
}

async function remove(st, id, code) {
  const rec = (await st.get(blobKey(id))) || null;
  if (!rec || rec.code !== code) return j(404, { ok: false, error: 'not-found' });
  await st.delete(blobKey(id));
  const q = await quotaOf(st, code);
  const keep = q.list.filter((m) => m && m.id !== id);
  await st.setJSON(idxKey(code), { bytes: Math.max(0, q.bytes - (+rec.n || 0)), list: keep });
  return j(200, { ok: true });
}

export default async (req) => {
  const st = store();
  const url = new URL(req.url);
  const code = normCode(url.searchParams.get('code'));
  if (!CODE_RE.test(code)) return j(400, { ok: false, error: 'bad code' });
  /* v18.107 — storage down: a 503 here makes moveMedia() keep the inline data:
     copy instead of storing a URL that would 404 on GET. */
  if (kvDown()) return j(503, { ok: false, error: 'storage-unavailable' });
  const segs = url.pathname.split('/').filter(Boolean); // ['api','media',id?]
  const id = String(segs[2] || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (req.method === 'POST' && !id) return secure(await upload(st, req, code));
  if (req.method === 'GET' && id) return await download(st, id, code);
  if (req.method === 'DELETE' && id) return secure(await remove(st, id, code));
  return j(405, { ok: false, error: 'method not allowed' });
};

export const config = { path: '/api/media' };
