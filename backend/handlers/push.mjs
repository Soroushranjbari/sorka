// CoachMint — Web Push (v18.22). Zero-dependency Web Push protocol
// implementation over Node's crypto (VAPID + aes128gcm payload encryption,
// RFC 8291 + RFC 8292). Subscriptions are stored per-account in the KV store
// and notifications are sent when the workspace changes in ways the coach or
// client should know about OUTSIDE the app (new message, smart report,
// session tomorrow).
//
//   GET  /api/push/vapid  (public)  -> { ok, publicKey }   — the VAPID public key
//   POST /api/push/subscribe (Bearer) {subscription, ua}   -> { ok }
//   POST /api/push/unsubscribe (Bearer) {endpoint}         -> { ok }
//   POST /api/push/test (Bearer)                           -> { ok } — sends a test push
//
// Env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, 65 / 32 bytes).
// Generate once with: node scripts/gen-vapid.mjs
// If unset, push is disabled and the client hides the UI (graceful).
import crypto from 'node:crypto';
import { store, j, bearerOf, sessionOf, accountById } from '../lib/saas.mjs';
import { readJsonCapped, tooLarge, badJson, rateLimit, ipOf, tooMany, secure } from '../lib/guard.mjs';

const VAPID_PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();
export const pushEnabled = () => !!(VAPID_PUBLIC && VAPID_PRIVATE);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const SUB_KEY = (id) => `push-sub:${id}`;

/* ---------- subscriptions ---------- */
async function subsOf(st, id) {
  return (await st.get(SUB_KEY(id), { type: 'json' })) || [];
}
async function saveSubs(st, id, subs) {
  await st.setJSON(SUB_KEY(id), subs.slice(-8)); // cap: 8 devices per account
}

/* ---------- RFC 8291/8292 encryption + send ---------- */
function pushSend(sub, payload) {
  if (!pushEnabled()) return { skipped: true };
  const endpoint = new URL(sub.endpoint);
  const aud = `${endpoint.protocol}//${endpoint.host}`;
  const ttl = 60 * 60 * 24; // 1 day
  const headers = vapidHeaders(aud, ttl);
  const body = encrypt(sub, JSON.stringify(payload || {}));
  headers['content-type'] = 'application/octet-stream';
  headers['content-encoding'] = 'aes128gcm';
  headers['content-length'] = String(body.length);
  headers.ttl = String(ttl);
  headers.urgency = 'normal';
  return fetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
    .then((r) => ({ status: r.status, gone: r.status === 404 || r.status === 410 }))
    .catch((e) => ({ status: 0, error: e.message }));
}

/* VAPID JWT (ES256) — RFC 8292. Node's JWK keys don't accept dsaEncoding, so
   the DER signature is converted to the raw r||s (IEEE P1365) form Web Push
   expects: each INTEGER is 0x02 len [leading zero?] value. */
function vapidHeaders(aud, ttl) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + ttl,
    sub: process.env.COACH_OS_URL || 'mailto:admin@coachmint.app'
  }));
  const signingInput = `${header}.${claims}`;
  const der = crypto.sign('sha256', Buffer.from(signingInput), { key: jwkToPem() });
  // DER → r||s (each exactly 32 bytes, left-padded; DER may carry a leading
  // 0x00 byte when the high bit is set — strip it, or left-pad when short).
  let o = 2, r = null, s = null;
  if (der[0] === 0x30) {
    o = 2;
    while (o < der.length) {
      const type = der[o], len = der[o + 1];
      if (type === 0x02) {
        let v = der.subarray(o + 2, o + 2 + len);
        while (v.length > 32 && v[0] === 0) v = v.subarray(1); // strip leading zeros
        if (!r) r = v; else { s = v; break; }
      }
      o += 2 + len;
    }
  }
  const pad = (v) => { v = v || Buffer.alloc(0); const out = Buffer.alloc(32); v.copy(out, 32 - Math.min(32, v.length)); return out; };
  const sigB64 = Buffer.concat([pad(r), pad(s)]).toString('base64url');
  return { authorization: `vapid t=${header}.${claims}.${sigB64}, k=${VAPID_PUBLIC}` };
}

