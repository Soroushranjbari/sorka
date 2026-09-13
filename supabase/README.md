# Coach OS — Supabase migration guide (Phase 1.5)

Goal: move server bytes from Netlify Blobs to Supabase Postgres (`kv_store`),
with zero downtime, zero data loss, and zero client changes.

## 0. What you need

- A Supabase project (free tier is enough): https://supabase.com/dashboard
- Its **Project URL** (`https://xyzcompany.supabase.co`)
- Its **service_role key** (Project Settings > API > `service_role`, NOT `anon`)

## 1. Create the schema (one time, ~1 minute)

1. Open Supabase Dashboard > your project > **SQL Editor** > New query.
2. Paste the full contents of `supabase/schema.sql` and **Run**.
3. Check: Table Editor should now show `kv_store`, `coaches`, `sessions`,
   `workspaces`, `workspace_data` (+ view `v_coach_overview`).

## 2. Point the backend at Supabase (no code deploy needed beyond this)

In Netlify Dashboard > your site > **Site settings > Environment variables**,
add:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the `service_role` key |

Then **Deploys > Trigger deploy** (env vars load at deploy time).

From that deploy on, `GET /api/health` reports:

```json
{ "ok": true, "backend": "supabase", "supabaseConfigured": true, ... }
```

Before the vars are set it reports `"backend": "blobs"`.

## 3. Copy existing data (one time, safe to re-run)

Old data still sits in Netlify Blobs. Reads already fall back to Blobs, but
copy it into Postgres so the fallback never matters:

```bash
npm run migrate:dry   # lists what WOULD be copied, copies nothing
npm run migrate       # copies coach-os-saas + coach-os-workspaces
```

Notes:
- The script only **copies** (never deletes) — Blobs stays intact as backup.
- Re-running is safe (upsert on conflict).
- Needs Blobs access: run it via `netlify dev`, or anywhere the
  `NETLIFY_*` blob credentials exist. Supabase vars must be in env.

## 4. Verify

1. `GET /api/health` -> `"backend": "supabase"`.
2. Sign up a fresh coach in the app -> row appears in `kv_store`
   (`key` like `coach-os-saas:acct:<email>`).
3. Old codes still sync (they were copied with `coach-os-saas:ws-by-code:*`).
4. Check Supabase Dashboard > Table Editor > `kv_store` row count.

## 5. Rollback (if anything looks wrong)

Delete the two env vars in Netlify and redeploy: backend returns to
`"blobs"` instantly. Supabase rows stay untouched; nothing is lost.

## 6. Cleanup (only when YOU decide, weeks later)

- Delete the legacy Blobs store `coach-os-workspaces` data (or leave it —
  it costs nothing and reads ignore it once Supabase has the key).
- The normalized tables (`coaches`, `sessions`, `workspaces`,
  `workspace_data`) are empty until Phase-2; `kv_store` is the live one.

## FAQ

**Do clients (browsers) need any change?** No. `/api/auth/*` and `/api/data`
request/response shapes are byte-identical.

**Does offline/localStorage still work?** Yes, untouched (`co-os-data` etc.).

**What about the demo/anonymous flow?** Unchanged: same rules
(anonymous read by code, no anonymous creation, coach binding on first
authenticated write).

**Postgres instead of Supabase?** Any Postgres works: the only
Supabase-specific part is the PostgREST URL shape in `netlify/lib/db.mjs`
(`<url>/rest/v1/kv_store?...`). Point `SUPABASE_URL` at your own PostgREST
(or rewrite those 3 fetch calls to `pg`) and everything else stays.

---

# Phase 2 — billing / plans / coupons (add-on, optional until you go paid)

Adds server-authoritative plans, seat quotas, coupon redemptions and a
simulated payment flow. No client schema change; the browser already talks to
`/api/billing/*`.

## 1. Add the Phase-2 tables (one time)

In Supabase Dashboard > **SQL Editor**, paste the full contents of
`supabase/schema-phase2.sql` and **Run**. This creates:

- `plans` — trial / basic / professional / club (prices in IRT, editable)
- `coupons` — one-time or multi-use activation codes
- `payments` — every transaction (manual, coupon or gateway later)

and adds `sub_status` / `sub_ends_at` / `sub_started_at` to `coaches`.

## 2. Issue your first coupons (SQL Editor)

```sql
-- 30 days Professional, single use
insert into public.coupons (code, plan_id, duration_days, max_uses, is_active)
values ('COACH-LAUNCH-PRO', 'professional', 30, 1, true)
on conflict (code) do update set plan_id = excluded.plan_id;

-- 90 days Club, 5 uses
insert into public.coupons (code, plan_id, duration_days, max_uses, is_active)
values ('CLUB-90', 'club', 90, 5, true)
on conflict (code) do update set plan_id = excluded.plan_id;
```

**Important:** redemption is currently enforced in code **through the KV layer**
(`coupon:<CODE>` rows). If you issue coupons there while `kv_store` is the live
backend, the billing function sees them. The SQL table is the durable record
/ admin surface; simplest path is to insert coupons in **both** places during
this transition (or rely on the KV row alone until Phase-3 moves this into SQL).

## 3. Enable the admin overview (optional)

In Netlify environment variables add:

| Key | Value |
|---|---|
| `ADMIN_EMAILS` | `you@example.com,other@example.com` |

Then `GET /api/billing/admin-overview` (Bearer token of one of those emails)
lists every coach with plan + access status.

## 4. The main admin account (run once)

The platform owner should **not** sign up through the public form (a stranger
could race the signup and claim the admin email). Create the main admin
directly in the backend instead:

```bash
# Supabase backend — needs env vars present
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
npm run admin:create -- admin@coachos.app 'S3cure!Pass' "Your Name"

# Netlify Blobs backend (local) — run via netlify dev instead:
netlify dev
# then in another terminal:
npm run admin:create -- admin@coachos.app 'S3cure!Pass' "Your Name"
```

The script writes the account with `role: 'admin'` and a **club/lifetime**
subscription so the owner is never quota-locked, then prints a workspace code.
Log in from the app with that email + password: the **Admin** tab (inside
Settings) shows every coach, their plan and subscription status.
Re-running is refused unless `--force`; `--force` keeps the workspace.

## 5. How quotas are enforced

- `PUT /api/data` blocks **growing** the seat count beyond the coach's plan
  (HTTP 402) and blocks any growth/shrink-neutral edit for expired
  subscriptions (read-only, deletions still allowed).
- The client surfaces the reason (`sub-expired` / `quota-exceeded`) and shows
  the upgrade UI in Settings > Account. Seats = non-archived clients.

## 6. Going live with a real gateway later

`/api/billing/request` returns a pending `payment` — that is the seam where a
ZarinPal / Stripe session would be created. On webhook success, the same
`grantSub()` grant (in `netlify/lib/billing.mjs`) is applied; nothing else in
the client needs to change.
