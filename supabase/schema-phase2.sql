-- Coach OS — Phase 2 addon (idempotent): plans, quotas, coupons, payments.
-- Run AFTER supabase/schema.sql in SQL Editor. Safe to run twice.

create table if not exists public.plans (
  id text primary key,
  name text not null,
  max_clients int not null default 5,
  max_storage_mb int not null default 100,
  price_monthly numeric not null default 0,
  price_currency text not null default 'IRT',
  is_active boolean not null default true
);

insert into public.plans (id, name, max_clients, max_storage_mb, price_monthly, price_currency, is_active)
values
  ('trial',        'Trial',        5,   100,  0,      'IRT', true),
  ('basic',        'Basic',        5,   100,  290000, 'IRT', true),
  ('professional', 'Professional', 30,  2048, 790000, 'IRT', true),
  ('club',         'Club',         200, 10240, 2490000,'IRT', true)
on conflict (id) do update set
  name = excluded.name,
  max_clients = excluded.max_clients,
  max_storage_mb = excluded.max_storage_mb,
  price_monthly = excluded.price_monthly,
  price_currency = excluded.price_currency,
  is_active = excluded.is_active;

create table if not exists public.coupons (
  code text primary key,
  plan_id text not null references public.plans (id),
  duration_days int not null default 30,
  max_uses int not null default 1,
  used_count int not null default 0,
  is_active boolean not null default true,
  expires_at timestamptz null,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id text primary key,
  coach_id text not null references public.coaches (id) on delete cascade,
  plan_id text not null default 'trial',
  amount numeric not null default 0,
  currency text not null default 'IRT',
  provider text not null default 'manual',
  tracking_code text not null default '',
  status text not null default 'pending',
  coupon_code text null,
  starts_at timestamptz null,
  ends_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists payments_coach_idx on public.payments (coach_id);
create index if not exists payments_status_idx on public.payments (status);

alter table public.coaches add column if not exists sub_status text not null default 'trial';
alter table public.coaches add column if not exists sub_ends_at timestamptz null;
alter table public.coaches add column if not exists sub_started_at timestamptz null;

alter table public.coaches enable row level security;
alter table public.plans enable row level security;
alter table public.coupons enable row level security;
alter table public.payments enable row level security;
