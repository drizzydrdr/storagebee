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

// CORS: without these headers, the browser blocks the request before it even
// reaches this function (a "preflight" OPTIONS request fails first). Since
// admin.html is served from a different origin (GitHub Pages) than the
// function (supabase.co), this is required, not optional.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  // Browsers send an OPTIONS preflight before the real POST — must answer it
  // with the CORS headers and a 200, or the real request never gets sent.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    // ── 1. Verify the caller is a logged-in admin ──────────────
    const authHeader = req.headers.get('Authorization') || '';
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) {
      return jsonResponse({ error: 'Not authenticated' }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin
      .from('profiles').select('role').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return jsonResponse({ error: 'Only the admin role can create users' }, 403);
    }

    // ── 2. Parse and validate input ─────────────────────────────
    const body = await req.json();
    const { username, password, fullName, role, storageIds } = body;
    if (!username || !password || !fullName || !role) {
      return jsonResponse({ error: 'username, password, fullName, and role are required' }, 400);
    }
    if (!['worker', 'admin', 'ceo'].includes(role)) {
      return jsonResponse({ error: 'role must be worker, admin, or ceo' }, 400);
    }
    if (password.length < 8) {
      return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
    }

    const fakeEmail = `${username.trim().toLowerCase()}@${FAKE_EMAIL_DOMAIN}`;

    // ── 3. Create the auth user ─────────────────────────────────
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: fakeEmail,
      password,
      email_confirm: true // no email verification flow needed — internal tool
    });
    if (createErr) {
      return jsonResponse({ error: createErr.message }, 400);
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
      return jsonResponse({ error: profileErr.message }, 400);
    }

    // ── 5. Assign storages (workers only, but harmless if sent for others) ──
    if (Array.isArray(storageIds) && storageIds.length > 0) {
      const rows = storageIds.map((storageId: string) => ({ user_id: created.user.id, storage_id: storageId }));
      const { error: assignErr } = await admin.from('user_storages').insert(rows);
      if (assignErr) {
        return jsonResponse({ error: 'User created, but storage assignment failed: ' + assignErr.message }, 207);
      }
    }

    return jsonResponse({ success: true, userId: created.user.id }, 200);

  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
