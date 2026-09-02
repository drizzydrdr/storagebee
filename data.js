// ══════════════════════════════════════════════════════════════
// storagebeebee — data.js
// Replaces the old IndexedDB layer (getDB/dbGetAll/dbAdd/dbUpdate/dbDelete)
// with Supabase, scoped to whatever storage the worker picked at login.
// Load AFTER auth.js. Function names are kept close to the originals so
// the rest of index.html needs minimal changes.
// ══════════════════════════════════════════════════════════════

// ─── Items ───────────────────────────────────────────────────
// image_url column stores the raw Storage PATH (e.g. "storageId/itemId-123.jpg"),
// not a public URL — the bucket is private, so a public URL would just 404 for
// everyone. Display URLs are short-lived signed URLs, generated fresh here.
const IMAGE_SIGNED_URL_TTL = 3600; // seconds

async function dbGetAll() {
  const storageId = requireActiveStorageId();
  const { data, error } = await supabase
    .from('items')
    .select('id, description, category_id, categories(name), quantity, image_url, created_at')
    .eq('storage_id', storageId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const paths = data.filter(row => row.image_url).map(row => row.image_url);
  let signedByPath = {};
  if (paths.length > 0) {
    const { data: signedList, error: signErr } = await supabase.storage
      .from('item-images')
      .createSignedUrls(paths, IMAGE_SIGNED_URL_TTL);
    if (!signErr && signedList) {
      signedList.forEach(entry => {
        if (entry.signedUrl) signedByPath[entry.path] = entry.signedUrl;
      });
    }
  }

  // Flatten so the rest of the app can keep using item.category / item.imageDataUrl / item.createdAt.
  // imagePath is the raw DB value — keep and reuse this (not imageDataUrl) whenever
  // saving an item with an unchanged image, since imageDataUrl is a temporary signed URL.
  return data.map(row => ({
    id: row.id,
    description: row.description,
    category: row.categories ? row.categories.name : '',
    categoryId: row.category_id,
    quantity: row.quantity,
    imagePath: row.image_url || null,
    imageDataUrl: row.image_url ? (signedByPath[row.image_url] || null) : null,
    createdAt: row.created_at
  }));
}

async function dbAdd(item) {
  const storageId = requireActiveStorageId();
  const { data: { user } } = await supabase.auth.getUser();
  const categoryId = item.category ? await resolveCategoryId(item.category) : null;
  const { data, error } = await supabase
    .from('items')
    .insert({
      storage_id: storageId,
      description: item.description,
      category_id: categoryId,
      quantity: item.quantity,
      image_url: item.imageUrl || null, // "imageUrl" here is actually the storage path — see uploadItemImage()
      created_by: user.id
    })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

async function dbUpdate(item) {
  const categoryId = item.category ? await resolveCategoryId(item.category) : null;
  const { error } = await supabase
    .from('items')
    .update({
      description: item.description,
      category_id: categoryId,
      quantity: item.quantity,
      image_url: item.imageUrl !== undefined ? item.imageUrl : undefined, // path, not URL — see uploadItemImage()
      updated_at: new Date().toISOString()
    })
    .eq('id', item.id);
  if (error) throw error;
}

async function dbDelete(id) {
  const { error } = await supabase.from('items').delete().eq('id', id);
  if (error) throw error;
}

// ─── Categories (now a real table, not localStorage) ──────────
// Data validation: category names are trimmed, checked case-insensitively
// against existing ones, and only ever created through this function —
// no more silently creating "أثاث" and "اثاث" as two different categories.
async function getCategories() {
  const storageId = requireActiveStorageId();
  const { data, error } = await supabase
    .from('categories')
    .select('id, name')
    .eq('storage_id', storageId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data; // [{ id, name }, ...]
}

async function resolveCategoryId(rawName) {
  const name = rawName.trim();
  if (!name) return null;
  const existing = await getCategories();
  const match = existing.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (match) return match.id;

  const storageId = requireActiveStorageId();
  const { data, error } = await supabase
    .from('categories')
    .insert({ storage_id: storageId, name })
    .select()
    .single();
  if (error) {
    // unique constraint race — someone else just created the same category
    if (error.code === '23505') {
      const retry = (await getCategories()).find(c => c.name.toLowerCase() === name.toLowerCase());
      if (retry) return retry.id;
    }
    throw error;
  }
  return data.id;
}

// ─── Activity log (append-only — no update/delete function exists on purpose) ──
// `reason` is required by the calling UI for 'decrease' and 'delete' actions;
// this function just passes it through to the log row.
async function addLog({ action, itemDescription, details, reason, quantityBefore, quantityAfter, itemId }) {
  const storageId = requireActiveStorageId();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('logs').insert({
    storage_id: storageId,
    item_id: itemId || null,
    user_id: user.id,
    action,
    item_description: itemDescription,
    details: details || null,
    reason: reason || null,
    quantity_before: quantityBefore ?? null,
    quantity_after: quantityAfter ?? null
  });
  if (error) throw error;
}

// ─── Log reading, with filters ─────────────────────────────────
// filters: { action?: 'add'|'edit'|'increase'|'decrease'|'delete', from?: ISO date, to?: ISO date }
async function getLogs(filters = {}) {
  const storageId = requireActiveStorageId();
  let query = supabase
    .from('logs')
    .select('id, action, item_description, details, reason, quantity_before, quantity_after, created_at, user_id, profiles(username, full_name)')
    .eq('storage_id', storageId)
    .order('created_at', { ascending: false });

  if (filters.action) query = query.eq('action', filters.action);
  if (filters.from)   query = query.gte('created_at', filters.from);
  if (filters.to)     query = query.lte('created_at', filters.to);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}
// Note: there is deliberately no deleteLog/clearLog function here — logs
// are append-only both in the database (no RLS delete/update policy) and
// in the app (no function exists to call).

// ─── Image upload to Supabase Storage ──────────────────────────
// Replaces the old canvas-resize-to-base64 flow. Still resizes client-side
// first (keeps uploads small/fast), then uploads the resized blob.
// Returns the STORAGE PATH (not a URL) — the bucket is private, so display
// URLs must be short-lived signed URLs generated at read time (see dbGetAll).
async function uploadItemImage(file, existingItemId) {
  const storageId = requireActiveStorageId();
  const resizedBlob = await resizeImageToBlob(file, 800, 0.75);
  const path = `${storageId}/${existingItemId || 'new'}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('item-images').upload(path, resizedBlob, {
    contentType: 'image/jpeg',
    upsert: false
  });
  if (error) throw error;
  return path;
}

function resizeImageToBlob(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round((h / w) * maxDim); w = maxDim; }
          else       { w = Math.round((w / h) * maxDim); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('resize failed')), 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
