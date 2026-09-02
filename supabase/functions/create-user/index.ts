// ══════════════════════════════════════════════════════════════
// supabase/functions/create-user/index.ts
// Deploy with: supabase functions deploy create-user
//
// Why this has to be a server-side function: creating a Supabase Auth user
// requires the SERVICE ROLE key, which bypasses RLS entirely. That key must
// NEVER be shipped to the browser — so account creation happens here, on
// Supabase's servers, not in admin.html directly.
// ══════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // set via `supabase secrets set`
const FAKE_EMAIL_DOMAIN = 'storagebeebee.local';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    // ── 1. Verify the caller is a logged-in admin ──────────────
    const authHeader = req.headers.get('Authorization') || '';
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin
      .from('profiles').select('role').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Only the admin role can create users' }), { status: 403 });
    }

    // ── 2. Parse and validate input ─────────────────────────────
    const body = await req.json();
    const { username, password, fullName, role, storageIds } = body;
    if (!username || !password || !fullName || !role) {
      return new Response(JSON.stringify({ error: 'username, password, fullName, and role are required' }), { status: 400 });
    }
    if (!['worker', 'admin', 'ceo'].includes(role)) {
      return new Response(JSON.stringify({ error: 'role must be worker, admin, or ceo' }), { status: 400 });
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400 });
    }

    const fakeEmail = `${username.trim().toLowerCase()}@${FAKE_EMAIL_DOMAIN}`;

    // ── 3. Create the auth user ─────────────────────────────────
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: fakeEmail,
      password,
      email_confirm: true // no email verification flow needed — internal tool
    });
    if (createErr) {
      return new Response(JSON.stringify({ error: createErr.message }), { status: 400 });
    }

    // ── 4. Create the profile row ───────────────────────────────
    const { error: profileErr } = await admin.from('profiles').insert({
      id: created.user.id,
      username: username.trim().toLowerCase(),
      full_name: fullName,
      role
    });
    if (profileErr) {
      await admin.auth.admin.deleteUser(created.user.id); // roll back the auth user
      return new Response(JSON.stringify({ error: profileErr.message }), { status: 400 });
    }

    // ── 5. Assign storages (workers only, but harmless if sent for others) ──
    if (Array.isArray(storageIds) && storageIds.length > 0) {
      const rows = storageIds.map((storageId: string) => ({ user_id: created.user.id, storage_id: storageId }));
      const { error: assignErr } = await admin.from('user_storages').insert(rows);
      if (assignErr) {
        return new Response(JSON.stringify({ error: 'User created, but storage assignment failed: ' + assignErr.message }), { status: 207 });
      }
    }

    return new Response(JSON.stringify({ success: true, userId: created.user.id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
