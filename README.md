# storagebeebee — setup guide

This build adds accounts, live shared data, multiple storages, and an
admin/CEO tier on top of your original single-file app. Follow these
steps in order.

## 1. Create the Supabase project

1. Go to https://supabase.com → New project.
2. Pick a name, database password, and region (choose one close to Egypt,
   e.g. an EU region, for lowest latency).
3. Wait for it to finish provisioning (~2 minutes).

## 2. Run the database schema

1. In the Supabase dashboard, go to **SQL Editor → New query**.
2. Paste the entire contents of `schema.sql`, run it.
3. New query again, paste the entire contents of `policies.sql`, run it.

This creates all the tables (storages, profiles, user_storages, categories,
items, logs) and the Row Level Security rules for the three roles
(worker / admin / ceo).

## 3. Create the image storage bucket

1. Go to **Storage → New bucket**.
2. Name it exactly `item-images`.
3. Set it to **Private** (not public) — the RLS policies at the bottom of
   `policies.sql` already handle who can access what.

## 4. Get your project URL and anon key

1. Go to **Settings → API**.
2. Copy the **Project URL** and the **anon / public key**.
3. Open `auth.js` and fill in:
   ```js
   const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
   ```

## 5. Deploy the create-user edge function

This function creates new accounts safely (it needs the service role key,
which must never be shipped to the browser).

1. Install the Supabase CLI if you don't have it:
   `npm install -g supabase`
2. From this project's root folder (the one containing the `supabase/`
   folder), log in and link the project:
   ```
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```
   (the project ref is in your project URL: `https://YOUR-PROJECT-REF.supabase.co`)
3. Deploy the function:
   ```
   supabase functions deploy create-user
   ```
   The service role key is available to it automatically — no manual
   secret needed, Supabase injects it for you.

## 6. Create your own admin account (the very first user)

Since account creation normally goes through the admin page, and the
admin page requires an existing admin to log in — the very first account
has to be created manually:

1. Go to **Authentication → Users → Add user** in the Supabase dashboard.
2. Email: `youradminusername@storagebeebee.local` (pick any username,
   just keep the `@storagebeebee.local` suffix).
3. Set a password. Check "Auto Confirm User".
4. Go to **Table Editor → profiles → Insert row**:
   - `id`: paste the UUID of the user you just created (visible in the
     Authentication → Users list)
   - `username`: the same username you used before the `@`
   - `full_name`: your name
   - `role`: `admin`
5. Save.

You can now log in at `index.html` with that username/password — it'll
route you straight to `admin.html`. From there, use the "Create user"
form to add your first worker and CEO accounts (that flow uses the edge
function from step 5, so make sure it's deployed first).

## 7. Files to carry over from your old repo unchanged

These weren't part of this rebuild and should just be copied over as-is
from your existing `storagebeebee` repo:
- `logo.png`
- `manifest.json`
- any icon files it references
- `make_icons.py` (only needed if you regenerate icons later)

**Delete `sw.js`** if it exists in your old repo — the new app doesn't
register a service worker (offline support was intentionally dropped
since the app now needs a live connection), so an old cached service
worker could actually cause problems by serving stale files.

## 8. Hosting

Push everything to your new repo and enable **GitHub Pages** (Settings →
Pages → deploy from the `main` branch) exactly like your original repo —
nothing about hosting changes, since this is still a static site (no
build step, no server to run — Supabase *is* the backend).

## File map

| File | Purpose |
|---|---|
| `index.html` | Worker-facing app (Arabic) — login, storage picker, inventory |
| `admin.html` | Your admin console (English) — create users, manage storages/assignments |
| `ceo.html` | CEO's read-only live dashboard (English) |
| `auth.js` | Login, role lookup, storage-picker logic |
| `data.js` | All Supabase queries for items/categories/logs/images |
| `shared-auth-check.js` | Guards admin.html/ceo.html — redirects if wrong role |
| `schema.sql` | Database tables |
| `policies.sql` | Row Level Security rules |
| `supabase/functions/create-user/index.ts` | Edge function for safely creating accounts |

## Quick sanity checklist before handing this to real users

- [ ] Log in as a worker with 1 assigned storage → should skip the picker
- [ ] Log in as a worker with 2+ storages → picker appears, choice sticks after refresh
- [ ] Try decreasing a quantity → reason modal blocks until filled in
- [ ] Try deleting an item → same reason requirement
- [ ] Add a category, try adding a near-duplicate (different casing) → should reuse the existing one
- [ ] Confirm there is no way to clear/delete the log, anywhere, for anyone
- [ ] Log in as admin → create a worker, assign them to two storages, confirm it works
- [ ] Log in as ceo → confirm you can see all storages' data but no add/edit/delete controls exist anywhere
