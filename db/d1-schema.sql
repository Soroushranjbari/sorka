-- FormaDock / CoachMint — Cloudflare D1 Schema
-- Run manually if desired:
--   npx wrangler d1 execute formadock-db --remote --file=db/d1-schema.sql
-- (Also auto-created lazily on first Worker request by backend/lib/db.mjs.)

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
