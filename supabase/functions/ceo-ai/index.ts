// supabase/functions/ceo-ai/index.ts

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;

const MODEL = 'gpt-5.6-luna';

const MAX_AGENT_ITERATIONS = 6;
const MAX_ITEMS_RETURNED = 100;
const MAX_LOGS_RETURNED = 100;
const MAX_HISTORY_RETURNED = 100;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

// ============================================================
// TIME HELPERS
// ============================================================

function daysAgo(days: number): string {
  const date = new Date();
  date.setTime(date.getTime() - days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function startOfToday(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfWeek(): string {
  const date = new Date();
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;

  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);

  return date.toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================
// TOOL DEFINITIONS
// ============================================================

const tools = [
  {
    type: 'function',
    name: 'list_storages',
    description:
      'List every storage with its id and name.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_summary',
    description:
      'Get an overall inventory summary including total storages, total item records, total units, zero-stock items, low-stock items, and per-storage totals.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_items',
    description:
      'Search inventory items. Can filter by storage, category, or text in the item description. Results are limited to prevent huge responses.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        storage_id: {
          type: ['string', 'null'],
          description:
            'Storage ID to filter by, or null for all storages.',
        },
        category: {
          type: ['string', 'null'],
          description:
            'Category name to filter by, or null for all categories.',
        },
        search: {
          type: ['string', 'null'],
          description:
            'Text search against item description, or null.',
        },
        limit: {
          type: ['number', 'null'],
          description:
            'Maximum results to return. Maximum 100. Use null for 100.',
        },
      },
      required: [
        'storage_id',
        'category',
        'search',
        'limit',
      ],
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_logs',
    description:
      'Get inventory activity logs. Can filter by storage, action, start date and end date.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        storage_id: {
          type: ['string', 'null'],
          description:
            'Storage ID to filter by, or null.',
        },
        action: {
          type: ['string', 'null'],
          enum: [
            'add',
            'edit',
            'increase',
            'decrease',
            'delete',
            null,
          ],
          description:
            'Action type to filter by, or null for all actions.',
        },
        start_date: {
          type: ['string', 'null'],
          description:
            'ISO date/time marking the beginning of the period, or null.',
        },
        end_date: {
          type: ['string', 'null'],
          description:
            'ISO date/time marking the end of the period, or null.',
        },
        limit: {
          type: ['number', 'null'],
          description:
            'Maximum results. Maximum 100.',
        },
      },
      required: [
        'storage_id',
        'action',
        'start_date',
        'end_date',
        'limit',
      ],
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_low_stock',
    description:
      'Find inventory items whose quantity is at or below a specified threshold. Can return only zero-stock items.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        threshold: {
          type: 'number',
          description:
            'Maximum quantity considered low stock.',
        },
        storage_id: {
          type: ['string', 'null'],
          description:
            'Storage ID to filter by, or null for all storages.',
        },
        zero_only: {
          type: 'boolean',
          description:
            'If true, only return items with exactly zero quantity.',
        },
        limit: {
          type: ['number', 'null'],
          description:
            'Maximum results. Maximum 100.',
        },
      },
      required: [
        'threshold',
        'storage_id',
        'zero_only',
        'limit',
      ],
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_activity_summary',
    description:
      'Analyze inventory activity during a period and compare it with the previous equivalent period.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: [
            'today',
            'yesterday',
            'this_week',
            'last_7_days',
            'last_30_days',
          ],
          description:
            'Time period to analyze.',
        },
        storage_id: {
          type: ['string', 'null'],
          description:
            'Storage ID to analyze, or null for all storages.',
        },
      },
      required: [
        'period',
        'storage_id',
      ],
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_item_history',
    description:
      'Get recent activity history for a specific inventory item using its description.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        item_description: {
          type: 'string',
          description:
            'The item description or distinctive text from the description.',
        },
        days: {
          type: ['number', 'null'],
          description:
            'Number of days of history. Maximum 365.',
        },
        limit: {
          type: ['number', 'null'],
          description:
            'Maximum history records. Maximum 100.',
        },
      },
      required: [
        'item_description',
        'days',
        'limit',
      ],
      additionalProperties: false,
    },
  },

  {
    type: 'function',
    name: 'get_storage_analysis',
    description:
      'Compare storages using inventory size, total units, low-stock items, zero-stock items, and activity during the last 7 days.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        low_stock_threshold: {
          type: ['number', 'null'],
          description:
            'Quantity at or below which an item is considered low stock. Default 5.',
        },
      },
      required: [
        'low_stock_threshold',
      ],
      additionalProperties: false,
    },
  },
];