let _pem = null;
function jwkToPem() {
  if (_pem) return _pem;
  const d = Buffer.from(VAPID_PRIVATE, 'base64url');
  const pub = Buffer.from(VAPID_PUBLIC, 'base64url'); // 65-byte uncompressed point
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url'), d: d.toString('base64url') };
  _pem = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return _pem;
}

/* aes128gcm content encoding — RFC 8188/8291. */
function encrypt(sub, payloadStr) {
  const salt = crypto.randomBytes(16);
  const asPrv = crypto.randomBytes(32);
  const subPub = Buffer.from(sub.keys.p256dh, 'base64url');
  const auth = Buffer.from(sub.keys.auth, 'base64url');

  // ECDH between the local ephemeral key and the client's public key.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(asPrv);
  const shared = ecdh.computeSecret(subPub);
  const asPub = ecdh.getPublicKey();

  // HKDF chain per RFC 8291 §4.2.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subPub, asPub]);
  const ikm = Buffer.from(hkdf(shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const payload = Buffer.concat([Buffer.from(payloadStr), Buffer.from([2])]); // padding delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid
  const header = Buffer.concat([salt, Buffer.from([0x00, 0x00, 0x10, 0x00]), Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([header, ct]);
}

function hkdf(ikm, salt, info, len) {
  return crypto.hkdfSync('sha256', ikm, salt, info, len);
}

/* ---------- fire to all of an account's devices ---------- */
export async function pushToAccount(st, id, payload) {
  if (!pushEnabled()) return;
  try {
    const subs = await subsOf(st, id);
    if (!subs.length) return;
    const keep = [];
    for (const sub of subs) {
      const r = await pushSend(sub, payload);
      if (!r.gone) keep.push(sub);
    }
    if (keep.length !== subs.length) await saveSubs(st, id, keep);
  } catch (e) {
    console.error('[push] send failed:', e.message);
  }
}

/* ---------- handlers ---------- */
async function vapid() {
  return j(200, { ok: true, publicKey: VAPID_PUBLIC || null, enabled: pushEnabled() });
}

async function subscribe(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 20_000);
  if (big) return tooLarge(20_000);
  if (bad) return badJson();
  const sub = body?.subscription;
  if (!sub || !/^https:\/\//.test(String(sub.endpoint || '')) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return j(400, { ok: false, error: 'bad-subscription' });
  }
  const subs = await subsOf(st, acct.id);
  const i = subs.findIndex((x) => x.endpoint === sub.endpoint);
  const rec = { endpoint: String(sub.endpoint).slice(0, 500), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 60) }, ua: String(body?.ua || '').slice(0, 120), at: Date.now() };
  if (i >= 0) subs[i] = rec; else subs.push(rec);
  await saveSubs(st, acct.id, subs);
  return j(200, { ok: true, count: subs.length });
}

async function unsubscribe(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const { data: body, bad } = await readJsonCapped(req, 5_000);
  if (bad) return badJson();
  const endpoint = String(body?.endpoint || '').slice(0, 500);
  const subs = (await subsOf(st, acct.id)).filter((x) => x.endpoint !== endpoint);
  await saveSubs(st, acct.id, subs);
  return j(200, { ok: true });
}

async function test(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (!pushEnabled()) return j(503, { ok: false, error: 'push-not-configured' });
  const subs = await subsOf(st, acct.id);
  if (!subs.length) return j(404, { ok: false, error: 'no-subscription' });
  await pushToAccount(st, acct.id, { title: 'CoachMint 🔔', body: 'Push notifications are working — you will get alerts here.', tag: 'test' });
  return j(200, { ok: true, sent: subs.length });
}

export default async (req) => {
  if (req.method === 'POST') {
    const r = rateLimit(`push:${ipOf(req)}`, 30, 60_000);
    if (!r.ok) return tooMany(r.retryAfter);
  }
  const st = store();
  const action = (new URL(req.url).pathname.split('/').filter(Boolean)[2] || '').toLowerCase();
  try {
    if (req.method === 'GET' && action === 'vapid') return secure(await vapid());
    if (req.method === 'POST' && action === 'subscribe') return secure(await subscribe(req, st));
    if (req.method === 'POST' && action === 'unsubscribe') return secure(await unsubscribe(req, st));
    if (req.method === 'POST' && action === 'test') return secure(await test(req, st));
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    console.error('[push] handler error:', e.message);
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/push/*' };
