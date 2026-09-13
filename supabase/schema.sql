-- Coach OS — Supabase / PostgreSQL schema (Phase 1.5 migration)
-- Run this in Supabase Dashboard > SQL Editor (or psql) once.
--
-- Design:
--   kv_store        : drop-in replacement for Netlify Blobs key-value layout.
--                     Phase-1 code keeps working unchanged, but bytes now live
--                     in Postgres (portable, queryable, backed-up).
--   Normalized tables (coaches/sessions/workspaces/workspace_data) are created
--   now so Phase-2 (quotas, payments, admin panel) can migrate row by row
--   without another schema deploy.

-- ============ 1) KV store (active backend) ============
create table if not exists public.kv_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists kv_store_updated_at_idx on public.kv_store (updated_at);

-- Functions use the SERVICE ROLE key (bypasses RLS). Anon key gets nothing.
alter table public.kv_store enable row level security;

-- ============ 2) Normalized SaaS tables (Phase-2 ready) ============
create table if not exists public.coaches (
  id text primary key,
  email text unique not null,
  name text not null default '',
  pass_salt text not null default '',
  pass_hash text not null default '',
  plan text not null default 'trial',
  workspace_id text null,
  trial_ends_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists coaches_email_idx on public.coaches (lower(email));

create table if not exists public.sessions (
  token text primary key,
  coach_id text not null references public.coaches (id) on delete cascade,
  email text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_coach_idx on public.sessions (coach_id);
create index if not exists sessions_expires_idx on public.sessions (expires_at);

create table if not exists public.workspaces (
  id text primary key,
  code text unique not null,
  owner_coach_id text null references public.coaches (id) on delete set null,
  plan text not null default 'trial',
  status text not null default 'trial',
  created_at timestamptz not null default now(),
  claimed_at timestamptz null
);
create index if not exists workspaces_code_idx on public.workspaces (code);
create index if not exists workspaces_owner_idx on public.workspaces (owner_coach_id);

create table if not exists public.workspace_data (
  workspace_id text primary key references public.workspaces (id) on delete cascade,
  rev bigint not null default 0,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.coaches enable row level security;
alter table public.sessions enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_data enable row level security;

-- ============ 3) Optional: view for admin (Phase-4) ============
create or replace view public.v_coach_overview as
select c.id, c.email, c.name, c.plan, c.created_at, c.trial_ends_at,
       w.code as workspace_code, w.status as workspace_status,
       d.rev as data_rev, d.updated_at as data_updated_at
from public.coaches c
left join public.workspaces w on w.id = c.workspace_id
left join public.workspace_data d on d.workspace_id = w.id;
