# Coach OS — Self-hosting & Portability Guide

The backend is **not locked to Netlify**. The business logic lives in
`netlify/lib/*.mjs` (pure Node, only `node:crypto`), the four HTTP handlers
(`auth`, `billing`, `data`, `health`) use standard Web `Request`/`Response`,
and the KV layer picks its storage from environment variables:

| Priority | Condition | Backend | Use case |
|---|---|---|---|
| 1 | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` set | **Supabase Postgres** | production, multi-instance |
| 2 | `KV_FILE` set | **JSON file on disk** | single VPS / Docker / home server |
| 3 | neither | **Netlify Blobs** | Netlify hosting only |

`GET /api/health` always reports which backend is live.

---

## Option A — Any server with Node 18+ (VPS, Docker, Railway, Render, …)

```bash
npm install            # only needed for the optional Netlify-Blobs path
npm start              # = node server.mjs  →  http://localhost:8888
```

That's it. The standalone server (`server.mjs`, zero dependencies) serves the
static app **and** the API. Default KV is a JSON file:

```bash
KV_FILE=./data/kv.json PORT=3000 node server.mjs
```

Point Supabase instead (recommended for real deployments):

```bash
SUPABASE_URL=https://xyz.supabase.co \
SUPABASE_SERVICE_KEY=eyJ... \
node server.mjs
```

(One-time: run `supabase/schema.sql` in the Supabase SQL editor — see
`supabase/README.md`.)

### Keep it running (systemd)

```ini
# /etc/systemd/system/coachos.service
[Unit]
Description=Coach OS
After=network.target

[Service]
WorkingDirectory=/opt/coach-os
Environment=KV_FILE=/opt/coach-os/data/kv.json
Environment=PORT=8888
ExecStart=/usr/bin/node server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now coachos
```

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV KV_FILE=/app/data/kv.json PORT=8888
EXPOSE 8888
CMD ["node", "server.mjs"]
```

```bash
docker build -t coach-os .
docker run -p 8888:8888 -v coachos-data:/app/data coach-os
```

### Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl;
  server_name coach.example.com;
  location / { proxy_pass http://127.0.0.1:8888; proxy_set_header Host $host; }
}
```

---

## Option B — Vercel

The handlers already use standard Web `Request`/`Response`. Create
`api/[...path].js`:

```js
import authFn from '../netlify/functions/auth.mjs';
import billingFn from '../netlify/functions/billing.mjs';
import dataFn from '../netlify/functions/data.mjs';
import healthFn from '../netlify/functions/health.mjs';

