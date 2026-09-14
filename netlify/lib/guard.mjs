// Coach OS — request guard: rate limiting, body caps, security headers.
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
  "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
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
