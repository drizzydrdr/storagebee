// ══════════════════════════════════════════════════════════════
// supabase/functions/ceo-ai/index.ts
// Deploy with: supabase functions deploy ceo-ai
// Requires the secret: supabase secrets set OPENAI_API_KEY=sk-...
//
// This function is READ-ONLY by construction: every tool below only ever
// runs a `.select(...)` query. There is no insert/update/delete tool
// defined anywhere, so the model has no mechanism to alter data even if
// asked to — the restriction isn't a prompt instruction that could be
// argued around, it's the absence of a capability.
// ══════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;
const MODEL = 'gpt-5.6-luna';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── Tool definitions (all read-only) ──────────────────────────
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_storages',
      description: 'List every storage, with its id and name.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_summary',
      description: 'Get an aggregated overview: total storages, total item types, total units, and a per-storage breakdown of item count and total units.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_items',
      description: 'Look up items. Can filter by storage, category, or a text search on the item description. Omit filters to get everything.',
      parameters: {
        type: 'object',
        properties: {
          storage_id: { type: 'string', description: 'Limit to one storage id (from list_storages).' },
          category: { type: 'string', description: 'Limit to items in this category name.' },
          search: { type: 'string', description: 'Case-insensitive text search on the item description.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_logs',
      description: 'Get recent activity log entries (adds, edits, increases, decreases, deletes), each with its reason and who did it. Can filter by storage and/or action type.',
      parameters: {
        type: 'object',
        properties: {
          storage_id: { type: 'string' },
          action: { type: 'string', enum: ['add', 'edit', 'increase', 'decrease', 'delete'] },
          limit: { type: 'number', description: 'Max entries to return, default 50, max 200.' }
        }
      }
    }
  }
];

async function runTool(admin: any, name: string, args: any) {
  if (name === 'list_storages') {
    const { data } = await admin.from('storages').select('id, name').order('name');
    return data || [];
  }
  if (name === 'get_summary') {
    const { data: storages } = await admin.from('storages').select('id, name');
    const { data: items } = await admin.from('items').select('storage_id, quantity');
    const byStorage: Record<string, { name: string; itemCount: number; totalUnits: number }> = {};
    (storages || []).forEach((s: any) => { byStorage[s.id] = { name: s.name, itemCount: 0, totalUnits: 0 }; });
    (items || []).forEach((i: any) => {
      const row = byStorage[i.storage_id];
      if (!row) return;
      row.itemCount++;
      row.totalUnits += Number(i.quantity) || 0;
    });
    const totals = Object.values(byStorage).reduce(
      (acc, s) => ({ itemCount: acc.itemCount + s.itemCount, totalUnits: acc.totalUnits + s.totalUnits }),
      { itemCount: 0, totalUnits: 0 }
    );
    return { totalStorages: (storages || []).length, ...totals, byStorage };
  }
  if (name === 'get_items') {
    let q = admin.from('items').select('description, quantity, storage_id, storages(name), categories(name)');
    if (args?.storage_id) q = q.eq('storage_id', args.storage_id);
    if (args?.search) q = q.ilike('description', `%${args.search}%`);
    const { data } = await q;
    let rows = data || [];
    if (args?.category) rows = rows.filter((r: any) => (r.categories?.name || '').toLowerCase() === String(args.category).toLowerCase());
    return rows.map((r: any) => ({
      description: r.description, quantity: r.quantity,
      storage: r.storages?.name || null, category: r.categories?.name || null
    }));
  }
  if (name === 'get_logs') {
    let q = admin.from('logs')
      .select('action, item_description, details, reason, created_at, storages(name), profiles(full_name, username)')
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(args?.limit) || 50, 200));
    if (args?.storage_id) q = q.eq('storage_id', args.storage_id);
    if (args?.action) q = q.eq('action', args.action);
    const { data } = await q;
    return (data || []).map((r: any) => ({
      action: r.action, item: r.item_description, details: r.details, reason: r.reason,
      storage: r.storages?.name || null,
      by: r.profiles?.full_name || r.profiles?.username || null,
      when: r.created_at
    }));
  }
  return { error: 'unknown tool' };
}

const SYSTEM_PROMPT = `You are the AI assistant embedded in a company's executive inventory dashboard. You help the CEO understand what's in their storages — quantities, categories, recent activity — using the tools provided. All data comes from live tool calls; never guess or invent numbers.

You are strictly READ-ONLY. You cannot create, edit, or delete anything — no such capability exists for you. If asked to change data, explain clearly that you can only report on data, and that changes have to be made by an admin or worker in the app itself.

Be concise and professional. Prefer direct answers over long explanations. Use plain text, no markdown headers, no emoji.`;

async function callOpenAI(messages: any[]) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.3 })
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function agentLoop(admin: any, messages: any[]) {
  for (let i = 0; i < 6; i++) {
    const completion = await callOpenAI(messages);
    const msg = completion.choices[0].message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || "I couldn't find an answer to that.";
    }
    messages.push(msg);
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_e) {}
      const result = await runTool(admin, call.function.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "That's a complex question — could you narrow it down a bit?";
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return jsonResponse({ error: 'Not authenticated' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', caller.id).single();
    if (!profile || profile.role !== 'ceo') return jsonResponse({ error: 'CEO access only' }, 403);

    const body = await req.json();

    if (body.mode === 'insight') {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Give me exactly one short, specific sentence (under 25 words) highlighting the single most noteworthy thing happening across all storages right now — e.g. unusual recent activity, something at zero stock, or a notable trend. Use get_summary and get_logs to check. If nothing stands out, say everything looks steady.' }
      ];
      const insight = await agentLoop(admin, messages);
      return jsonResponse({ insight }, 200);
    }

    // mode: 'chat'
    const history = Array.isArray(body.messages) ? body.messages : [];
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
    const reply = await agentLoop(admin, messages);
    return jsonResponse({ reply }, 200);

  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
