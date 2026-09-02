// ══════════════════════════════════════════════════════════════
// shared-auth-check.js
// Used by admin.html and ceo.html. Requires supabase-js and auth.js
// to be loaded first (for the `supabase` client and getMyProfile()).
// ══════════════════════════════════════════════════════════════

// Checks the current session and role; redirects to index.html (the
// worker login) if there's no session or the role doesn't match.
// Returns the profile object on success, so callers can use profile.full_name etc.
async function requireRole(expectedRole) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  let profile;
  try {
    profile = await getMyProfile();
  } catch (err) {
    window.location.href = 'index.html';
    return null;
  }
  if (!profile || profile.role !== expectedRole) {
    window.location.href = 'index.html';
    return null;
  }
  return profile;
}
