# SELF-HOSTING — Coach OS on your own server

The backend is plain Node (18+). Business logic lives in `backend/lib/*.mjs`
(pure Node, only `node:crypto` + `better-sqlite3`), the HTTP handlers in
`backend/handlers/*.mjs` (standard Web Request/Response), and `server.mjs`
serves both the static app and the API with zero frameworks.

## Quick start

```bash
npm install
npm start                      # http://localhost:8888
```

Storage is **SQLite** by default: one file at `data/sqlite.db` (table `kv`,
WAL journal). Override with `SQLITE_PATH=/path/db.sqlite`. For multi-instance
setups set `DATABASE_URL=postgres://...` instead — the `kv_store` table is
auto-created on first use.

Create the main admin:

```bash
node ./scripts/create-admin.mjs admin@example.com 'S3cure!Pass' 'Name'
```

Migrate an old KV JSON dump into SQLite (once):

```bash
npm run db:migrate
```

## Environment

`.env` is auto-loaded by `server.mjs` (see `backend/lib/env.mjs`). Real
environment variables always win over the file.

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | listen address (default 8888 / 0.0.0.0) |
| `SQLITE_PATH` | SQLite file location (default `./data/sqlite.db`) |
| `DATABASE_URL` | optional PostgreSQL instead of SQLite |
| `ADMIN_EMAILS` | emails promoted to admin on login |
| `ADMIN_API_KEY` | shop → issue-coupon server-to-server key |
| `COACH_OS_URL` | public app URL (shop checkout needs it) |
| `AI_API_KEY` | optional OpenRouter key for the AI assistant |
| `RESEND_API_KEY` | optional password-reset email delivery |

## Production notes

- Run behind nginx/Caddy with HTTPS (cookies are `Secure` in production).
- Back up `data/sqlite.db` (plus `-wal`/`-shm` while the server runs) — it is
  the entire database.
- `npm run check:deploy` validates configuration before start.
- `npm test` runs the full suite (102 tests) against a temp SQLite database.

## Same handlers, other platforms

`backend/handlers/*.mjs` are standard `Request → Response` functions:

- **Vercel**: `api/[...path].mjs` adapts Node req/res → Web Request (see DEPLOY.md).
- **Any Node host**: `server.mjs` (this document).
