// CoachMint — realtime chat stream (v18.108).
//
// The client used to poll /api/data every 7 s, so a message took up to 7 s to
// show up. This endpoint keeps ONE long-lived connection and tells the client
// whenever the workspace revision moves; the client then runs its normal
// cloudPull() — an O(1) read when nothing changed since v18.104 — so the frame
// itself is a few dozen bytes.
//
//   GET /api/chat/stream?code=XXXX[&tick=1500]   ->   text/event-stream
//     retry: 3000                    EventSource reconnect delay
//     data: {"rev":1712,"hello":true}   first frame
//     data: {"rev":1719}                revision moved — please pull
//     data: {"ping":1712...}            heartbeat (keeps idle proxies from cutting)
//
// Why poll a tiny key instead of broadcasting from the writer: it behaves
// identically on the single-process self-hosted server AND on Vercel, where two
// requests may land on different instances — there is no in-memory subscriber
// map to get wrong. v18.104's `ws-rev` key is exactly what makes this cheap.
//
// The client keeps its 7 s cloudPull as a safety net: if the stream dies, chat
// still works, just slower. No third-party domain, no new dependency — the CSP's
// `connect-src 'self'` already allows it.
import { store, j, normCode, CODE_RE } from '../lib/saas.mjs';
import { rateLimit, ipOf, tooMany } from '../lib/guard.mjs';
import { kvDown } from '../lib/db.mjs';

const TICK_MIN = 750;
const TICK_MAX = 10_000;
const TICK_DEF = 1500;
/* Bound every stream even if the disconnect is never observed: no interval to
   leak, and EventSource reconnects immediately afterwards. */
const STREAM_MAX_MS = 5 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function revOf(st, wsId) {
  try {
    const r = await st.get(`ws-rev:${wsId}`, { type: 'json' });
    return r && r.rev != null ? +r.rev || 0 : 0;
  } catch { return 0; }
}

export default async (req) => {
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean); // ['api','chat','stream']
  const action = String(segs[2] || '').toLowerCase();
  if (action !== 'stream') return j(404, { ok: false, error: 'not-found' });

  const code = normCode(url.searchParams.get('code'));
  if (!CODE_RE.test(code)) return j(400, { ok: false, error: 'bad code' });
  if (kvDown()) return j(503, { ok: false, error: 'storage-unavailable' });

  /* This is a CONNECTION cap, not a request rate: one tab holds one stream, so
     what we are actually limiting is a reconnect storm. */
  const lim = rateLimit(`chat-stream:${ipOf(req)}`, 30, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);

  const st = store();
  const ptr = await st.get(`ws-by-code:${code}`, { type: 'json' });
  const ws = ptr && ptr.wid ? await st.get(`ws:${ptr.wid}`, { type: 'json' }) : null;
  if (!ws) return j(404, { ok: false, error: 'workspace-not-found' });

  const tick = Math.min(TICK_MAX, Math.max(TICK_MIN, Number(url.searchParams.get('tick')) || TICK_DEF));
  let rev = await revOf(st, ws.id);
  let closed = false;
  let ctrl = null; // assigned synchronously inside start()

  const enc = new TextEncoder();
  const push = (obj) => {
    if (closed || !ctrl) return;
    try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { closed = true; }
  };
  const q = new ReadableStream({
    /* NB: start() runs INSIDE the constructor, before `q` is assigned — it must
       enqueue on its own controller, not through a helper that reads `q`. */
    start(c) {
      ctrl = c;
      c.enqueue(enc.encode('retry: 3000\n\n'));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ rev, hello: true })}\n\n`));
    },
    cancel() { closed = true; }
  });

  /* No setInterval — the loop exits on its own, so a connection nobody ever
     closes cannot leak a timer. */
  (async () => {
    const started = Date.now();
    while (!closed && Date.now() - started < STREAM_MAX_MS) {
      await sleep(tick);
      if (closed) break;
      let now;
      try { now = await revOf(st, ws.id); } catch { now = rev; }
      if (now !== rev) { rev = now; push({ rev }); }
      else push({ ping: Date.now() });
    }
    closed = true;
    try { q.close(); } catch { /* already closed */ }
  })();

  return new Response(q, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      /* Nginx/CDNs buffer by default, which would deliver events in bursts. */
      'x-accel-buffering': 'no'
    }
  });
};

/* `maxDuration` is a Vercel hint (the platform may still cut earlier on a lower
   plan); self-hosted ignores it and honours STREAM_MAX_MS instead. */
export const config = { path: '/api/chat', maxDuration: 60 };
