// CoachMint — request guard: rate limiting, body caps, security headers.
// Pure functions over standard Web Request/Response — works on Netlify,
// Vercel, the standalone server, anywhere. Zero dependencies.
//
// Rate limiting is in-memory (per instance). Fine for single-instance
// deployments; behind a multi-instance load balancer each instance enforces
// its own window (still raises the bar substantially). For strict global
// limits, front the API with a proxy that rate-limits (nginx, Cloudflare…).

const buckets = new Map(); // key -> { count, resetAt }
let lastSweep = Date.now();

/**
 * Fixed-window rate limiter.
 * @returns {ok:boolean, retryAfter:number, remaining:number}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (now - lastSweep > 60_000 || buckets.size > 10_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
  }
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return {
    ok: b.count <= limit,
    retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    remaining: Math.max(0, limit - b.count)
  };
}

/* ---------- Per-key async mutex ----------
   Serializes critical read-modify-write sections (coupon redemption, account
   creation, workspace claiming, data PUTs) within one process. Without it,
   two concurrent requests can both read the same counter/revision before
   either write lands (check-then-act race): e.g. a multi-use coupon redeemed
   twice by racing requests, or two PUTs with the same rev both passing the
   optimistic-concurrency check. Like the rate limiter above this is
   per-instance; multi-instance deployments get the same guarantee only within
   each instance (a DB-level lock would be needed for global serialization).
   Lock ordering: callers may nest locks only in a consistent order
   (coupon → account); no code path acquires them in the opposite order. */
const locks = new Map(); // key -> tail promise of the wait chain

export async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((res) => { release = res; });
  const tail = prev.then(() => gate);
  locks.set(key, tail);
  await prev; // wait for every prior holder of this key
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry when nobody queued behind us, so the map stays small.
    queueMicrotask(() => { if (locks.get(key) === tail) locks.delete(key); });
  }
}

/** Best-effort client IP (proxy headers first, as on Netlify/Vercel/nginx). */
export function ipOf(req) {
  const h = req.headers || new Headers();
  const xff = (h.get('x-forwarded-for') || '').split(',')[0].trim();
  return xff || h.get('x-real-ip') || h.get('cf-connecting-ip') || 'local';
}

/** Request origin (proto-aware behind proxies). */
export function originOf(req) {
  const h = req.headers || new Headers();
  const host = h.get('host') || 'localhost';
  const proto = h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * Read the request body with a hard size cap.
 * @returns {body:string|null, tooLarge:boolean}
 */
export async function readBody(req, maxBytes = 1_000_000) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) return { body: null, tooLarge: true };
  if (!req.body) return { body: null, tooLarge: false };
  const reader = req.body.getReader();
  if (!reader) return { body: null, tooLarge: false };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value ? value.length : 0;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      return { body: null, tooLarge: true };
    }
    if (value) chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return { body: new TextDecoder().decode(buf), tooLarge: false };
}

/** Parse a capped JSON body. @returns {data:object|null, tooLarge:boolean, bad:boolean} */
export async function readJsonCapped(req, maxBytes = 1_000_000) {
  const { body, tooLarge } = await readBody(req, maxBytes);
  if (tooLarge) return { data: null, tooLarge: true, bad: false };
  if (body == null) return { data: null, tooLarge: false, bad: false };
  try { return { data: JSON.parse(body), tooLarge: false, bad: false }; }
  catch { return { data: null, tooLarge: false, bad: true }; }
}

/** 429 response with Retry-After. */
export const tooMany = (retryAfter) =>
  new Response(JSON.stringify({ ok: false, error: 'rate-limited', retryAfter }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(retryAfter) }
  });

/** 413 response. */
export const tooLarge = (maxBytes) =>
  new Response(JSON.stringify({ ok: false, error: 'payload-too-large', maxBytes }), {
    status: 413,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

/** 400 response for malformed JSON. */
export const badJson = () =>
  new Response(JSON.stringify({ ok: false, error: 'bad json' }), {
    status: 400,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

/* ---------- Security headers ---------- */
// CSP: the app is a single-file UI with inline script/style, so 'unsafe-inline'
// is required for script-src/style-src; everything else is locked down.
export const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; " +
  "media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

// The shop landing page legitimately loads @fontsource CSS + three.js from
// CDNs. Applying CSP above to it silently blocked both, so it gets its own
// (still locked-down) policy. Mirrored in netlify.toml for /shop/*.
export const CSP_SHOP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
  "img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com; " +
  "media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains'
};

/** Apply security headers to a Response (mutates and returns it). */
export function secure(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    try { res.headers.set(k, v); } catch {}
  }
  return res;
}