// ============================================================
// TOOL IMPLEMENTATIONS
// ============================================================

async function runTool(
  admin: any,
  name: string,
  args: any,
) {
  // ----------------------------------------------------------
  // LIST STORAGES
  // ----------------------------------------------------------

  if (name === 'list_storages') {
    const { data, error } = await admin
      .from('storages')
      .select('id, name')
      .order('name');

    if (error) {
      console.error('list_storages error:', error);

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    return {
      success: true,
      storages: data || [],
    };
  }

  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------

  if (name === 'get_summary') {
    const { data: storages, error: storagesError } =
      await admin
        .from('storages')
        .select('id, name');

    if (storagesError) {
      console.error('summary storages error:', storagesError);

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    const { data: items, error: itemsError } =
      await admin
        .from('items')
        .select('storage_id, quantity')
        .limit(10000);

    if (itemsError) {
      console.error('summary items error:', itemsError);

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    const threshold = 5;

    const byStorage: Record<string, any> = {};

    for (const storage of storages || []) {
      byStorage[storage.id] = {
        name: storage.name,
        itemCount: 0,
        totalUnits: 0,
        zeroStock: 0,
        lowStock: 0,
      };
    }

    for (const item of items || []) {
      const row = byStorage[item.storage_id];

      if (!row) continue;

      const quantity = Number(item.quantity) || 0;

      row.itemCount++;
      row.totalUnits += quantity;

      if (quantity === 0) {
        row.zeroStock++;
      }

      if (quantity <= threshold) {
        row.lowStock++;
      }
    }

    let totalItemCount = 0;
    let totalUnits = 0;
    let totalZeroStock = 0;
    let totalLowStock = 0;

    for (const storage of Object.values(byStorage) as any[]) {
      totalItemCount += storage.itemCount;
      totalUnits += storage.totalUnits;
      totalZeroStock += storage.zeroStock;
      totalLowStock += storage.lowStock;
    }

    return {
      success: true,
      totalStorages: (storages || []).length,
      totalItemRecords: totalItemCount,
      totalUnits,
      zeroStockItems: totalZeroStock,
      lowStockItems: totalLowStock,
      lowStockThreshold: threshold,
      byStorage,
      inventory_rows_capped: (items || []).length >= 10000,
    };
  }

  // ----------------------------------------------------------
  // GET ITEMS
  // ----------------------------------------------------------

  if (name === 'get_items') {
    const limit = clamp(
      Number(args?.limit) || MAX_ITEMS_RETURNED,
      1,
      MAX_ITEMS_RETURNED,
    );

    let q = admin
      .from('items')
      .select(
        'description, quantity, storage_id, storages(name), categories(name)',
        { count: 'exact' },
      );

    if (args?.storage_id) {
      q = q.eq(
        'storage_id',
        args.storage_id,
      );
    }

    if (args?.search) {
      q = q.ilike(
        'description',
        `%${args.search}%`,
      );
    }

    q = q.limit(limit);

    const {
      data,
      error,
      count,
    } = await q;

    if (error) {
      console.error('get_items error:', error);

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    let rows = data || [];

    if (args?.category) {
      rows = rows.filter(
        (r: any) =>
          String(r.categories?.name || '')
            .toLowerCase() ===
          String(args.category).toLowerCase(),
      );
    }

    return {
      success: true,
      returned: rows.length,
      total_matching_records: count ?? rows.length,
      has_more:
        (count ?? rows.length) > rows.length,
      items: rows.map((r: any) => ({
        description: r.description,
        quantity: r.quantity,
        storage: r.storages?.name || null,
        category: r.categories?.name || null,
      })),
    };
  }

  // ----------------------------------------------------------
  // GET LOGS
  // ----------------------------------------------------------

  if (name === 'get_logs') {
    const limit = clamp(
      Number(args?.limit) || 50,
      1,
      MAX_LOGS_RETURNED,
    );

    let q = admin
      .from('logs')
      .select(
        'action, item_description, details, reason, created_at, storage_id, storages(name), profiles(full_name, username)',
        { count: 'exact' },
      )
      .order(
        'created_at',
        { ascending: false },
      )
      .limit(limit);

    if (args?.storage_id) {
      q = q.eq(
        'storage_id',
        args.storage_id,
      );
    }

    if (args?.action) {
      q = q.eq(
        'action',
        args.action,
      );
    }

    if (args?.start_date) {
      q = q.gte(
        'created_at',
        args.start_date,
      );
    }

    if (args?.end_date) {
      q = q.lte(
        'created_at',
        args.end_date,
      );
    }

    const {
      data,
      error,
      count,
    } = await q;

    if (error) {
      console.error('get_logs error:', error);

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    return {
      success: true,
      returned: (data || []).length,
      total_matching_records:
        count ?? (data || []).length,
      has_more:
        (count ?? (data || []).length) >
        (data || []).length,
      logs: (data || []).map((r: any) => ({
        action: r.action,
        item: r.item_description,
        details: r.details,
        reason: r.reason,
        storage: r.storages?.name || null,
        by:
          r.profiles?.full_name ||
          r.profiles?.username ||
          null,
        when: r.created_at,
      })),
    };
  }

  // ----------------------------------------------------------
  // LOW STOCK
  // ----------------------------------------------------------

  if (name === 'get_low_stock') {
    const threshold = clamp(
      Number(args?.threshold) || 5,
      0,
      1000000,
    );

    const limit = clamp(
      Number(args?.limit) || 100,
      1,
      100,
    );

    let q = admin
      .from('items')
      .select(
        'description, quantity, storage_id, storages(name), categories(name)',
      );

    if (args?.storage_id) {
      q = q.eq(
        'storage_id',
        args.storage_id,
      );
    }

    if (args?.zero_only) {
      q = q.eq(
        'quantity',
        0,
      );
    } else {
      q = q.lte(
        'quantity',
        threshold,
      );
    }

    q = q
      .order(
        'quantity',
        { ascending: true },
      )
      .limit(limit);

    const {
      data,
      error,
    } = await q;

    if (error) {
      console.error('get_low_stock error:', error);

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    return {
      success: true,
      threshold,
      zero_only: Boolean(args?.zero_only),
      returned: (data || []).length,
      items: (data || []).map((r: any) => ({
        description: r.description,
        quantity: r.quantity,
        storage: r.storages?.name || null,
        category: r.categories?.name || null,
      })),
    };
  }

  // ----------------------------------------------------------
  // ACTIVITY SUMMARY
  // ----------------------------------------------------------

  if (name === 'get_activity_summary') {
    const period =
      args?.period || 'last_7_days';

    let currentStart: Date;
    let currentEnd = new Date();

    if (period === 'today') {
      currentStart =
        new Date(startOfToday());
    } else if (period === 'yesterday') {
      currentEnd =
        new Date(startOfToday());

      currentStart =
        new Date(
          currentEnd.getTime() -
          24 * 60 * 60 * 1000,
        );
    } else if (period === 'this_week') {
      currentStart =
        new Date(startOfWeek());
    } else if (period === 'last_30_days') {
      currentStart =
        new Date(daysAgo(30));
    } else {
      currentStart =
        new Date(daysAgo(7));
    }

    const duration =
      currentEnd.getTime() -
      currentStart.getTime();

    const previousEnd =
      new Date(currentStart.getTime());

    const previousStart =
      new Date(
        currentStart.getTime() -
        duration,
      );

    async function fetchActivity(
      start: Date,
      end: Date,
    ) {
      let q = admin
        .from('logs')
        .select(
          'action, item_description, storage_id, created_at',
        )
        .gte(
          'created_at',
          start.toISOString(),
        )
        .lt(
          'created_at',
          end.toISOString(),
        )
        .limit(5000);

      if (args?.storage_id) {
        q = q.eq(
          'storage_id',
          args.storage_id,
        );
      }

      const {
        data,
        error,
      } = await q;

      if (error) {
        console.error(
          'activity query error:',
          error,
        );

        return null;
      }

      return data || [];
    }

    const current =
      await fetchActivity(
        currentStart,
        currentEnd,
      );

    const previous =
      await fetchActivity(
        previousStart,
        previousEnd,
      );

    if (!current || !previous) {
      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    function summarize(rows: any[]) {
      const counts: Record<string, number> = {
        add: 0,
        edit: 0,
        increase: 0,
        decrease: 0,
        delete: 0,
      };

      const itemChanges: Record<string, number> = {};

      for (const row of rows) {
        if (
          Object.prototype.hasOwnProperty.call(
            counts,
            row.action,
          )
        ) {
          counts[row.action]++;
        }

        const item =
          row.item_description ||
          'Unknown item';

        itemChanges[item] =
          (itemChanges[item] || 0) + 1;
      }

      const mostChangedItems =
        Object.entries(itemChanges)
          .sort(
            (a, b) => b[1] - a[1],
          )
          .slice(0, 10)
          .map(
            ([item, changes]) => ({
              item,
              changes,
            }),
          );

      return {
        totalActivity: rows.length,
        ...counts,
        mostChangedItems,
      };
    }

    const currentSummary =
      summarize(current);

    const previousSummary =
      summarize(previous);

    const previousTotal =
      previousSummary.totalActivity;

    const currentTotal =
      currentSummary.totalActivity;

    let percentChange: number | null =
      null;

    if (previousTotal > 0) {
      percentChange =
        Math.round(
          (
            (
              currentTotal -
              previousTotal
            ) /
            previousTotal
          ) * 100,
        );
    }

    return {
      success: true,
      period,

      current: {
        start:
          currentStart.toISOString(),
        end:
          currentEnd.toISOString(),
        ...currentSummary,
      },

      previous: {
        start:
          previousStart.toISOString(),
        end:
          previousEnd.toISOString(),
        ...previousSummary,
      },

      comparison: {
        activity_change:
          currentTotal -
          previousTotal,

        activity_change_percent:
          percentChange,
      },
    };
  }

  // ----------------------------------------------------------
  // ITEM HISTORY
  // ----------------------------------------------------------

  if (name === 'get_item_history') {
    const days = clamp(
      Number(args?.days) || 30,
      1,
      365,
    );

    const limit = clamp(
      Number(args?.limit) || 50,
      1,
      MAX_HISTORY_RETURNED,
    );

    const search =
      String(
        args?.item_description || '',
      ).trim();

    if (!search) {
      return {
        success: false,
        error_code:
          'INVALID_ITEM_SEARCH',
      };
    }

    const {
      data,
      error,
    } = await admin
      .from('logs')
      .select(
        'action, item_description, details, reason, created_at, storages(name), profiles(full_name, username)',
      )
      .ilike(
        'item_description',
        `%${search}%`,
      )
      .gte(
        'created_at',
        daysAgo(days),
      )
      .order(
        'created_at',
        { ascending: false },
      )
      .limit(limit);

    if (error) {
      console.error(
        'get_item_history error:',
        error,
      );

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    return {
      success: true,
      search,
      days,
      returned: (data || []).length,

      history: (data || []).map(
        (r: any) => ({
          action:
            r.action,

          item:
            r.item_description,

          details:
            r.details,

          reason:
            r.reason,

          storage:
            r.storages?.name || null,

          by:
            r.profiles?.full_name ||
            r.profiles?.username ||
            null,

          when:
            r.created_at,
        }),
      ),
    };
  }

  // ----------------------------------------------------------
  // STORAGE ANALYSIS
  // ----------------------------------------------------------

  if (name === 'get_storage_analysis') {
    const threshold =
      clamp(
        Number(
          args?.low_stock_threshold,
        ) || 5,
        0,
        1000000,
      );

    const {
      data: storages,
      error: storageError,
    } = await admin
      .from('storages')
      .select('id, name');

    if (storageError) {
      console.error(
        'storage analysis error:',
        storageError,
      );

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    const {
      data: items,
      error: itemError,
    } = await admin
      .from('items')
      .select(
        'storage_id, quantity, description',
      )
      .limit(10000);

    if (itemError) {
      console.error(
        'storage analysis items error:',
        itemError,
      );

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    const {
      data: logs,
      error: logError,
    } = await admin
      .from('logs')
      .select(
        'storage_id, action, created_at',
      )
      .gte(
        'created_at',
        daysAgo(7),
      )
      .limit(10000);

    if (logError) {
      console.error(
        'storage analysis logs error:',
        logError,
      );

      return {
        success: false,
        error_code: 'DATABASE_ERROR',
      };
    }

    const result: Record<string, any> = {};

    for (const storage of storages || []) {
      result[storage.id] = {
        name:
          storage.name,

        itemCount:
          0,

        totalUnits:
          0,

        zeroStock:
          0,

        lowStock:
          0,

        activityLast7Days:
          0,

        increases:
          0,

        decreases:
          0,
      };
    }

    for (const item of items || []) {
      const row =
        result[item.storage_id];

      if (!row) continue;

      const quantity =
        Number(item.quantity) || 0;

      row.itemCount++;
      row.totalUnits += quantity;

      if (quantity === 0) {
        row.zeroStock++;
      }

      if (quantity <= threshold) {
        row.lowStock++;
      }
    }

    for (const log of logs || []) {
      const row =
        result[log.storage_id];

      if (!row) continue;

      row.activityLast7Days++;

      if (log.action === 'increase') {
        row.increases++;
      }

      if (log.action === 'decrease') {
        row.decreases++;
      }
    }

    const storagesSorted =
      Object.values(result).sort(
        (a: any, b: any) =>
          b.activityLast7Days -
          a.activityLast7Days,
      );

    return {
      success: true,

      lowStockThreshold:
        threshold,

      period:
        'last_7_days',

      storages:
        storagesSorted,
    };
  }

  return {
    success: false,
    error_code: 'UNKNOWN_TOOL',
  };
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `
You are the AI executive inventory assistant inside a company's inventory dashboard.

Your primary user is the CEO.

Your job is to help the CEO understand inventory, stock levels, storage performance, and activity using live database tools.

DATA ACCURACY:

- Never invent inventory numbers.
- Never guess quantities.
- Never claim something happened unless the tool results support it.
- If data is unavailable, say so.
- If a tool reports has_more=true, do not pretend you saw all matching records.
- Do not expose internal database implementation details.

READ-ONLY:

You are strictly read-only.

You cannot:
- create records
- edit records
- delete records
- modify quantities
- move inventory
- modify categories
- modify storages
- perform administrative actions

No write tools exist.

If asked to change something, explain briefly that you are read-only and that an authorized employee must make the change through the application.

TOOL USAGE:

Use get_summary for:
- total inventory
- total units
- number of storages
- overall inventory status
- zero-stock and low-stock overview

Use get_items for:
- finding an item
- finding items in a storage
- finding items in a category
- checking the quantity/location of an item

Use get_low_stock for:
- low stock
- out of stock
- zero stock
- items needing restocking

Use get_logs for:
- recent changes
- who changed something
- why something changed
- additions
- decreases
- edits
- deletions

Use get_activity_summary for:
- today's activity
- this week's activity
- recent activity
- activity trends
- whether activity increased or decreased
- comparing current activity with the previous period

Use get_item_history for:
- history of a specific item
- what happened to an item
- who changed an item
- why an item changed

Use get_storage_analysis for:
- comparing storages
- busiest storage
- storage with most low-stock items
- storage with most zero-stock items
- storage activity

For broad questions, use multiple tools when necessary.

EXECUTIVE STYLE:

The CEO wants the answer, not a description of your database queries.

Lead with the conclusion.

Be concise, professional, and specific.

Examples:

Bad:
"I queried the logs table and found 27 records."

Good:
"There were 27 inventory changes this week, up 35% from the previous period."

Bad:
"The quantity field is 0."

Good:
"Printer cartridges are currently out of stock."

Bullets are allowed when useful.

Do not use markdown headers.

Do not use emojis.

Do not expose:
- table names
- SQL
- API details
- internal tool names
- database errors
- implementation details

TIME INTERPRETATION:

"today" = today
"yesterday" = yesterday
"this week" = current week
"recently" = normally last 7 days
"this month" = normally last 30 days

INSIGHT PRIORITY:

When deciding what is noteworthy, prioritize:

1. Zero-stock items
2. Significant activity changes
3. Unusually active storages
4. Concentrations of low-stock items
5. Significant stock movement
6. Repeated changes to the same item

Do not call something unusual without supporting evidence.

If nothing meaningful stands out, say that inventory activity looks steady.

MULTI-STEP INVESTIGATION:

If answering a broad question requires several pieces of information, use multiple tools.

For example, if asked "Is there anything I should be concerned about?", investigate:
- overall inventory
- zero stock
- low stock
- recent activity
- storage activity

Then provide the most important finding first.

Never mention that you performed these tool calls.

CURRENT DATA ONLY:

When the user asks for live inventory information, always use the tools.

Do not rely on previous tool results if fresh data is required.

If the available data does not support a conclusion, say so instead of guessing.
RESPONSE FORMATTING:

Formatting is extremely important.

Never dump a multi-point analysis into one paragraph.

For analytical, investigative, or multi-point answers, structure the response clearly using Markdown.

Preferred structure:

**Short conclusion**

One brief sentence explaining the overall situation.

### Key Findings

- **Important finding:** supporting information.
- **Important finding:** supporting information.
- **Important finding:** supporting information.

### Activity

- **31 changes** in the last 7 days.
- **0 changes** in the preceding period.
- Explain what the difference means.

### Priority

1. **First action**
2. **Second action**
3. **Third action**

Formatting rules:

- Never use emojis.
- Use Markdown headings when an answer contains multiple sections.
- Use bullet points for separate findings.
- Use numbered lists for priorities, actions, recommendations, or steps.
- Use blank lines between sections.
- Bold important numbers, quantities, item names, and conclusions.
- Keep individual bullet points concise.
- Do not combine several unrelated findings into one long paragraph.
- Start analytical answers with a short overall conclusion when appropriate.
- Group related information under logical headings.
- Do not over-format simple questions. Simple factual questions can have a short direct answer.
- Do not use excessive headings for a small amount of information.
- Do not repeat the same information in multiple sections.

ARABIC AND ENGLISH TEXT:

Inventory names, storage names, category names, employee names, and other database values may contain Arabic.

Preserve database values exactly as they appear. Do not translate them unless the user explicitly asks for translation.

When Arabic and English are mixed, prioritize readability.

Avoid awkwardly placing an Arabic database value in the middle of an English sentence when it makes the sentence harder to read.

Prefer:

**Item:** "boxes" 
**Storage:** مخزن التجمع  
**Quantity:** **0**

over:

"boxes" at مخزن التجمع is out of stock.

For multiple inventory records, use the same consistent structure:

- **Item:** "boxes"
  - **Storage:** مخزن التجمع
  - **Quantity:** **0**

If several items belong to the same storage, this is also acceptable:

**مخزن التجمع**

- "boxes" — **0 units**
- "Chairs" — **1 unit**
- "Lamps" — **2 units**

Do not transliterate, translate, or alter Arabic names.

Use backticks around English item names when they are database values, especially when they may be confused with normal prose.

EXECUTIVE COMMUNICATION:

The CEO should be able to understand the most important point within a few seconds.

Lead with the conclusion.

Then provide the evidence.

Then provide the recommended priority or action when appropriate.

Do not simply list raw database results. Interpret the information and explain why it matters.

Example:

**Stock availability is the main concern.**

### Out of Stock

- **Item:** "boxes"
- **Storage:** مخزن التجمع
- **Quantity:** **0**

### Critically Low

- "Ai" — **1 unit**
- "Barti" — **2 units**
- "Tlou" — **2 units**

### Recent Activity

- **31 inventory changes** in the last 7 days.
- **0 changes** in the preceding period.
- This represents a significant increase in activity and should be investigated.

### Priority

1. **Replenish "boxes" first.**
2. Review the critically low items.
3. Investigate the recent activity increase.

The response should feel like an executive analysis, not a database dump.


`;

// ============================================================
// OPENAI RESPONSES API
// ============================================================

async function callOpenAI(input: any[]) {
  const requestBody = {
    model: MODEL,

    instructions:
      SYSTEM_PROMPT,

    input,

    tools,

    tool_choice:
      'auto',

    reasoning: {
      effort: 'none',
    },

    max_output_tokens:
      1200,

    parallel_tool_calls:
      true,
  };

  const res = await fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',

      headers: {
        Authorization:
          `Bearer ${OPENAI_API_KEY}`,

        'Content-Type':
          'application/json',
      },

      body:
        JSON.stringify(requestBody),
    },
  );

  const raw =
    await res.text();

  if (!res.ok) {
    console.error(
      'OpenAI error:',
      raw,
    );

    throw new Error(
      `OpenAI error ${res.status}`,
    );
  }

  return JSON.parse(raw);
}

// ============================================================
// EXTRACT FINAL TEXT
// ============================================================

function extractResponseText(
  response: any,
): string {
  if (
    typeof response?.output_text ===
      'string' &&
    response.output_text.trim()
  ) {
    return response.output_text.trim();
  }

  const textParts: string[] = [];

  for (
    const item of
      response?.output || []
  ) {
    if (
      item.type !==
      'message'
    ) {
      continue;
    }

    for (
      const content of
        item.content || []
    ) {
      if (
        content.type ===
          'output_text' &&
        typeof content.text ===
          'string'
      ) {
        textParts.push(
          content.text,
        );
      }
    }
  }

  return textParts
    .join('\n')
    .trim();
}

// ============================================================
// AGENT LOOP
// ============================================================

async function agentLoop(
  admin: any,
  initialInput: any[],
) {
  let input =
    [...initialInput];

  for (
    let iteration = 0;
    iteration < MAX_AGENT_ITERATIONS;
    iteration++
  ) {
    const response =
      await callOpenAI(
        input,
      );

    const output =
      Array.isArray(
        response?.output,
      )
        ? response.output
        : [];

    const functionCalls =
      output.filter(
        (item: any) =>
          item.type ===
          'function_call',
      );

    // --------------------------------------------------------
    // FINAL ANSWER
    // --------------------------------------------------------

    if (
      functionCalls.length === 0
    ) {
      const text =
        extractResponseText(
          response,
        );

      if (text) {
        return text;
      }

      console.error(
        'OpenAI returned no text:',
        JSON.stringify(
          response,
          null,
          2,
        ),
      );

      return "I couldn't generate a response.";
    }

    // --------------------------------------------------------
    // PRESERVE MODEL OUTPUT
    // --------------------------------------------------------

    input.push(
      ...output,
    );

    // --------------------------------------------------------
    // EXECUTE TOOLS
    // --------------------------------------------------------

    for (
      const call of
        functionCalls
    ) {
      let args: any = {};

      try {
        args =
          JSON.parse(
            call.arguments ||
            '{}',
          );
      } catch (_error) {
        console.error(
          'Invalid tool arguments:',
          call.arguments,
        );

        args = {};
      }

      let result: any;

      try {
        result =
          await runTool(
            admin,
            call.name,
            args,
          );
      } catch (error) {
        console.error(
          `Tool ${call.name} failed:`,
          error,
        );

        result = {
          success: false,
          error_code:
            'TOOL_EXECUTION_ERROR',
        };
      }

      input.push({
        type:
          'function_call_output',

        call_id:
          call.call_id,

        output:
          JSON.stringify(
            result,
          ),
      });
    }
  }

  return "I wasn't able to complete that analysis. Please try narrowing the question.";
}

// ============================================================
// EDGE FUNCTION
// ============================================================

Deno.serve(
  async (req) => {
    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (
      req.method ===
      'OPTIONS'
    ) {
      return new Response(
        'ok',
        {
          headers:
            corsHeaders,
        },
      );
    }

    // --------------------------------------------------------
    // METHOD
    // --------------------------------------------------------

    if (
      req.method !==
      'POST'
    ) {
      return jsonResponse(
        {
          error:
            'Method not allowed',
        },
        405,
      );
    }

    try {
      // ------------------------------------------------------
      // AUTHENTICATION
      // ------------------------------------------------------

      const authHeader =
        req.headers.get(
          'Authorization',
        ) || '';

      const callerClient =
        createClient(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
          {
            global: {
              headers: {
                Authorization:
                  authHeader,
              },
            },
          },
        );

      const {
        data: {
          user: caller,
        },
        error: callerErr,
      } =
        await callerClient
          .auth
          .getUser();

      if (
        callerErr ||
        !caller
      ) {
        return jsonResponse(
          {
            error:
              'Not authenticated',
          },
          401,
        );
      }

      // ------------------------------------------------------
      // CEO CHECK
      // ------------------------------------------------------

      const admin =
        createClient(
          SUPABASE_URL,
          SERVICE_ROLE_KEY,
        );

      const {
        data: profile,
        error: profileError,
      } =
        await admin
          .from('profiles')
          .select('role')
          .eq(
            'id',
            caller.id,
          )
          .single();

      if (
        profileError ||
        !profile ||
        profile.role !==
          'ceo'
      ) {
        return jsonResponse(
          {
            error:
              'CEO access only',
          },
          403,
        );
      }

      // ------------------------------------------------------
      // REQUEST BODY
      // ------------------------------------------------------

      const body =
        await req.json();

      // ------------------------------------------------------
      // INSIGHT MODE
      // ------------------------------------------------------

      if (
        body.mode ===
        'insight'
      ) {
        const input = [
          {
            role:
              'user',

            content:
              `Give me exactly one short, specific sentence under 25 words describing the single most noteworthy inventory development right now.

Investigate the live data before answering.

Check:
- overall inventory
- zero-stock items
- low-stock items
- recent activity
- activity trends
- storage differences

Prioritize a meaningful anomaly over a generic statement.

If nothing genuinely noteworthy appears, say:
"Inventory activity looks steady."

Do not mention tools, databases, or implementation details.`,
          },
        ];

        const insight =
          await agentLoop(
            admin,
            input,
          );

        return jsonResponse(
          {
            insight,
          },
          200,
        );
      }

      // ------------------------------------------------------
      // CHAT MODE
      // ------------------------------------------------------

      const history =
        Array.isArray(
          body.messages,
        )
          ? body.messages
          : [];

      const input =
        history
          .filter(
            (message: any) =>
              message &&
              (
                message.role ===
                  'user' ||
                message.role ===
                  'assistant'
              ),
          )
          .map(
            (message: any) => ({
              role:
                message.role,

              content:
                typeof message.content ===
                  'string'
                  ? message.content
                  : JSON.stringify(
                      message.content ??
                      '',
                    ),
            }),
          );

      const reply =
        await agentLoop(
          admin,
          input,
        );

      return jsonResponse(
        {
          reply,
        },
        200,
      );

    } catch (err) {
      console.error(
        'ceo-ai error:',
        err,
      );

      return jsonResponse(
        {
          error:
            'The AI assistant could not complete the request.',
        },
        500,
      );
    }
  },
);
