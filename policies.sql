-- ══════════════════════════════════════════════════════════════
-- storagebeebee — Row Level Security policies (v2: 3 roles)
-- Run this AFTER schema.sql, in the Supabase SQL editor.
--
-- Role summary:
--   worker  — full read/write on items/categories/logs, but ONLY within
--             storage(s) they're assigned to via user_storages.
--   admin   — you. Manages profiles, storages, and user_storages
--             assignments. Read access to items/categories/logs across
--             ALL storages (for oversight/troubleshooting), but does not
--             add/edit/delete inventory — that stays a worker action.
--   ceo     — pure read-only, but sees EVERYTHING: profiles, storages,
--             user_storages assignments, items, categories, and logs,
--             across ALL storages. Cannot write anywhere. No exceptions —
--             all the actual admin work (creating users, managing
--             storages/assignments) is done by the admin role, not ceo.
-- ══════════════════════════════════════════════════════════════

-- ─── Turn RLS on for every table ─────────────────────────────
alter table profiles       enable row level security;
alter table storages       enable row level security;
alter table user_storages  enable row level security;
alter table categories     enable row level security;
alter table items          enable row level security;
alter table logs           enable row level security;

-- ─── Helper functions ────────────────────────────────────────
create or replace function current_role_is(target_role user_role)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = target_role
  );
$$;

create or replace function is_admin()
returns boolean language sql security definer set search_path = public stable
as $$ select current_role_is('admin'); $$;

create or replace function is_ceo()
returns boolean language sql security definer set search_path = public stable
as $$ select current_role_is('ceo'); $$;

-- Either privileged role — used for SELECT policies where both admin and
-- ceo get the same read access (they only diverge on write permissions).
create or replace function is_admin_or_ceo()
returns boolean language sql security definer set search_path = public stable
as $$ select is_admin() or is_ceo(); $$;

create or replace function is_member_of_storage(target_storage_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from user_storages
    where user_id = auth.uid() and storage_id = target_storage_id
  );
$$;

-- ══════════════════════════════════════════════════════════════
-- profiles
-- ══════════════════════════════════════════════════════════════
-- Own profile, or admin/ceo can see all — the CEO sees every detail
-- across the system, including who's on staff and what they're assigned to.
-- Only admin WRITES profiles though (see profiles_admin_write below) —
-- ceo is read-only everywhere, with no exceptions.
create policy "profiles_select_own_or_privileged"
  on profiles for select
  using (id = auth.uid() or is_admin_or_ceo());

-- Only the admin (not ceo) can create/edit accounts.
create policy "profiles_admin_write"
  on profiles for all
  using (is_admin())
  with check (is_admin());

-- ══════════════════════════════════════════════════════════════
-- storages
-- ══════════════════════════════════════════════════════════════
-- Workers see storages they belong to; admin and ceo see all (ceo for the
-- dashboard, admin for managing assignments).
create policy "storages_select_member_or_privileged"
  on storages for select
  using (is_member_of_storage(id) or is_admin_or_ceo());

-- Only admin creates/edits/deletes storages. CEO never writes, ever.
create policy "storages_admin_insert"
  on storages for insert
  with check (is_admin());

create policy "storages_admin_update"
  on storages for update
  using (is_admin())
  with check (is_admin());

create policy "storages_admin_delete"
  on storages for delete
  using (is_admin());

-- ══════════════════════════════════════════════════════════════
-- user_storages (many-to-many assignments)
-- ══════════════════════════════════════════════════════════════
-- A user sees their own assignments (for the storage-picker at login).
-- Admin and ceo can both see all assignments — admin because they manage
-- them, ceo because they can see everything (read-only, never writes).
create policy "user_storages_select_own_or_privileged"
  on user_storages for select
  using (user_id = auth.uid() or is_admin_or_ceo());

create policy "user_storages_admin_write"
  on user_storages for all
  using (is_admin())
  with check (is_admin());

-- ══════════════════════════════════════════════════════════════
-- categories
-- ══════════════════════════════════════════════════════════════
create policy "categories_select_member_or_privileged"
  on categories for select
  using (is_member_of_storage(storage_id) or is_admin_or_ceo());

-- Workers add categories within their own storage. Neither admin nor ceo
-- writes inventory-related data — that's a worker action.
create policy "categories_insert_member"
  on categories for insert
  with check (is_member_of_storage(storage_id));

-- ══════════════════════════════════════════════════════════════
-- items
-- ══════════════════════════════════════════════════════════════
-- Workers fully manage items in their own storage(s).
-- Admin AND ceo can both READ across all storages — admin for
-- troubleshooting, ceo for the live report. Neither one writes.
create policy "items_select_member_or_privileged"
  on items for select
  using (is_member_of_storage(storage_id) or is_admin_or_ceo());

create policy "items_insert_member"
  on items for insert
  with check (is_member_of_storage(storage_id));

create policy "items_update_member"
  on items for update
  using (is_member_of_storage(storage_id))
  with check (is_member_of_storage(storage_id));

create policy "items_delete_member"
  on items for delete
  using (is_member_of_storage(storage_id));

-- ══════════════════════════════════════════════════════════════
-- logs  (append-only for EVERYONE — worker, admin, and ceo alike)
-- ══════════════════════════════════════════════════════════════
create policy "logs_select_member_or_privileged"
  on logs for select
  using (is_member_of_storage(storage_id) or is_admin_or_ceo());

-- Only workers insert logs, and only as themselves, for their own storage.
create policy "logs_insert_member"
  on logs for insert
  with check (is_member_of_storage(storage_id) and user_id = auth.uid());

-- No update/delete policy on logs — not for workers, not for admin, not for
-- ceo. This is the database-level guarantee behind "remove clear log":
-- nobody, at any role, can alter or erase a log entry once it's written.

-- ══════════════════════════════════════════════════════════════
-- Note: creating the profile row for a new user
-- ══════════════════════════════════════════════════════════════
-- Since only admin can write to profiles, new accounts are admin-created —
-- no open self-signup. In practice: you create the auth user (via the
-- Supabase dashboard or an admin-only "create user" screen we'll build),
-- then insert their profiles row with the right role (worker/admin/ceo)
-- and, for workers, their user_storages assignments.

-- ══════════════════════════════════════════════════════════════
-- Supabase Storage — item images
-- ══════════════════════════════════════════════════════════════
-- Create a bucket named 'item-images' in the Supabase dashboard first
-- (Storage → New bucket → name it "item-images", keep it PRIVATE, not public).
-- Files are stored at path: {storage_id}/{item_id}-{timestamp}.jpg
-- so these policies scope access exactly like the items table does.

create policy "item_images_select_member_or_privileged"
  on storage.objects for select
  using (
    bucket_id = 'item-images'
    and (
      is_member_of_storage((storage.foldername(name))[1]::uuid)
      or is_admin_or_ceo()
    )
  );

create policy "item_images_insert_member"
  on storage.objects for insert
  with check (
    bucket_id = 'item-images'
    and is_member_of_storage((storage.foldername(name))[1]::uuid)
  );

create policy "item_images_update_member"
  on storage.objects for update
  using (
    bucket_id = 'item-images'
    and is_member_of_storage((storage.foldername(name))[1]::uuid)
  );

create policy "item_images_delete_member"
  on storage.objects for delete
  using (
    bucket_id = 'item-images'
    and is_member_of_storage((storage.foldername(name))[1]::uuid)
  );
