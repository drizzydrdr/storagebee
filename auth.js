// ══════════════════════════════════════════════════════════════
// storagebeebee — auth.js
// Include via <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// BEFORE this file, same pattern as your existing idb/Chart.js includes.
// ══════════════════════════════════════════════════════════════

// Guard against this file being included twice on the same page (e.g. one
// leftover <script> tag from a manual edit plus the one in the build) —
// without this, a second inclusion would crash with "Identifier 'supabase'
// has already been declared" and silently break the whole login screen.
if (window.__authJsLoaded) {
  console.warn('auth.js was included more than once on this page — ignoring the extra copy. Check your <script> tags.');
} else {
window.__authJsLoaded = true;

const SUPABASE_URL = 'https://wafwmjujtgapzmbwdexg.supabase.co'; // fill in from your Supabase project settings
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhZndtanVqdGdhcHptYndkZXhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMjc4MjQsImV4cCI6MjEwMzkwMzgyNH0.h9ltZ3rk5sgfS_TDu9-f1KFW-K2snlLvr3GGsYoZvv0';                // safe to expose client-side — RLS does the real protection


// Workers log in with a username/employee ID, not a real email — Supabase
// Auth requires an email internally though, so we build a fake one from the
// username. Workers never see this; the login screen just shows "username".
const FAKE_EMAIL_DOMAIN = 'storagebeebee.local';
function usernameToFakeEmail(username) {
  return `${username.trim().toLowerCase()}@${FAKE_EMAIL_DOMAIN}`;
}

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ACTIVE_STORAGE_KEY = 'wh-active-storage-id';
const ACTIVE_STORAGE_NAME_KEY = 'wh-active-storage-name';

// ─── Sign in ─────────────────────────────────────────────────
// `username` is whatever the admin assigned when creating the account
// (e.g. an employee ID). Internally mapped to a fake email for Supabase Auth.
async function signIn(username, password) {
  const email = usernameToFakeEmail(username);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

async function signOut() {
  await supabase.auth.signOut();
  localStorage.removeItem(ACTIVE_STORAGE_KEY);
  localStorage.removeItem(ACTIVE_STORAGE_NAME_KEY);
}

// ─── Role lookup ─────────────────────────────────────────────
async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  return data; // { id, full_name, role: 'worker' | 'admin' | 'ceo' }
}

// ─── Worker: fetch assigned storages ─────────────────────────
async function getMyStorages() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('user_storages')
    .select('storage_id, storages ( id, name )')
    .eq('user_id', user.id);
  if (error) throw error;
  return data.map(row => row.storages); // [{ id, name }, ...]
}

// ─── Active storage (the one the worker picked / auto-selected) ──
function setActiveStorage(storage) {
  localStorage.setItem(ACTIVE_STORAGE_KEY, storage.id);
  localStorage.setItem(ACTIVE_STORAGE_NAME_KEY, storage.name);
}

function getActiveStorageId() {
  return localStorage.getItem(ACTIVE_STORAGE_KEY);
}

function getActiveStorageName() {
  return localStorage.getItem(ACTIVE_STORAGE_NAME_KEY);
}

// ─── Top-level: call this right after a successful login ─────
// Returns a small result object telling the caller what screen to show next.
async function resolveLoginDestination() {
  const profile = await getMyProfile();
  if (!profile) throw new Error('No profile found for this account.');

  if (profile.role === 'admin') {
    return { screen: 'admin' };
  }
  if (profile.role === 'ceo') {
    return { screen: 'ceo-dashboard' };
  }

  // worker
  const storages = await getMyStorages();
  if (storages.length === 0) {
    return { screen: 'no-access' };
  }
  if (storages.length === 1) {
    setActiveStorage(storages[0]);
    return { screen: 'app', storage: storages[0] };
  }
  return { screen: 'storage-picker', storages };
}

// ─── Called when the worker taps a storage on the picker screen ──
function chooseStorage(storage) {
  setActiveStorage(storage);
  // caller then shows the main app view, scoped to this storage
}

// ─── Guard: every worker-app query should use this ────────────
// Example: supabase.from('items').select('*').eq('storage_id', requireActiveStorageId())
function requireActiveStorageId() {
  const id = getActiveStorageId();
  if (!id) throw new Error('No active storage selected — send the user back to login.');
  return id;
}

} // end double-inclusion guard