const routes = [
  [/^\/api\/auth\//, authFn],
  [/^\/api\/billing\//, billingFn],
  [/^\/api\/data$/, dataFn],
  [/^\/api\/health$/, healthFn]
];

export default async function handler(req) {
  const url = new URL(req.url);
  for (const [re, fn] of routes) if (re.test(url.pathname)) return fn(req);
  return new Response('not found', { status: 404 });
}
export const config = { runtime: 'nodejs' };
```

Set `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` in project settings (Blobs is not
available there, so Supabase or a file store is required).

---

## Option C — Stay on Netlify

Unchanged: `netlify dev` locally, or push/deploy as before. Everything in this
guide is additive — the Netlify path keeps working.

---

## Migrating data between backends

- **Blobs → Supabase**: `npm run migrate:dry` then `npm run migrate`
  (see `supabase/README.md`).
- **File → Supabase**: the file is one JSON object keyed by
  `<namespace>:<key>`; a small script can POST each entry to
  `${SUPABASE_URL}/rest/v1/kv_store` with the service key.
- **Supabase → File**: same mapping in reverse — SELECT all rows of
  `kv_store`, strip the key prefix, write the JSON file.

## Notes & limits

- The **file backend** is for single-instance servers. For multiple
  replicas/instances use Supabase (or any shared store).
- Passwords are hashed with PBKDF2-SHA256 (120k iterations) — CPU-heavy by
  design. Fine on VPS/Node; avoid free-tier edge runtimes with tight CPU caps
  (e.g. Cloudflare Workers free plan).
- `server.mjs` guards against path traversal and mirrors the cache headers
  from `netlify.toml`.

## Built-in hardening (Phase 3)

| Protection | Where | Detail |
|---|---|---|
| Rate limiting | `netlify/lib/guard.mjs` | login 10/min · signup 5/min · forgot 3/10min · reset 10/10min · billing POSTs 20/min — per IP, fixed window, `429 + Retry-After` |
| Body size caps | all POST/PUT handlers | auth 10 KB · billing 64 KB · workspace data 5 MB (`DATA_MAX_BYTES`) — `413` over the cap |
| Security headers | handlers + `netlify.toml` + `server.mjs` | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `HSTS`, CSP on HTML |
| Password reset | `/api/auth/forgot` + `/api/auth/reset` | 1-hour single-use token; **revokes all sessions** of the coach on success |

### Password reset delivery

| Env | Behavior |
|---|---|
| `RESEND_API_KEY=re_…` | real email via Resend (zero-dependency HTTP API) |
| `RESET_DELIVERY=return` | link returned in the API response — **self-host/dev only** |
| neither | link printed to the server console |

The reset UI is built in: “Forgot password?” opens a dialog, and opening the
app with `#reset=<token>` shows the new-password form.

## Admin controls & the external shop site

### What the platform admin can do (Settings → Admin)

| Action | Endpoint | Effect |
|---|---|---|
| See all coaches | `GET /api/billing/admin-overview` | plan, **days remaining** (with color bar), seats used/max, status |
| Grant / extend a subscription | `POST /api/billing/admin-grant` `{email, planId, days}` | days **stack** on remaining time; also un-suspends |
| Suspend / restore access | `POST /api/billing/admin-suspend` `{email, suspended}` | suspended coach becomes read-only (data intact, `402` on writes) |
| Create a coupon manually | `POST /api/billing/coupon` (admin session) | code, plan, duration, max uses |

Admins are the emails in `ADMIN_EMAILS` (auto-promoted on login).

### Connecting the separate marketing/shop site

Recommended flow — **coupons** (no shared database, works before the buyer
even registers):

```
Shop site                          Coach OS
─────────                          ────────
1. customer pays (ZarinPal/…)
2. POST /api/billing/issue-coupon
   header: x-api-key: ADMIN_API_KEY
   body: {planId, durationDays, maxUses, count}
                                →  returns {coupons:["PRO-XXXXXXXXXX", …]}
3. show / email the code to the customer
4. customer signs up in Coach OS,
   enters the code in Settings → Account → Coupon
                                →  POST /api/billing/redeem activates the plan
```

Example (from the shop backend):

```bash
curl -X POST https://app.coachos.example/api/billing/issue-coupon \
  -H "x-api-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{"planId":"professional","durationDays":30,"maxUses":1,"count":1}'
```

- Generate the key: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
- Set it as `ADMIN_API_KEY` on the Coach OS deployment; share it only with
  the shop backend (never the browser).
- Leave `ADMIN_API_KEY` empty to disable the shop endpoint entirely.
- Rate limited (20 POSTs/min/IP) like every billing route; codes are
  prefixed with the plan (`PRO-…`, `BAS-…`, `CLU-…`) for easy triage.

Alternative (direct grant): if the buyer already has a Coach OS account and
the shop knows their email, the shop backend can call `admin-grant` with an
admin session instead — but the coupon flow avoids sharing credentials.

### Point the in-app buy buttons at the shop

In `index.html` set:

```js
const SHOP_URL='https://shop.coachos.example';
```

The plan buttons in Settings → Account become **Buy** buttons that open
`SHOP_URL?plan=professional` (plan preselected via query param). The shop
reads `?plan=`, takes payment, issues the coupon, and tells the customer to
paste it in the app. Leave `SHOP_URL=''` to keep the legacy manual flow
(in-app request + tracking code).

### Shop integration checklist

1. Generate `ADMIN_API_KEY` (24+ random bytes) and set it on the Coach OS
   deployment — never in browser code.
2. Shop backend: after the payment gateway confirms, call `issue-coupon` with
   `{planId, durationDays, maxUses:1, count:1}` and store the returned code
   with the order (retry-safe: pass your own `code` derived from the order id
   to make retries idempotent — duplicates return `409 code-exists`).
3. Deliver the code on-screen + by email.
4. Customer redeems in the app; the plan activates instantly.
5. Optional: reconcile daily — `admin-overview` shows every coach's plan and
   days remaining, so mismatches are easy to spot.
