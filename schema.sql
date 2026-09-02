-- ══════════════════════════════════════════════════════════════
-- storagebeebee — database schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query)
-- ══════════════════════════════════════════════════════════════

-- ─── Roles ───────────────────────────────────────────────────
-- worker: normal user, only sees storages they're assigned to; full read/write there
-- admin:  operations admin (you) — creates users, manages storages, manages
--         who's assigned to which storage. Does NOT manage items/inventory directly.
-- ceo:    pure read-only — sees the live dashboard/report across ALL storages,
--         never creates, edits, or deletes anything, anywhere.
create type user_role as enum ('worker', 'admin', 'ceo');

-- ─── Profiles ────────────────────────────────────────────────
-- One row per Supabase Auth user. Extends auth.users with app-specific fields.
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,        -- what the person actually types to log in
  full_name   text not null,
  role        user_role not null default 'worker',
  created_at  timestamptz not null default now()
);

-- ─── Storages ────────────────────────────────────────────────
-- Each physical/logical warehouse.
create table storages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,               -- e.g. 'مخزن المعادي'
  created_at  timestamptz not null default now()
);

-- ─── User <-> Storage assignments (many-to-many) ────────────
-- A user can belong to several storages; a storage can have several users.
create table user_storages (
  user_id     uuid not null references profiles(id) on delete cascade,
  storage_id  uuid not null references storages(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (user_id, storage_id)
);

-- ─── Categories ──────────────────────────────────────────────
-- Managed list per storage — prevents free-text typos/duplicates.
-- Admin (or a future 'manager' role) adds new categories; workers pick from this list only.
create table categories (
  id          uuid primary key default gen_random_uuid(),
  storage_id  uuid not null references storages(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (storage_id, name)
);

-- ─── Items ───────────────────────────────────────────────────
create table items (
  id             uuid primary key default gen_random_uuid(),
  storage_id     uuid not null references storages(id) on delete cascade,
  description    text not null,
  category_id    uuid references categories(id) on delete set null,
  quantity       integer not null default 0 check (quantity >= 0),
  image_url      text,                     -- Supabase Storage path/URL, replaces base64 data URLs
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ─── Activity log ────────────────────────────────────────────
-- Append-only: no delete/clear allowed at the app layer (enforced by RLS later).
-- 'reason' is required by the app whenever quantity decreases or an item is deleted;
-- left nullable here at the DB level since adds/increases/edits don't need one.
create type log_action as enum ('add', 'edit', 'increase', 'decrease', 'delete');

create table logs (
  id              uuid primary key default gen_random_uuid(),
  storage_id      uuid not null references storages(id) on delete cascade,
  item_id         uuid references items(id) on delete set null, -- kept even if item is later deleted
  user_id         uuid references profiles(id) on delete set null,
  action          log_action not null,
  item_description text not null,          -- snapshot, so it's readable even if the item is gone
  details         text,                     -- e.g. "الكمية: 12 ← 9"
  reason          text,                     -- required by app logic for 'decrease' and 'delete'
  quantity_before integer,
  quantity_after  integer,
  created_at      timestamptz not null default now()
);

-- ─── Helpful indexes ─────────────────────────────────────────
create index idx_items_storage on items (storage_id);
create index idx_logs_storage on logs (storage_id);
create index idx_logs_created_at on logs (created_at desc);
create index idx_categories_storage on categories (storage_id);
create index idx_user_storages_user on user_storages (user_id);
create index idx_user_storages_storage on user_storages (storage_id);

-- Row Level Security policies (worker vs admin, storage scoping) come in the next step,
-- once this schema is confirmed.
