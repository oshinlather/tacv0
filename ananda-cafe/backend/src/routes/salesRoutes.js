// ============================================================
// master data routes added
// STEP 3: BACKEND API ROUTES
// Add these to your Express server (tacv0.onrender.com)
// File: server/routes/salesRoutes.js (or wherever your routes live)
// ============================================================

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
let sheetsHelper = null;
try { sheetsHelper = require('../googleSheets'); } catch (e) { console.log('Google Sheets module not found — sheet sync disabled'); }
const { requireAuth, requireOwner, requireRole, ensureOutletAccess, scopedOutletFilter, invalidateUser, filterItemsToRoleScope, getDemandItemSectionMap } = require('./authGuards');
const { todayIST } = require('../helpers');
const { creditStockIn } = require('../inventoryLedger');
const { applyDispatchStockOut } = require('./stockOutHooks');
const { appendRateCardPrice, ingestPrices, resolveByItemIds, resolveByNames, normalizeName: normalizeRateName } = require('./rateCardPrices');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');

const upload = multer({ storage: multer.memoryStorage() });

// ────────────────────────────────────────────────────────────
// OUTLET CODE MAPPING
// ────────────────────────────────────────────────────────────
const OUTLET_MAP = {
'The Ananda cafe': 'sec23',
'The Ananda Cafe (Sector - 31)': 'sec31',
'The Ananda Cafe(Sec 56, Huda Market)': 'sec56',
'The Ananda Cafe - Elan Mall': 'elan',
'The Ananda Cafe (sector 14, Gurgaon)': 'sec14',
'The Ananda Cafe (Siddharth vihar)': 'gaursid',
};

// Supabase/PostgREST caps a single select at 1000 rows — a single busy day's line items
// across 6 outlets can easily exceed that, and a plain .select() silently truncates
// instead of erroring, undercounting revenue/theoretical-consumption with no warning.
// Every daily_sales read needs to page through with .range() until every row's in.
//
// Fetches every page IN PARALLEL instead of one at a time — daily_sales is one row per
// LINE ITEM (not per order), so a real multi-outlet range gets big fast: a 14-day/
// 6-outlet range measured 30,367 rows, meaning the old sequential version (one .range()
// call, await its result, THEN fire the next) did ~31 round trips back to back — this
// alone was almost the entire ~13s Finance's BK Purchase basis took for a 2-week range
// (computeDailySalesRevenue calls this). Getting the row count first (one cheap
// head-only query) means every page's .range() bounds are known upfront, so they can
// all fire together — total time becomes "however long the slowest single page takes",
// not "the sum of all of them".
async function fetchAllDailySales({ date, from, to, outlet_code, select }) {
  const PAGE = 1000;
  const scopeQuery = (q) => {
    q = date ? q.eq('sale_date', date) : q.gte('sale_date', from).lte('sale_date', to);
    if (outlet_code) q = q.eq('outlet_code', outlet_code);
    return q;
  };
  const { count, error: countError } = await scopeQuery(supabase.from('daily_sales').select('*', { count: 'exact', head: true }));
  if (countError) throw countError;
  if (!count) return [];
  const pageStarts = [];
  for (let pageFrom = 0; pageFrom < count; pageFrom += PAGE) pageStarts.push(pageFrom);
  const pages = await Promise.all(pageStarts.map(async (pageFrom) => {
    const { data, error } = await scopeQuery(supabase.from('daily_sales').select(select || '*')).range(pageFrom, pageFrom + PAGE - 1);
    if (error) throw error;
    return data;
  }));
  return pages.flat();
}

// Per-outlet revenue for a date, computed straight from PetPooja billing data
// (daily_sales) instead of the outlet manager's manual "Daily Sales & Cash"
// entry — see 2026_08_11_daily_sales_status_and_waived_off.sql for the schema
// change this needed first. One row per unique invoice (every line item on an
// order repeats that invoice's order_total/area/order_type/status), cancelled
// invoices excluded entirely — their `total` is the would-have-been billed
// amount, not 0, so leaving them in would double-count as real revenue.
// `area` carries the aggregator name ('Zomato'/'Swiggy') for delivery orders
// and a seating-area name for dine-in — confirmed against real PetPooja
// exports, not guessed. Used by GET /api/pnl/live to replace daily_outlet_sales
// as the source of total_sale/effective_sale. Accepts either a single date (string,
// existing callers) or a { from, to } range (added for the Finance module's outlet-wise
// P&L, which needs a whole month's revenue in one query rather than looping day by day).
async function computeDailySalesRevenue(dateOrRange) {
  const rangeArgs = typeof dateOrRange === 'string' ? { date: dateOrRange } : dateOrRange;
  const rows = await fetchAllDailySales({ ...rangeArgs, select: 'outlet_code, sale_date, invoice_no, order_type, area, order_total, status, waived_off' });
  const invoices = new Map(); // "outlet::date::invoice" -> one row (line items repeat these fields)
  rows.forEach((r) => {
    // sale_date is REQUIRED in this key, not just outlet+invoice — invoice_no resets
    // daily for some outlets (confirmed: sec31 reuses "149" on all 61 days of a Jun-Jul
    // range, each a genuinely different order) while others (sec23) keep incrementing
    // forever and never collide across dates. Single-date callers are unaffected (every
    // row already shares one date), but the Finance module's range queries would
    // otherwise silently collapse ~60 real invoices sharing a number into one, which is
    // exactly what made S-31's revenue look ~20x too low there.
    const key = `${r.outlet_code}::${r.sale_date}::${r.invoice_no}`;
    if (!invoices.has(key)) {
      invoices.set(key, { outlet_code: r.outlet_code, order_type: r.order_type, area: r.area, total: Number(r.order_total) || 0, waivedOff: Number(r.waived_off) || 0, status: r.status });
    }
  });

  const byOutlet = {};
  const bucketFor = (oid) => byOutlet[oid] || (byOutlet[oid] = { total_sale: 0, store_sale: 0, swiggy_sale: 0, zomato_sale: 0, other_delivery_sale: 0, complimentary_amount: 0, cancelled_amount: 0 });

  invoices.forEach((inv) => {
    const b = bucketFor(inv.outlet_code);
    // A waived/comped amount is real even on an order that later got flagged
    // cancelled for an unrelated reason, so this isn't gated on status below.
    b.complimentary_amount += inv.waivedOff;
    if (inv.status === 'Cancelled') { b.cancelled_amount += inv.total; return; }
    b.total_sale += inv.total;
    const isDelivery = (inv.order_type || '').includes('Delivery');
    if (!isDelivery) b.store_sale += inv.total;
    else if (inv.area === 'Zomato') b.zomato_sale += inv.total;
    else if (inv.area === 'Swiggy') b.swiggy_sale += inv.total;
    else b.other_delivery_sale += inv.total;
  });

  return byOutlet;
}

// ── GET /api/sales/menu-items/:outlet — Every distinct item name actually billed at this
// outlet in the last 180 days (PetPooja's own names, not the recipe system's). Powers the
// "Pick dish..." picker used to link a raw-material/ingredient to a dish's recipe — without
// this, that picker only ever offered dishes that already happen to have a `recipes` row,
// so a real, currently-selling menu item nobody has recipe-mapped yet was simply
// unreachable there. 180 days keeps the query bounded and drops long-discontinued items
// without needing a real "is this dish still on the menu" flag anywhere.
router.get('/sales/menu-items/:outlet', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!ensureOutletAccess(user, req.params.outlet, res)) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);
    const rows = await fetchAllDailySales({
      from: cutoff.toISOString().split('T')[0], to: todayIST(),
      outlet_code: req.params.outlet, select: 'item_name, category_name',
    });
    const seen = new Map();
    rows.forEach((r) => { if (r.item_name && !seen.has(r.item_name)) seen.set(r.item_name, r.category_name || ''); });
    const items = [...seen.entries()]
      .map(([item_name, category_name]) => ({ item_name, category_name }))
      .sort((a, b) => a.item_name.localeCompare(b.item_name));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
// 3A. POST /api/sales/upload — Upload PetPooja CSV
// ────────────────────────────────────────────────────────────
router.post('/sales/upload', upload.single('file'), async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

const overrideDate = req.body.date || null; // Optional: override date from form
const rows = [];
const stream = Readable.from(req.file.buffer.toString());

await new Promise((resolve, reject) => {
stream
.pipe(csv())
.on('data', (row) => {
// Extract date from CSV or use override
const saleDate = overrideDate || (row.date ? row.date.split(' ')[0] : null);
if (!saleDate || !row.item_name) return;

rows.push({
sale_date: saleDate,
outlet: row.restaurant_name || '',
outlet_code: OUTLET_MAP[row.restaurant_name] || 'unknown',
invoice_no: row.invoice_no || '',
order_type: row.order_type || '',
payment_type: row.payment_type || '',
item_name: row.item_name || '',
category_name: row.category_name || '',
item_price: parseFloat(row.item_price) || 0,
item_quantity: parseFloat(row.item_quantity) || 1,
item_total: parseFloat(row.item_total) || 0,
my_amount: parseFloat(row.my_amount) || 0,
total_tax: parseFloat(row.total_tax) || 0,
discount: parseFloat(row.discount) || 0,
delivery_charge: parseFloat(row.delivery_charge) || 0,
container_charge: parseFloat(row.container_charge) || 0,
order_total: parseFloat(row.total) || 0,
area: row.area || null,
// status/order_cancel_reason/waived_off: real PetPooja columns that were
// previously dropped on the floor — status is what lets P&L's revenue
// aggregation exclude cancelled orders (their `total` is the would-have-been
// billed amount, not 0) instead of double-counting them as real sales.
status: row.status || null,
order_cancel_reason: row.order_cancel_reason || null,
waived_off: parseFloat(row.waived_off) || 0,
});
})
.on('end', resolve)
.on('error', reject);
});

if (rows.length === 0) {
return res.status(400).json({ error: 'No valid rows found in CSV' });
}

// Get the date from first row (kept for the response only — see below for why the
// delete/recompute steps no longer rely on this alone).
const uploadDate = rows[0].sale_date;
// A CSV can legitimately span many days (a "download whole month" PetPooja export) —
// used to delete-then-replace only rows[0]'s single date before inserting EVERY row in
// the file, so every OTHER date in the file just got inserted on top of whatever
// already existed for it — silently duplicating (double-counting) revenue for any date
// in the file that already had data, exactly the case a re-upload to backfill/fix a
// range hits hardest. Now scoped to every distinct (date × outlet) pair actually
// present in the file instead — a plain .in(dates).in(outlets) is a cartesian match
// rather than exact pairs, but real exports are one outlet per file, so in practice
// this deletes exactly "every date this file covers, for the outlet(s) it covers" and
// nothing belonging to another outlet that happened to share a date.
const uploadDates = [...new Set(rows.map(r => r.sale_date))];
const uploadOutlets = [...new Set(rows.map(r => r.outlet_code))];

// Delete existing data for these dates/outlets (re-upload replaces)
await supabase.from('daily_sales').delete().in('sale_date', uploadDates).in('outlet_code', uploadOutlets);

// Insert in batches of 500
const batchSize = 500;
let inserted = 0;
for (let i = 0; i < rows.length; i += batchSize) {
const batch = rows.slice(i, i + batchSize);
const { error } = await supabase.from('daily_sales').insert(batch);
if (error) throw error;
inserted += batch.length;
}

// After upload, trigger P&L + audit computation for every date this file touched, not
// just the first row's — otherwise a multi-day upload silently left every date but the
// first showing stale (pre-upload) computed P&L/audit numbers until something else
// happened to recompute them.
for (const d of uploadDates) {
await computeDailyPnL(d);
await computeRMAudit(d);
}

res.json({
success: true,
date: uploadDate,
dates: uploadDates,
rows_inserted: inserted,
outlets: uploadOutlets,
});
} catch (err) {
console.error('Sales upload error:', err);
res.status(500).json({ error: err.message });
}
});

// ────────────────────────────────────────────────────────────
// 3B. GET /api/sales/:date — Get sales for a date
// ────────────────────────────────────────────────────────────
router.get('/sales/:date', async (req, res) => {
try {
const { date } = req.params;
const { outlet } = req.query; // optional filter

let query = supabase
.from('daily_sales')
.select('*')
.eq('sale_date', date)
.order('item_total', { ascending: false });

if (outlet && outlet !== 'all') {
query = query.eq('outlet_code', outlet);
}

const { data, error } = await query;
if (error) throw error;

// Aggregate by item
const itemMap = {};
const outletMap = {};
let totalOrders = new Set();

data.forEach(row => {
// Item aggregation
if (!itemMap[row.item_name]) {
itemMap[row.item_name] = {
item_name: row.item_name,
category: row.category_name,
qty: 0,
revenue: 0,
};
}
itemMap[row.item_name].qty += row.item_quantity;
itemMap[row.item_name].revenue += row.item_total;

// Outlet aggregation
if (!outletMap[row.outlet_code]) {
outletMap[row.outlet_code] = {
outlet_code: row.outlet_code,
outlet_name: row.outlet,
orders: new Set(),
revenue: 0,
dine_in: 0,
delivery: 0,
pickup: 0,
};
}
outletMap[row.outlet_code].orders.add(row.invoice_no);
// Only add order-level revenue once per invoice
totalOrders.add(row.invoice_no);
});

// Calculate outlet-level revenue from unique orders
const orderRevenue = {};
data.forEach(row => {
const key = `${row.outlet_code}-${row.invoice_no}`;
if (!orderRevenue[key]) {
orderRevenue[key] = {
outlet_code: row.outlet_code,
total: row.order_total,
order_type: row.order_type,
};
}
});

Object.values(orderRevenue).forEach(order => {
if (outletMap[order.outlet_code]) {
outletMap[order.outlet_code].revenue += order.total;
if (order.order_type === 'Dine In') outletMap[order.outlet_code].dine_in++;
else if (order.order_type?.includes('Delivery')) outletMap[order.outlet_code].delivery++;
else if (order.order_type === 'Pick Up') outletMap[order.outlet_code].pickup++;
}
});

// Convert Sets to counts
Object.values(outletMap).forEach(o => {
o.orders = o.orders.size;
});

const items = Object.values(itemMap).sort((a, b) => b.revenue - a.revenue);
const outlets = Object.values(outletMap);

res.json({
date,
total_items: items.length,
total_orders: totalOrders.size,
total_revenue: items.reduce((s, i) => s + i.revenue, 0),
items,
outlets,
});
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ────────────────────────────────────────────────────────────
// 3C. GET /api/recipes — Get all recipes with ingredients
// ────────────────────────────────────────────────────────────
router.get('/recipes', async (req, res) => {
try {
let query = supabase
.from('recipes')
.select(`
       id, item_name, item_type, category, status,
       recipe_ingredients (
         id, raw_material, qty, unit, qty_kg
       )
     `)
.order('item_name');
if (req.query.all !== 'true') query = query.eq('status', 'Active');
const { data: recipes, error } = await query;

if (error) throw error;
res.json(recipes);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ── GET /api/recipes/:id/cost — Ingredient-by-ingredient COGS at current rate card
// prices, plus the dish's recent actual selling price from uploaded sales — answers
// "what does one of these cost right now, and what's our margin on it."
router.get('/recipes/:id/cost', async (req, res) => {
  try {
    const costing = await computeDishCost(req.params.id);
    if (!costing) return res.status(404).json({ error: 'Recipe not found' });
    const sellingPrice = await getSellingPriceInfo(costing.item_name);
    const margin = sellingPrice ? Math.round((sellingPrice.latest - costing.total_cost) * 100) / 100 : null;
    const marginPct = margin != null && sellingPrice.latest > 0 ? Math.round((margin / sellingPrice.latest) * 1000) / 10 : null;
    res.json({ ...costing, selling_price: sellingPrice, margin, margin_pct: marginPct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/recipes/costs-bulk — Cost for every active dish at once, keyed by normalized
// dish name. Used by the sales table to show cost/margin per row without one request per item.
router.get('/recipes/costs-bulk', async (req, res) => {
  try {
    const costs = await computeAllDishCosts();
    res.json(costs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Converts a recipe-ingredient qty into the kg-equivalent computeRMAudit sums directly —
// GM/KG/LTR/ML get a numeric qty_kg; countable items (Piece/Pcs) get null so they're
// skipped from the raw-material weight total (packaging isn't costed by weight).
function ingredientQtyKg(qty, unit) {
  const u = (unit || '').trim().toUpperCase();
  const n = Number(qty) || 0;
  if (['GM', 'G', 'GMS', 'GRAM', 'GRAMS'].includes(u)) return n / 1000;
  if (['KG', 'KGS'].includes(u)) return n;
  if (['LTR.', 'LTR', 'L', 'LITRE', 'LITER'].includes(u)) return n;
  if (['ML'].includes(u)) return n / 1000;
  return null; // Piece, Pcs, etc. — countable, not weighed
}

// ── POST /api/recipes — Create a new dish recipe (owner-only, master data)
router.post('/recipes', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { item_name, item_type, category } = req.body;
    if (!item_name || !category) return res.status(400).json({ error: 'item_name and category are required' });
    const { data, error } = await supabase.from('recipes').insert({
      item_name, item_type: item_type || 'Item', category, status: 'Active',
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/recipes/:id — Update a dish recipe's name/category/status (owner-only)
router.patch('/recipes/:id', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const updates = {};
    if (req.body.item_name !== undefined) updates.item_name = req.body.item_name;
    if (req.body.category !== undefined) updates.category = req.body.category;
    if (req.body.status !== undefined) updates.status = req.body.status;
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('recipes').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/recipes/:id — Soft-delete (status='Inactive') a dish recipe (owner-only)
router.delete('/recipes/:id', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { error } = await supabase.from('recipes').update({ status: 'Inactive', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/recipes/:id/ingredients — Add an ingredient to a dish recipe (owner-only)
router.post('/recipes/:id/ingredients', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { raw_material, qty, unit } = req.body;
    if (!raw_material || qty === undefined) return res.status(400).json({ error: 'raw_material and qty are required' });
    const { data, error } = await supabase.from('recipe_ingredients').insert({
      recipe_id: req.params.id, raw_material, qty: Number(qty), unit: unit || 'GM',
      qty_kg: ingredientQtyKg(qty, unit), area: 'All',
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/recipes/ingredients/:id — Update one ingredient's qty/unit/name (owner-only)
router.patch('/recipes/ingredients/:id', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { raw_material, qty, unit } = req.body;
    const updates = {};
    if (raw_material !== undefined) updates.raw_material = raw_material;
    if (qty !== undefined) updates.qty = Number(qty);
    if (unit !== undefined) updates.unit = unit;
    if (qty !== undefined || unit !== undefined) {
      const { data: existing } = await supabase.from('recipe_ingredients').select('qty, unit').eq('id', req.params.id).single();
      updates.qty_kg = ingredientQtyKg(qty !== undefined ? qty : existing?.qty, unit !== undefined ? unit : existing?.unit);
    }
    const { data, error } = await supabase.from('recipe_ingredients').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/recipes/ingredients/:id — Remove an ingredient from a dish recipe (owner-only)
router.delete('/recipes/ingredients/:id', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { error } = await supabase.from('recipe_ingredients').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
// GET /api/audit/packaging — Packaging Unit Consistency Audit
// MUST be registered before /audit/:date below, or Express matches "packaging" as
// the :date param and this route is never reached (same trap as /pnl/computed/:date).
// Packaging items (Pkt/Pcs/Bundle/Kg) are the ones most prone to a manager punching
// "pieces" when the item is actually demanded/counted in "bundles" (or vice versa).
// This scans recent demand/wastage/closing-stock rows for every packaging item and
// reports which unit(s) were actually used each time, alongside that item's default
// unit and its unit_conversions row (if any) — so the owner can see at a glance which
// items are being punched inconsistently, and which conversions are missing/orphaned
// (defined for a unit that doesn't match the item's actual default unit, so the
// UnitPicker never even offers it).
// ────────────────────────────────────────────────────────────
router.get('/audit/packaging', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const days = Math.min(Number(req.query.days) || 60, 180);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const [{ data: items }, { data: conversions }, { data: demands }, { data: closings }] = await Promise.all([
      supabase.from('demand_items').select('id, name, unit, active').eq('section_id', 'packaging').eq('active', true).order('name'),
      supabase.from('unit_conversions').select('*').eq('active', true),
      supabase.from('demands').select('outlet_id, date, type, items, items_units').gte('date', since).in('type', ['manual', 'wastage']),
      supabase.from('closing_stocks').select('outlet_id, date, items, items_units').gte('date', since),
    ]);

    const convByItem = {};
    (conversions || []).forEach((c) => { convByItem[c.item_id] = c; });

    const itemIds = new Set((items || []).map((i) => i.id));
    const usage = {}; // item_id -> source -> unit -> count
    const bump = (itemId, source, unit) => {
      if (!itemIds.has(itemId)) return;
      usage[itemId] = usage[itemId] || {};
      usage[itemId][source] = usage[itemId][source] || {};
      const key = unit || '(default)';
      usage[itemId][source][key] = (usage[itemId][source][key] || 0) + 1;
    };

    (demands || []).forEach((d) => {
      const its = d.items || {}; const units = d.items_units || {};
      Object.keys(its).forEach((id) => { if (Number(its[id]) > 0) bump(id, d.type, units[id]); });
    });
    (closings || []).forEach((c) => {
      const its = c.items || {}; const units = c.items_units || {};
      Object.keys(its).forEach((rawId) => {
        const id = rawId.replace(/^cs_/, '');
        if (Number(its[rawId]) > 0) bump(id, 'closing', units[id]);
      });
    });

    const report = (items || []).map((item) => {
      const conv = convByItem[item.id] || null;
      // A conversion is "orphaned" if its custom unit doesn't match the item's actual
      // default demand unit — the UnitPicker only offers a conversion when
      // conv.fromUnit === defaultUnit, so a mismatched one is silently unreachable.
      const conversionOrphaned = conv ? conv.unit_type.toLowerCase() !== (item.unit || '').toLowerCase() : false;
      const itemUsage = usage[item.id] || {};
      const distinctUnits = new Set();
      Object.values(itemUsage).forEach((bySource) => Object.keys(bySource).forEach((u) => distinctUnits.add(u === '(default)' ? item.unit : u)));
      return {
        id: item.id,
        name: item.name,
        default_unit: item.unit,
        active: item.active,
        conversion: conv ? { from_unit: conv.unit_type, qty: Number(conv.qty), base_unit: conv.base_unit, orphaned: conversionOrphaned } : null,
        usage: itemUsage,
        mixed_units: distinctUnits.size > 1,
      };
    });

    res.json({ since, days, items: report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// 3D. GET /api/audit/:date — Raw Material Audit
// ────────────────────────────────────────────────────────────
router.get('/audit/:date', async (req, res) => {
try {
    // outlet_mgr added for the outlet-side Performance Dashboard's COGS Score drill-down
    // — scopedOutletFilter below already forces them (same as franchise) to their own
    // outlet_id regardless of what ?outlet= is requested, so this can't leak another
    // outlet's numbers. chef added the same way, for the same dashboard now surfaced on
    // their own kitchen-side dashboard too.
    const user = await requireRole(req, res, 'owner', 'avp', 'head_chef', 'franchise', 'bk_manager', 'outlet_mgr', 'chef');
    if (!user) return;
    const { date } = req.params;
    const outletFilter = scopedOutletFilter(user, req.query.outlet);
    // ?to=YYYY-MM-DD turns :date into the START of a range — the audit is then the sum of
    // every day from :date through ?to (a month is just from=1st, to=last-day-so-far).
    // Absent, it's the single-day audit exactly as before.
    const to = req.query.to;
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to) && to >= date) {
      const outlets = await computeRMAuditRange(date, to, outletFilter);
      return res.json({ date, from: date, to, range: true, outlets });
    }
    const outlets = await computeRMAudit(date, outletFilter);
    res.json({ date, outlets });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// The Cold Drink & Water section's 4 physical stock items — mirrors
// DEMAND_SECTIONS's "cold_drink" section in App.jsx (frontend-only, so duplicated here).
// Purchase form items match these names exactly (fixed dropdown); PetPooja sale item
// names are free text and messy ("Water Bottel 20 Mrp", "Small Colddrink" etc), so sales
// are matched via classifyColdDrinkSale below instead of an exact-name lookup.
const COLD_DRINK_ITEMS = [
  { id: 'cold_drink', name: 'Cold Drink', unit: 'Pcs' },
  { id: 'diet_coke', name: 'Diet Coke', unit: 'Pcs' },
  { id: 'small_water_bottle', name: 'Small Water Bottle', unit: 'Pcs' },
  { id: 'water_bottle_1l', name: 'Water Bottle (1L)', unit: 'Pcs' },
];

// Classifies a PetPooja sale line into one of the 4 physical items above by name alone
// (not price — real data has cold drinks/water billed at all sorts of prices: ₹10, ₹20,
// ₹30, even ₹70 for Diet Coke). Order matters: check "diet coke" and "small water" before
// the generic "water"/"cold drink" checks so they don't get swallowed by the broader match.
// Returns null for lines that don't match any tracked item (Energy Drink, Soft Drink Can,
// Coke Can, Medium Soft Drink, ...) — these have no closing-stock/purchase item to audit
// against, so they're surfaced separately as "unmatched" rather than silently dropped or
// forced into the wrong bucket.
function classifyColdDrinkSale(name) {
  const compact = (name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (compact.includes('dietcoke')) return 'diet_coke';
  if (compact.includes('smallwater')) return 'small_water_bottle';
  if (compact.includes('water')) return 'water_bottle_1l';
  if (compact.includes('colddrink')) return 'cold_drink';
  return null;
}

// ────────────────────────────────────────────────────────────
// 3D-2. GET /api/audit/cold-drink/:date — Cold Drink & Water Bottle Audit
// Same consumed-material formula as RM Audit/P&L, but Purchase instead of Dispatch since
// outlets buy cold drinks/water directly rather than getting them from Base Kitchen:
//   Consumed = Yesterday Closing + Today Purchase − Today Closing
// That theoretical consumed figure is then checked against what PetPooja actually billed
// today for the same item — a gap means bottles left the fridge without being rung up
// (comps, theft, spoilage) or the reverse (billed more than physically consumed, usually
// a missed/duplicate closing-stock or purchase entry). Always covers all outlets,
// regardless of the RM Audit outlet filter.
// ────────────────────────────────────────────────────────────
router.get('/audit/cold-drink/:date', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { date } = req.params;
    const prevDate = new Date(date);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = prevDate.toISOString().split('T')[0];
    // Cold drinks have no rate_card entry — outlets buy them directly at whatever price
    // that vendor/day had, not off a fixed card (see the Daily P&L Cold Drink category
    // comment for the same reasoning). Costing "should have been consumed" vs "actually
    // consumed" here (so it can rank alongside RM Audit's leaks in Flags' COGS Leakage —
    // "staff drink and don't bill" was previously invisible there) needs SOME per-unit
    // ₹ figure, so it's derived from a trailing 30-day average of real purchases
    // (amount ÷ qty), per outlet+item — a single day's purchase price is too noisy
    // (bulk-buy days skew it), and a day with zero purchases would have no price at all.
    const purchaseLookbackStart = new Date(date); purchaseLookbackStart.setDate(purchaseLookbackStart.getDate() - 30);
    const purchaseLookbackStr = purchaseLookbackStart.toISOString().split('T')[0];

    const [{ data: prevClosing }, { data: todayClosing }, { data: todayPurchases }, salesRows, { data: purchaseHistory }] = await Promise.all([
      supabase.from('closing_stocks').select('outlet_id, items').eq('date', prevDateStr).eq('status', 'submitted'),
      supabase.from('closing_stocks').select('outlet_id, items').eq('date', date).eq('status', 'submitted'),
      supabase.from('purchases').select('outlet_id, items').eq('date', date),
      fetchAllDailySales({ date, select: 'outlet_code, item_name, item_quantity' }),
      supabase.from('purchases').select('outlet_id, date, items').gte('date', purchaseLookbackStr).lte('date', date),
    ]);

    const prevClosingByOutlet = {};
    (prevClosing || []).forEach((r) => { prevClosingByOutlet[r.outlet_id] = r.items || {}; });
    const todayClosingByOutlet = {};
    (todayClosing || []).forEach((r) => { todayClosingByOutlet[r.outlet_id] = r.items || {}; });

    const purchasedByOutlet = {}; // outlet_id -> item_id -> qty
    (todayPurchases || []).forEach((p) => {
      (p.items || []).filter((i) => i.type === 'cold_drink_purchase').forEach((i) => {
        const item = COLD_DRINK_ITEMS.find((ci) => ci.name.toLowerCase() === (i.item_name || '').toLowerCase());
        if (!item) return;
        purchasedByOutlet[p.outlet_id] = purchasedByOutlet[p.outlet_id] || {};
        purchasedByOutlet[p.outlet_id][item.id] = (purchasedByOutlet[p.outlet_id][item.id] || 0) + (Number(i.quantity) || 0);
      });
    });

    // Trailing 30-day average purchase price per outlet+item: sum(amount)/sum(qty).
    // Falls back to an all-outlet average for an outlet+item with zero purchase history
    // in the window (e.g. a newly-opened outlet), so a leak is still costed rather than
    // silently dropped.
    const purchaseAgg = {}; // outlet_id -> item_id -> { amount, qty }
    const purchaseAggAllOutlets = {}; // item_id -> { amount, qty }
    (purchaseHistory || []).forEach((p) => {
      (p.items || []).filter((i) => i.type === 'cold_drink_purchase').forEach((i) => {
        const item = COLD_DRINK_ITEMS.find((ci) => ci.name.toLowerCase() === (i.item_name || '').toLowerCase());
        if (!item) return;
        const qty = Number(i.quantity) || 0;
        const amount = Number(i.amount) || 0;
        if (qty <= 0) return;
        purchaseAgg[p.outlet_id] = purchaseAgg[p.outlet_id] || {};
        purchaseAgg[p.outlet_id][item.id] = purchaseAgg[p.outlet_id][item.id] || { amount: 0, qty: 0 };
        purchaseAgg[p.outlet_id][item.id].amount += amount;
        purchaseAgg[p.outlet_id][item.id].qty += qty;
        purchaseAggAllOutlets[item.id] = purchaseAggAllOutlets[item.id] || { amount: 0, qty: 0 };
        purchaseAggAllOutlets[item.id].amount += amount;
        purchaseAggAllOutlets[item.id].qty += qty;
      });
    });
    const rateFor = (oid, itemId) => {
      const own = purchaseAgg[oid]?.[itemId];
      if (own && own.qty > 0) return Math.round((own.amount / own.qty) * 100) / 100;
      const all = purchaseAggAllOutlets[itemId];
      if (all && all.qty > 0) return Math.round((all.amount / all.qty) * 100) / 100;
      return null;
    };

    const billedByOutlet = {}; // outlet_id -> item_id -> qty
    const unmatchedByOutlet = {}; // outlet_id -> { item_name -> qty }
    (salesRows || []).forEach((r) => {
      const oc = r.outlet_code || 'unknown';
      const itemId = classifyColdDrinkSale(r.item_name);
      if (!itemId) {
        // Only surface genuinely cold-drink-adjacent unmatched lines (not every unrelated
        // dish) — a slightly wider net than the classifier itself so Soft Drink
        // Can/Energy Drink/Coke Can show up here instead of vanishing silently.
        const compact = (r.item_name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!/colddrink|water|softdrink|energydrink|coke/.test(compact)) return;
        unmatchedByOutlet[oc] = unmatchedByOutlet[oc] || {};
        unmatchedByOutlet[oc][r.item_name] = (unmatchedByOutlet[oc][r.item_name] || 0) + (Number(r.item_quantity) || 0);
        return;
      }
      billedByOutlet[oc] = billedByOutlet[oc] || {};
      billedByOutlet[oc][itemId] = (billedByOutlet[oc][itemId] || 0) + (Number(r.item_quantity) || 0);
    });

    const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
    const outlets = outletIds.map((oid) => {
      const prevItems = prevClosingByOutlet[oid] || {};
      const todayItems = todayClosingByOutlet[oid] || {};
      const purchased = purchasedByOutlet[oid] || {};
      const billed = billedByOutlet[oid] || {};
      const items = COLD_DRINK_ITEMS.map((ci) => {
        const csKey = `cs_${ci.id}`;
        const hasClosingData = csKey in prevItems || csKey in todayItems;
        const prev = Number(prevItems[csKey] || 0);
        const closing = Number(todayItems[csKey] || 0);
        const purchase = Number(purchased[ci.id] || 0);
        const consumed = Math.round((prev + purchase - closing) * 100) / 100;
        const billedQty = Math.round((billed[ci.id] || 0) * 100) / 100;
        const rate = rateFor(oid, ci.id);
        // Mirrors RM Audit's should_consume_cost / actual_consumed_cost naming so the
        // frontend can merge these rows into the same ranked leakage list: "should
        // consume" here means "should have shown up as billed sales", "actual
        // consumed" is what physically left the fridge.
        const shouldConsumeCost = (hasClosingData && rate != null) ? Math.round(billedQty * rate * 100) / 100 : null;
        const actualConsumedCost = (hasClosingData && rate != null) ? Math.round(consumed * rate * 100) / 100 : null;
        return {
          item_id: ci.id, name: ci.name, unit: ci.unit,
          prev_closing: prev, purchased: purchase, closing, consumed,
          billed: billedQty,
          variance: hasClosingData ? Math.round((consumed - billedQty) * 100) / 100 : null,
          rate,
          should_consume_cost: shouldConsumeCost,
          actual_consumed_cost: actualConsumedCost,
        };
      });
      return {
        outlet_id: oid,
        items,
        unmatched_sales: Object.entries(unmatchedByOutlet[oid] || {}).map(([item_name, qty]) => ({ item_name, qty })),
      };
    });

    res.json({ date, outlets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/pnl/computed/:date — Frontend getComputedPnl(date)
// MUST be before /pnl/:date so Express doesn't match "computed" as a date
// ────────────────────────────────────────────────────────────
router.get('/pnl/computed/:date', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { date } = req.params;
    const { data: pnl, error } = await supabase
      .from('daily_pnl')
      .select('*')
      .eq('pnl_date', date);

    if (error) throw error;

    if (pnl && pnl.length > 0) {
      const mapped = pnl.map(row => ({
        ...row,
        outlet_id: row.outlet_code || row.outlet_id,
      }));
      return res.json({ pnl: mapped });
    }

    // Compute if not exists
    const result = await computeDailyPnL(date);
    const mapped = (result || []).map(row => ({
      ...row,
      outlet_id: row.outlet_code || row.outlet_id,
    }));
    res.json({ pnl: mapped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// 3E. GET /api/pnl/:date — Daily P&L
// ────────────────────────────────────────────────────────────
router.get('/pnl/:date', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { date } = req.params;

const { data: pnl, error } = await supabase
.from('daily_pnl')
.select('*')
.eq('pnl_date', date);

if (error) throw error;

if (pnl && pnl.length > 0) {
return res.json({ date, pnl });
}

// Compute if not exists
const result = await computeDailyPnL(date);
res.json({ date, pnl: result });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ────────────────────────────────────────────────────────────
// 3F. GET /api/bk-demand/:date — BK Consolidated Demand
// ────────────────────────────────────────────────────────────
router.get('/bk-demand/:date', async (req, res) => {
try {
const { date } = req.params;

// Get sales for the date
const { data: sales, error: salesErr } = await supabase
.from('daily_sales')
.select('item_name, item_quantity')
.eq('sale_date', date);

if (salesErr) throw salesErr;

// Get all recipes with ingredients
const { data: recipes, error: recErr } = await supabase
.from('recipes')
.select(`
       item_name,
       recipe_ingredients ( raw_material, qty, unit, qty_kg )
     `);

if (recErr) throw recErr;

// Get BK costs
const { data: bkCosts, error: bkErr } = await supabase
.from('bk_costs')
.select('*');

if (bkErr) throw bkErr;

const bkCostMap = {};
bkCosts.forEach(bk => { bkCostMap[bk.item_name.toLowerCase()] = bk; });

// Aggregate sales by item
const salesMap = {};
sales.forEach(s => {
salesMap[s.item_name] = (salesMap[s.item_name] || 0) + s.item_quantity;
});

// Build recipe lookup
const recipeMap = {};
recipes.forEach(r => { recipeMap[r.item_name] = r.recipe_ingredients; });

// Calculate BK demand
const bkDemand = {};
Object.entries(salesMap).forEach(([itemName, qty]) => {
const ingredients = recipeMap[itemName];
if (!ingredients) return;

ingredients.forEach(ing => {
// Check if this ingredient is a BK item
const bkMatch = Object.keys(bkCostMap).find(bk =>
ing.raw_material.toLowerCase().includes(bk) ||
bk.includes(ing.raw_material.toLowerCase())
);

if (!bkMatch) return;

const bk = bkCostMap[bkMatch];
const qtyKg = ing.qty_kg || 0;

if (!bkDemand[bk.item_name]) {
bkDemand[bk.item_name] = {
name: bk.item_name,
qty: 0,
unit: bk.unit || 'Kg',       // ← FIXED UNIT from bk_costs table
cost_per_kg: bk.cost_per_kg,
total_cost: 0,
};
}
bkDemand[bk.item_name].qty += qtyKg * qty;
});
});

// Calculate total costs
Object.values(bkDemand).forEach(d => {
d.total_cost = d.qty * d.cost_per_kg;
});

const items = Object.values(bkDemand).sort((a, b) => b.total_cost - a.total_cost);
const totalCost = items.reduce((s, d) => s + d.total_cost, 0);

res.json({ date, items, total_cost: totalCost });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ────────────────────────────────────────────────────────────
// HELPER: Compute Daily P&L
// ────────────────────────────────────────────────────────────
async function computeDailyPnL(date) {
// Get sales aggregated by outlet
const { data: sales } = await supabase
.from('daily_sales')
.select('*')
.eq('sale_date', date);

if (!sales || sales.length === 0) return [];

// Get unique orders for revenue calculation
const orderMap = {};
sales.forEach(row => {
const key = `${row.outlet_code}-${row.invoice_no}`;
if (!orderMap[key]) {
orderMap[key] = {
outlet_code: row.outlet_code,
total: row.order_total,
my_amount: row.my_amount,
tax: row.total_tax,
discount: row.discount,
};
}
});

// Item revenue per outlet
const outletItems = {};
sales.forEach(row => {
if (!outletItems[row.outlet_code]) outletItems[row.outlet_code] = [];
outletItems[row.outlet_code].push(row);
});

// Get recipes
const { data: recipes } = await supabase
.from('recipes')
.select('item_name, recipe_ingredients ( raw_material, qty_kg )');

const { data: bkCosts } = await supabase.from('bk_costs').select('*');
const { data: rateCard } = await supabase.from('rate_card').select('*');

const bkMap = {};
bkCosts?.forEach(bk => { bkMap[bk.item_name.toLowerCase()] = bk.cost_per_kg; });

const rateMap = {};
rateCard?.forEach(r => { if (r.rate_per_kg) rateMap[r.item_name.toLowerCase()] = r.rate_per_kg; });

const recipeMap = {};
recipes?.forEach(r => { recipeMap[r.item_name] = r.recipe_ingredients; });

const pnlRows = [];
const outlets = [...new Set(sales.map(s => s.outlet_code))];

for (const outletCode of [...outlets, null]) {
const outletSales = outletCode
? sales.filter(s => s.outlet_code === outletCode)
: sales;

const outletOrders = outletCode
? Object.values(orderMap).filter(o => o.outlet_code === outletCode)
: Object.values(orderMap);

const grossRevenue = outletOrders.reduce((s, o) => s + (o.my_amount || 0), 0);
const taxCollected = outletOrders.reduce((s, o) => s + (o.tax || 0), 0);
const discounts = outletOrders.reduce((s, o) => s + (o.discount || 0), 0);
const netRevenue = outletOrders.reduce((s, o) => s + (o.total || 0), 0);

// Calculate COGS
let bkCost = 0;
let rmCost = 0;
const itemQty = {};
outletSales.forEach(s => {
itemQty[s.item_name] = (itemQty[s.item_name] || 0) + s.item_quantity;
});

Object.entries(itemQty).forEach(([itemName, qty]) => {
const ingredients = recipeMap[itemName];
if (!ingredients) return;

ingredients.forEach(ing => {
if (!ing.qty_kg) return;
const rmLower = ing.raw_material?.toLowerCase() || '';

// Check BK
const bkMatch = Object.keys(bkMap).find(bk => rmLower.includes(bk) || bk.includes(rmLower));
if (bkMatch) {
bkCost += ing.qty_kg * qty * bkMap[bkMatch];
return;
}

// Check rate card
const rateMatch = Object.keys(rateMap).find(r => rmLower.includes(r) || r.includes(rmLower));
if (rateMatch) {
rmCost += ing.qty_kg * qty * rateMap[rateMatch];
}
});
});

const totalCogs = bkCost + rmCost;
const grossProfit = netRevenue - totalCogs;
const grossMargin = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;

const pnlRow = {
pnl_date: date,
outlet_code: outletCode,
gross_revenue: Math.round(grossRevenue * 100) / 100,
discounts: Math.round(discounts * 100) / 100,
tax_collected: Math.round(taxCollected * 100) / 100,
net_revenue: Math.round(netRevenue * 100) / 100,
bk_cost: Math.round(bkCost * 100) / 100,
rm_cost: Math.round(rmCost * 100) / 100,
total_cogs: Math.round(totalCogs * 100) / 100,
gross_profit: Math.round(grossProfit * 100) / 100,
gross_margin: Math.round(grossMargin * 100) / 100,
total_orders: outletOrders.length,
total_items: outletSales.reduce((s, x) => s + x.item_quantity, 0),
};

pnlRows.push(pnlRow);
}

// Upsert to DB
await supabase.from('daily_pnl').delete().eq('pnl_date', date);
await supabase.from('daily_pnl').insert(pnlRows);

return pnlRows;
}

// ────────────────────────────────────────────────────────────
// HELPER: Compute RM Audit
// ────────────────────────────────────────────────────────────
// Recipe raw-material name (free text, entered via the recipe editor) → the real
// demand_items id that carries actual outlet-level consumption. Only unambiguous matches
// are listed — everything else surfaces as "unmapped_ingredients" in the audit response
// rather than being silently guessed, since a wrong mapping would be worse than a missing
// one for a leakage figure the owner is relying on to be precise.
const RECIPE_RAW_MATERIAL_MAP = {
  'onion': 'onions',
  'cheese': 'cheese',
  'butter': 'butter',
  'deshi ghee': 'desi_ghee',
  'desi ghee': 'desi_ghee',
  'dosa batter': 'dosa_batter',
  'idli batter': 'idli_batter',
  'podi masala': 'podi_masala',
  'red chutney': 'red_chutney',
  'white chutney': 'white_chutney',
  'sambhar': 'sambhar',
  'paper bowl': 'paper_bowl',
  'spoon': 'bio_spoon',
  'banana leaf': 'banana_leaves',
  'packing bowl 250 ml': 'container_250ml',
  // Remaining BK-prepared Food items (DEMAND_SECTIONS' "food" section) — added so a
  // recipe ingredient named after any of these (e.g. "Vada Batter" in Vada's own recipe)
  // actually resolves instead of silently landing in unmapped_ingredients. All confirmed
  // to have a price source (rate_card or bk_recipes) except aloo_masala, which has
  // neither yet — mapped anyway so it at least matches by name; still won't get a should-
  // consume cost until a price exists for it.
  'pineapple halwa': 'pineapple_halwa',
  'vada batter': 'vada_batter',
  'rawa mix': 'rawa_mix',
  'rawa batter': 'rawa_mix', // dish recipes (e.g. Rawa Masala Dosa) call it "Rawa Batter" — same BK-prepared item as Rawa Mix, confirmed with owner
  'roasted peanuts': 'roasted_peanuts',
  'sevya payasam': 'sevya_payasam',
  'rasam': 'rasam',
  'onion masala': 'onion_masala',
  'aloo masala': 'aloo_masala',
  'roasted chana': 'roasted_chana',
  'garlic paste': 'garlic_paste',
  'sona masoori rice': 'sona_masoori_rice',
  'tadka': 'tadka',
  'roasted karipatta': 'roasted_karipatta',
  'boiled rice': 'boiled_rice',
  'upma sooji': 'upma_sooji',
};

// Dish names: PetPooja exports and recipe entries can differ in case/spacing/trailing
// punctuation ("Cheese  Dosa" vs "Cheese Dosa", "Ghee Masala Dosa." vs "Ghee Masala Dosa")
// — normalize both sides the same way before matching so real dishes aren't silently
// dropped just because of formatting.
function normalizeDishName(s) {
  return (s || '').toLowerCase().trim().replace(/\.+$/, '').replace(/\s+/g, ' ');
}
function normalizeIngredientName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Resolves a normalized dish-recipe ingredient name to a rate_card id, or a bk_recipes id
// for a BK-prepared item priced via its own recipe cost instead. RECIPE_RAW_MATERIAL_MAP is
// checked first since it deliberately overrides a handful of names (a packaging item priced
// under a different display name, or a genuine alias like "Rawa Batter" -> the "Rawa Mix"
// BK recipe) — but most ingredients are typed with the exact same name they already have in
// the rate card (Ginger, Tata Salt, Haldi Powder...) or, for a BK-prepared item, the exact
// same name its bk_recipes row already has (Dosa Batter, Sambhar, Onion Masala...) — so this
// falls back to a direct case-insensitive name match against each of those in turn, rather
// than requiring every single one to also get its own manual map entry. Without these
// fallbacks, a dish recipe's ingredients silently show as "not linked to any rate card item
// or BK recipe" — and drop out of should-consume entirely — purely because nobody remembered
// to add a RECIPE_RAW_MATERIAL_MAP line for an otherwise perfectly priced/produced item. This
// also means a brand-new BK recipe created for a previously-unmapped ingredient (e.g. via the
// "not linked to a tracked inventory item" quick-add) is picked up immediately by name, with
// no code change needed, as long as its bk_recipes.name matches the ingredient text.
function resolveIngredientRateId(key, rateByName, bkRecipeByName) {
  return RECIPE_RAW_MATERIAL_MAP[key] || rateByName[key] || (bkRecipeByName && bkRecipeByName[key]) || null;
}

// Crockery/Packaging — a fixed operational rule the owner sets, not a dish recipe, so
// it can't be captured by the usual sales × recipe_ingredients path (no single dish
// "contains" a wooden plate). Applies at all 6 outlets (originally only sec23/sec56/
// elan/gaursid — extended to sec31/sec14 per the owner's own request, same rule, no
// outlet-specific variation): every DINE-IN item sold (each line item counts
// individually — a table ordering 3 dosas is 3 plates) gets 1 Wooden Plate + 2 Bio
// Spoon + 1 Paper Bowl. Every PICKUP/DELIVERY order gets 2 Bio Spoon (once per order,
// not per item in it) PLUS a container specific to what was actually ordered — see
// TAKEAWAY_CATEGORY_CONTAINERS below; a Dosa Box was previously being added to every
// single takeaway order regardless of whether a dosa was even in it, same for the Idli
// container — fixed to only apply the container that matches what was sold.
const CROCKERY_PACKAGING_OUTLETS = new Set(['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid']);
// Rule quantities are always literal PIECE counts (1 plate, 2 spoons, ...) — converted
// into whatever unit each item is actually tracked/priced in (Pkt for Bio Spoon/Paper
// Bowl, Pcs for Wooden Plates) via convFactorFor + unit_conversions below, same as the
// recipe path already does for count-based ingredients — NOT a hardcoded pack size
// here, so it stays correct if the owner ever changes a pack size in Master Data
// without a code change.
//
// The rule ITSELF (which items, how many) is owner-editable — stored in app_config
// (key 'crockery_packaging_rules', see GET/POST/DELETE /api/crockery-packaging-rules
// below), same JSON-blob-in-app_config pattern as fixed_cost_heads. These two arrays
// are only the seed/fallback for a brand-new install with no app_config row yet.
// Dosa Box Small/Podi Idli Container/500ML Container/Vada Lifafa are DELIBERATELY not
// listed here anymore (see TAKEAWAY_CATEGORY_CONTAINERS) — they're category-matched per
// item now, not a flat per-order allowance, so they don't belong in a generic
// add-any-item list the way Bio Spoon (genuinely universal) does.
const DEFAULT_CROCKERY_PACKAGING_RULES = {
  dine_in: [
    { item_id: 'wooden_plates', name: 'Wooden Plates', qty: 1 },
    { item_id: 'bio_spoon', name: 'Bio Spoon', qty: 2 },
    { item_id: 'paper_bowl', name: 'Paper Bowl', qty: 1 },
  ],
  takeaway: [
    { item_id: 'bio_spoon', name: 'Bio Spoon', qty: 2 },
  ],
};
// Category-matched takeaway containers — exactly ONE of these applies per pickup/
// delivery LINE ITEM (not per order — a parcel with 2 dosas needs 2 boxes), chosen by
// matching that item's own category_name or item_name. Checked in this fixed order,
// first match wins, so a rare combo dish naming both (e.g. "Idli Vada Combo") doesn't
// try to claim two containers. Dosa/Rice match on category_name (PetPooja's own "Dosas"/
// "Dosa"/"Dosas [o]" and "Rice & Upma"/"Rice & Upma [o]" categories — verified against
// real sales data, covers Uttapam/Appe/Upma too since they share the category); Idli/
// Vada match on item_name instead, since PetPooja lumps both into one "Idli And Vada"
// category with no further split. A dish matching none of these (Beverages, etc.) gets
// no category container — only the universal Bio Spoon still applies to it.
const TAKEAWAY_CATEGORY_CONTAINERS = [
  { key: 'dosa', matchField: 'category_name', match: 'dosa', item_id: 'dosa_box_small', name: 'Dosa Box Small' },
  { key: 'rice', matchField: 'category_name', match: 'rice', item_id: 'container_500ml', name: '500ML Container' },
  { key: 'idli', matchField: 'item_name', match: 'idli', item_id: 'podi_idli_container', name: 'Podi Idli Container' },
  { key: 'vada', matchField: 'item_name', match: 'vada', item_id: 'vada_lifafa', name: 'Vada Lifafa' },
];
function matchTakeawayCategoryContainer(row) {
  for (const rule of TAKEAWAY_CATEGORY_CONTAINERS) {
    const field = rule.matchField === 'category_name' ? row.category_name : row.item_name;
    if ((field || '').toLowerCase().includes(rule.match)) return rule;
  }
  return null;
}
// Sambhar + Chutney sides — every pickup/delivery ORDER (not per line item) that
// contains at least one Dosa, Idli, or Vada item gets 1 Sambhar (250ML Container) and
// 2 Chutney (50ML Container) packed once for the whole order, same as Bio Spoon's
// per-order pattern, not per-dish like TAKEAWAY_CATEGORY_CONTAINERS above. Rice-only
// orders don't get sides, so this is gated on category, not universal like Bio Spoon.
const SAMBHAR_CHUTNEY_SIDES = [
  { item_id: 'container_250ml', name: '250ML Container (Sambhar)', qty: 1 },
  { item_id: 'container_50ml', name: '50ML Container (Chutney)', qty: 2 },
];
function isDosaIdliVadaRow(row) {
  const match = matchTakeawayCategoryContainer(row);
  return !!match && match.key !== 'rice';
}
async function getCrockeryPackagingRules() {
  const { data } = await supabase.from('app_config').select('value').eq('key', 'crockery_packaging_rules').maybeSingle();
  if (!data?.value) return DEFAULT_CROCKERY_PACKAGING_RULES;
  try {
    const parsed = JSON.parse(data.value);
    return { dine_in: Array.isArray(parsed.dine_in) ? parsed.dine_in : [], takeaway: Array.isArray(parsed.takeaway) ? parsed.takeaway : [] };
  } catch (e) { return DEFAULT_CROCKERY_PACKAGING_RULES; }
}
// Builds should-consume entries for the crockery/packaging items in the exact same
// shape computeRMAudit's recipe-matched items use, so they slot into the same list
// (RM Audit, COGS Compare, P&L) with should_consume_cost/actual_consumed/variance all
// computed the same way — actualById/rateMap/convFactorFor are the same per-outlet
// lookups the recipe path already built, just reused here instead of re-fetched.
// `rules` (from getCrockeryPackagingRules) defaults to the seed values so existing
// callers that haven't been updated yet keep working unchanged.
function computeCrockeryPackagingItems(oid, outletSalesRows, actualById, rateMap, convFactorFor, rules = DEFAULT_CROCKERY_PACKAGING_RULES) {
  if (!CROCKERY_PACKAGING_OUTLETS.has(oid)) return [];

  let dineInItems = 0;
  const takeawayInvoices = new Set();
  outletSalesRows.forEach((r) => {
    if (r.order_type === 'Dine In') dineInItems += Number(r.item_quantity || 0);
    else if (r.order_type === 'Pick Up' || r.order_type?.includes('Delivery')) takeawayInvoices.add(r.invoice_no);
  });
  const takeawayOrders = takeawayInvoices.size;

  const acc = {}; // item_id -> { name, qty (in tracked unit), breakdown[] }
  const addRule = (rule, sourceLabel, sourceQty) => {
    if (sourceQty <= 0) return;
    const trackedUnit = actualById[rule.item_id]?.unit || rateMap[rule.item_id]?.unit || 'Pcs';
    const perUnit = rule.qty * convFactorFor(rule.item_id, 'Piece', trackedUnit);
    const subtotal = Math.round(perUnit * sourceQty * 1000) / 1000;
    if (!acc[rule.item_id]) acc[rule.item_id] = { name: rule.name, qty: 0, breakdown: [] };
    acc[rule.item_id].qty += subtotal;
    acc[rule.item_id].breakdown.push({ dish: sourceLabel, qty_sold: sourceQty, per_dish: perUnit, subtotal });
  };
  (rules.dine_in || []).forEach((rule) => addRule(rule, 'Dine-in items (crockery)', dineInItems));
  (rules.takeaway || []).forEach((rule) => addRule(rule, 'Pickup/Delivery orders (packaging)', takeawayOrders));

  // Category-matched containers — see TAKEAWAY_CATEGORY_CONTAINERS: grouped by dish name
  // (not summed into one blanket "per order" figure) so should_consume_breakdown still
  // shows which specific dish drove how much of each container, same as the recipe path.
  const categoryQtyByItemAndDish = {}; // container item_id -> { dish_name -> qty }
  outletSalesRows.forEach((r) => {
    if (r.order_type !== 'Pick Up' && !r.order_type?.includes('Delivery')) return;
    const match = matchTakeawayCategoryContainer(r);
    if (!match) return;
    const qty = Number(r.item_quantity || 0);
    if (qty <= 0) return;
    const byDish = categoryQtyByItemAndDish[match.item_id] || (categoryQtyByItemAndDish[match.item_id] = {});
    byDish[r.item_name] = (byDish[r.item_name] || 0) + qty;
  });
  Object.entries(categoryQtyByItemAndDish).forEach(([itemId, byDish]) => {
    const containerName = TAKEAWAY_CATEGORY_CONTAINERS.find((c) => c.item_id === itemId)?.name || itemId;
    Object.entries(byDish).forEach(([dishName, qty]) => {
      addRule({ item_id: itemId, name: containerName, qty: 1 }, `Pickup/Delivery — ${dishName}`, qty);
    });
  });

  // Sambhar + Chutney sides — see SAMBHAR_CHUTNEY_SIDES: once per order (not per dish)
  // for any pickup/delivery order containing at least one Dosa/Idli/Vada item.
  const sidesEligibleInvoices = new Set();
  outletSalesRows.forEach((r) => {
    if (r.order_type !== 'Pick Up' && !r.order_type?.includes('Delivery')) return;
    if (isDosaIdliVadaRow(r)) sidesEligibleInvoices.add(r.invoice_no);
  });
  SAMBHAR_CHUTNEY_SIDES.forEach((rule) => addRule(rule, 'Pickup/Delivery orders with Dosa/Idli/Vada (sides)', sidesEligibleInvoices.size));

  return Object.entries(acc).map(([itemId, data]) => {
    const actualItem = actualById[itemId];
    const rate = rateMap[itemId]?.price ?? null;
    const shouldConsume = Math.round(data.qty * 1000) / 1000;
    const actualQty = actualItem ? actualItem.used : null;
    const variance = actualQty != null ? Math.round((actualQty - shouldConsume) * 1000) / 1000 : null;
    const variancePct = actualQty != null && shouldConsume > 0 ? Math.round((variance / shouldConsume) * 1000) / 10 : null;
    return {
      raw_material: data.name,
      item_id: itemId,
      unit: actualItem?.unit || rateMap[itemId]?.unit || 'Pcs',
      should_consume: shouldConsume,
      should_consume_breakdown: data.breakdown,
      rate,
      should_consume_cost: rate != null ? Math.round(shouldConsume * rate * 100) / 100 : null,
      actual_consumed: actualQty != null ? Math.round(actualQty * 1000) / 1000 : null,
      actual_consumed_cost: actualQty != null && rate != null ? Math.round(actualQty * rate * 100) / 100 : null,
      actual_breakdown: actualItem ? {
        prev_closing: actualItem.prev_closing, dispatched: actualItem.dispatched,
        purchased: actualItem.purchased, wastage: actualItem.wastage, closing: actualItem.closing,
      } : null,
      variance, variance_pct: variancePct,
    };
  });
}

// Theoretical (recipe) consumption vs ACTUAL outlet-level consumption — the same
// Yesterday Closing + Dispatched − Wastage − Today Closing figure P&L and COGS Compare
// already show (via computeStockUsageForDate), not Base Kitchen's internal issuance
// records. Computed per outlet so leakage can be compared outlet-to-outlet, since every
// outlet cooks from the same recipes and dispatches from the same base kitchen.
// Recipes, costing context and crockery/packaging rules are the SAME for every date, so a
// range/month caller (computeRMAuditRange) builds them once and passes them into each day's
// computeRMAudit via sharedCtx instead of this function refetching all three per day — the
// same reuse computeStockUsageForDate already does for its costingContext.
async function buildRMAuditSharedCtx(asOfDate) {
  const [{ data: recipes }, costingContext, crockeryPackagingRules] = await Promise.all([
    supabase.from('recipes').select('id, item_name, recipe_ingredients ( id, raw_material, qty, unit, qty_kg )').eq('status', 'Active'),
    // Priced as-of the audit date so an outlet's leakage is valued at the prices in effect
    // that day, not today's. A range caller passes no date here and re-prices per day via
    // costingContext.withDate(day) instead (one ledger load, priced 30 different ways).
    buildCostingContext(asOfDate),
    getCrockeryPackagingRules(),
  ]);
  return { recipes: recipes || [], costingContext, crockeryPackagingRules };
}

async function computeRMAudit(date, outletFilter, sharedCtx) {
  const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
  const targetOutlets = outletFilter && outletFilter !== 'all' ? [outletFilter] : outletIds;

  // Only the sales fetch is date-dependent — the rest (recipes/costing/crockery rules) is
  // built once by a range caller and reused, or fetched here for a single-day call. Both
  // legs are still fired concurrently so a single-day call is no slower than before.
  const [sales, ctx] = await Promise.all([
    // order_type + invoice_no are only needed for the crockery/packaging rule below
    // (dine-in item count, distinct pickup/delivery order count) — the recipe path only
    // ever used outlet_code/item_name/item_quantity. category_name is also only for that
    // rule — matching a takeaway line item to its correct container (see
    // TAKEAWAY_CATEGORY_CONTAINERS).
    fetchAllDailySales({ date, select: 'outlet_code, item_name, item_quantity, order_type, invoice_no, category_name' }),
    sharedCtx ? Promise.resolve(sharedCtx) : buildRMAuditSharedCtx(date),
  ]);
  const { recipes, costingContext, crockeryPackagingRules } = ctx;

  const recipeByNormName = {};
  (recipes || []).forEach(r => { recipeByNormName[normalizeDishName(r.item_name)] = r; });

  // For the "ordered but never in any recipe" gap report — resolveIngredientRateId is the
  // actual gate on whether an item can ever get a should-consume figure, regardless of what
  // any recipe's ingredient text says, so "mapped" means "resolvable" here (either a
  // RECIPE_RAW_MATERIAL_MAP override, or a rate-card item a recipe could reference by its
  // own name), not "some recipe happens to mention it by name". recipeIngredientNames is a
  // second, looser signal: if a recipe DOES reference it by name, the fix is a one-line map
  // addition; if not, someone needs to add it to a recipe first.
  const mappedItemIds = new Set([...Object.values(RECIPE_RAW_MATERIAL_MAP), ...Object.keys(costingContext.rateMap), ...Object.keys(costingContext.bkRecipeMap)]);
  const recipeIngredientNames = new Set();
  (recipes || []).forEach(r => (r.recipe_ingredients || []).forEach(ing => {
    if (ing.raw_material) recipeIngredientNames.add(normalizeIngredientName(ing.raw_material));
  }));

  const stockUsage = await computeStockUsageForDate(date, outletFilter, costingContext);
  const actualByOutlet = {};
  stockUsage.outlets.forEach(o => { actualByOutlet[o.outlet_id] = o; });
  const { rateMap, bkRecipeMap, convFactorFor } = costingContext;

  const results = [];
  for (const oid of targetOutlets) {
    const oidSales = (sales || []).filter(s => s.outlet_code === oid);
    const salesByDish = {};
    oidSales.forEach(s => {
      salesByDish[s.item_name] = (salesByDish[s.item_name] || 0) + Number(s.item_quantity || 0);
    });

    const unmatchedDishes = [];
    // normalized raw_material -> { raw_material, unit, qty_kg, qty_count, breakdown: [{dish, qty_sold, per_dish, subtotal}] }
    const theoretical = {};
    Object.entries(salesByDish).forEach(([dishName, qty]) => {
      const recipe = recipeByNormName[normalizeDishName(dishName)];
      if (!recipe) { unmatchedDishes.push({ item_name: dishName, qty }); return; }
      (recipe.recipe_ingredients || []).forEach(ing => {
        const key = normalizeIngredientName(ing.raw_material);
        if (!theoretical[key]) theoretical[key] = { raw_material: ing.raw_material, unit: ing.unit, qty_kg: 0, qty_count: 0, breakdown: [] };
        const perDish = ing.qty_kg != null ? Number(ing.qty_kg) : Number(ing.qty || 0);
        if (ing.qty_kg != null) theoretical[key].qty_kg += perDish * qty;
        else theoretical[key].qty_count += perDish * qty;
        // recipe_ingredient_id lets the owner correct a dish's recipe qty right from this
        // breakdown (PATCH /recipes/ingredients/:id) instead of hunting it down in Dish
        // Recipes — same row this whole "per_dish" figure was read from.
        theoretical[key].breakdown.push({ dish: dishName, qty_sold: qty, per_dish: perDish, subtotal: Math.round(perDish * qty * 1000) / 1000, recipe_ingredient_id: ing.id, recipe_ingredient_unit: ing.unit });
      });
    });

    const actualById = {};
    (actualByOutlet[oid]?.items || []).forEach(it => { actualById[it.item_id] = it; });

    const unmappedIngredients = new Set();
    const recipeItems = Object.values(theoretical).map(t => {
      const key = normalizeIngredientName(t.raw_material);
      const mappedId = resolveIngredientRateId(key, costingContext.rateByName, costingContext.bkRecipeByName);
      if (!mappedId) { unmappedIngredients.add(t.raw_material); return null; }
      const actualItem = actualById[mappedId];
      // Count-based ingredients (qty_kg null) are recorded per-dish in the recipe's own
      // unit (e.g. "Piece" for Spoon) which can be a finer unit than what's actually
      // tracked/priced (e.g. "Pkt" of 100) — convert through unit_conversions before
      // comparing, same as the actual-consumption side already does. Without this,
      // "should consume" silently reports a raw piece count mislabeled with the bulk unit.
      const targetUnit = actualItem?.unit || rateMap[mappedId]?.unit || t.unit;
      const countUnitFactor = t.unit && targetUnit ? convFactorFor(mappedId, targetUnit, t.unit) : 1;
      const shouldConsume = t.qty_kg > 0 ? t.qty_kg : t.qty_count / (countUnitFactor || 1);
      const actualQty = actualItem ? actualItem.used : null;
      const variance = actualQty != null ? Math.round((actualQty - shouldConsume) * 1000) / 1000 : null;
      const variancePct = actualQty != null && shouldConsume > 0 ? Math.round((variance / shouldConsume) * 1000) / 10 : null;
      // Priced independent of whether this item is separately tracked as an outlet demand
      // item (actualItem) — a recipe ingredient's theoretical cost doesn't depend on that,
      // only on having a price. Many BK-prepared Food items (Sambhar, Dosa Batter, chutneys)
      // have no rate_card entry at all — they're priced via BK's own recipe instead, same
      // rate_card-first-then-BK-recipe-fallback rule the rest of the app uses (P&L, dish
      // costing). Falls back to bkRecipeMap's per-Kg cost, matching should_consume's own
      // unit for these items (qty_kg-based). This is what ideal_material_cost below sums.
      const rate = rateMap[mappedId]?.price ?? (t.qty_kg > 0 ? (bkRecipeMap[mappedId]?.costPerKg ?? null) : null);
      return {
        raw_material: t.raw_material,
        item_id: mappedId,
        unit: t.qty_kg > 0 ? 'Kg' : (targetUnit || 'Pcs'),
        should_consume: Math.round(shouldConsume * 1000) / 1000,
        should_consume_breakdown: t.breakdown.sort((a, b) => b.subtotal - a.subtotal),
        rate,
        should_consume_cost: rate != null ? Math.round(shouldConsume * rate * 100) / 100 : null,
        actual_consumed: actualQty != null ? Math.round(actualQty * 1000) / 1000 : null,
        actual_consumed_cost: actualQty != null && rate != null ? Math.round(actualQty * rate * 100) / 100 : null,
        actual_breakdown: actualItem ? {
          prev_closing: actualItem.prev_closing, dispatched: actualItem.dispatched,
          purchased: actualItem.purchased, wastage: actualItem.wastage, closing: actualItem.closing,
        } : null,
        variance, variance_pct: variancePct,
      };
    }).filter(Boolean);

    // REMOVED: a prior version of this function walked INTO BK sub-recipes (e.g. Sambhar's
    // own recipe references Deggi Mirch, Coconut Crush, etc.) to give ingredients like
    // Coconut/Deggi Mirch a should-consume figure instead of "not in any dish recipe".
    // That was conceptually wrong and got reverted: Sambhar/Red Chutney/White Chutney/
    // batters/etc. are all prepared AT BASE KITCHEN and dispatched to outlets as FINISHED
    // goods (confirmed — Sambhar itself already has its own direct, outlet-tracked
    // should-consume entry above, dispatched/closed like any other item). The Deggi Mirch
    // that goes into COOKING Sambhar is consumed at Base Kitchen, not at the outlet — the
    // outlet's own Deggi Mirch stock was never touched to make that Sambhar, so comparing
    // the outlet's real Deggi Mirch usage against "how much Sambhar's recipe implies"
    // compares two unrelated things and produced a plausible-looking but false leak
    // (e.g. Deggi Mirch showing a multi-thousand-percent "leak" at S-56). An ingredient
    // reached only this way now correctly has no should-consume baseline again — same
    // honest "not in any dish recipe, needs wiring" state the Managers Performance /
    // RM Audit unwired-items report already surfaces, rather than a wrong number.
    //
    // Crockery/Packaging — fixed per-item/per-order rule, not recipe-driven (see
    // computeCrockeryPackagingItems above), so it's computed separately and merged in
    // here rather than going through the theoretical/resolveIngredientRateId path above.
    const crockeryPackagingItems = computeCrockeryPackagingItems(oid, oidSales, actualById, rateMap, convFactorFor, crockeryPackagingRules);
    const allItems = [...recipeItems, ...crockeryPackagingItems]
      .sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0));

    // Dish-TYPE match count (dishes_matched/dishes_sold below) can look fine even when a
    // huge chunk of actual VOLUME sold is unmatched — a handful of high-volume dishes with
    // no recipe understates should_consume far more than the type count suggests, which in
    // turn inflates that outlet's leakage % for reasons that have nothing to do with real
    // over-consumption. Surface coverage by volume too, so a low-coverage outlet's numbers
    // aren't compared like-for-like against a high-coverage one.
    const qtySoldTotal = Object.values(salesByDish).reduce((s, q) => s + q, 0);
    const qtySoldUnmatched = unmatchedDishes.reduce((s, d) => s + d.qty, 0);
    const qtySoldMatched = qtySoldTotal - qtySoldUnmatched;

    // Coverage gap report: every item actually consumed today (used_cost > 0 — it was
    // ordered and it left the shelf) that can never get a should-consume figure because
    // it has no RECIPE_RAW_MATERIAL_MAP entry, regardless of today's sales. Distinct from
    // unmapped_ingredients above, which only covers ingredients of DISHES SOLD TODAY —
    // this catches items with zero recipe path at all, any day.
    const neverMappedItems = Object.values(actualById)
      .filter(it => (it.used_cost || 0) > 0 && !mappedItemIds.has(it.item_id))
      .map(it => ({
        item_id: it.item_id, name: it.name, category: it.category, unit: it.unit,
        used: it.used, used_cost: it.used_cost,
        referenced_in_recipe: recipeIngredientNames.has(normalizeIngredientName(it.name)),
      }))
      .sort((a, b) => b.used_cost - a.used_cost);

    // Ideal Material Cost — the actual "what should today's material cost have been"
    // figure: every dish sold today, priced through its full recipe at rate card, summed.
    // Deliberately NOT filtered to items that also happen to be tracked as this outlet's
    // own demand items (unlike should_consume_actual_cost elsewhere) — a recipe
    // ingredient's theoretical cost doesn't depend on whether it's separately punched as
    // a demand line, only on whether it resolves to a price at all (see
    // resolveIngredientRateId). Items that don't (should_consume_cost null) are simply
    // excluded, same gap the never_mapped_items/unmapped_ingredients reports above surface
    // for fixing.
    const idealMaterialCost = allItems.reduce((s, it) => s + (it.should_consume_cost || 0), 0);
    // Actual side of the same comparison — what these items' ACTUAL consumption cost,
    // priced the same way (rate card / BK recipe cost) ideal_material_cost already is.
    // Used by the outlet Performance Dashboard's COGS Score: how close actual landed to
    // ideal, both expressed as a share of that day's effective sale.
    const actualMaterialCost = allItems.reduce((s, it) => s + (it.actual_consumed_cost || 0), 0);

    results.push({
      outlet_id: oid, date,
      items: allItems,
      unmatched_dishes: unmatchedDishes.sort((a, b) => b.qty - a.qty),
      unmapped_ingredients: [...unmappedIngredients],
      never_mapped_items: neverMappedItems,
      ideal_material_cost: Math.round(idealMaterialCost * 100) / 100,
      actual_material_cost: Math.round(actualMaterialCost * 100) / 100,
      dishes_sold: Object.keys(salesByDish).length,
      dishes_matched: Object.keys(salesByDish).length - unmatchedDishes.length,
      // Full list of dish names sold, so a range merge can count DISTINCT dish types across
      // the whole window (a union) instead of summing per-day counts, which would double-
      // count anything sold on more than one day.
      dish_names: Object.keys(salesByDish),
      sales_qty_total: qtySoldTotal,
      sales_qty_matched: qtySoldMatched,
      sales_coverage_pct: qtySoldTotal > 0 ? Math.round((qtySoldMatched / qtySoldTotal) * 1000) / 10 : null,
    });
  }
  return results;
}

// ────────────────────────────────────────────────────────────
// Range/month RM Audit — sum of daily audits, NOT a single range-level query.
// This is the same rule every other monthly figure in this app already uses (see the long
// comment on computeStockUsageForDate): a range's actual consumption is the SUM of each
// day's own opening→closing consumption, which telescopes correctly (each day's opening =
// the prior day's closing, so the intermediate closings cancel and only the range's first
// opening and last closing survive). Summing the daily should-consume (sales × recipe) and
// daily leakage is likewise exact. costingContext/recipes/crockery rules are built ONCE and
// reused across every day; days run at bounded concurrency, matching finance.js's month
// aggregation rather than bursting every day's queries in one tick.
const RM_AUDIT_DAY_CONCURRENCY = 5;
function rmAuditDaysInRange(from, to) {
  const days = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return days;
}
async function rmAuditMapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const r2 = (n) => Math.round(n * 100) / 100;   // money
const r3 = (n) => Math.round(n * 1000) / 1000; // qty

async function computeRMAuditRange(from, to, outletFilter) {
  const days = rmAuditDaysInRange(from, to);
  if (days.length === 0) return [];
  // Ledger + recipes loaded ONCE (undated). Each day re-prices its costing context in
  // memory via withDate(ds) so that day's leakage is valued at the prices in effect then —
  // a mid-range price change shows up as a real step in per-day cost, and the total is the
  // honest sum of each day's own-priced audit.
  const sharedCtx = await buildRMAuditSharedCtx();
  const dayResults = await rmAuditMapWithConcurrency(days, RM_AUDIT_DAY_CONCURRENCY, (ds) =>
    computeRMAudit(ds, outletFilter, { ...sharedCtx, costingContext: sharedCtx.costingContext.withDate(ds) }));

  // Merge each outlet's per-day audits into one aggregate for the whole window.
  const byOutlet = {}; // outlet_id -> aggregate accumulator
  const ensure = (oid) => {
    if (!byOutlet[oid]) byOutlet[oid] = {
      outlet_id: oid,
      items: {},              // raw_material -> merged item accumulator
      dishNames: new Set(),   // all dish types sold across the window
      unmatched: {},          // dish name -> summed qty (union across days)
      unmapped: new Set(),
      neverMapped: {},        // item_id -> merged accumulator
      ideal_material_cost: 0,
      actual_material_cost: 0,
      sales_qty_total: 0,
      sales_qty_matched: 0,
    };
    return byOutlet[oid];
  };

  dayResults.forEach((outlets) => {
    (outlets || []).forEach((o) => {
      const acc = ensure(o.outlet_id);
      (o.dish_names || []).forEach((n) => acc.dishNames.add(n));
      (o.unmatched_dishes || []).forEach((d) => { acc.unmatched[d.item_name] = (acc.unmatched[d.item_name] || 0) + (d.qty || 0); });
      (o.unmapped_ingredients || []).forEach((n) => acc.unmapped.add(n));
      (o.never_mapped_items || []).forEach((it) => {
        const cur = acc.neverMapped[it.item_id] || { ...it, used: 0, used_cost: 0 };
        cur.used += it.used || 0;
        cur.used_cost += it.used_cost || 0;
        cur.referenced_in_recipe = cur.referenced_in_recipe || it.referenced_in_recipe;
        acc.neverMapped[it.item_id] = cur;
      });
      acc.ideal_material_cost += o.ideal_material_cost || 0;
      acc.actual_material_cost += o.actual_material_cost || 0;
      acc.sales_qty_total += o.sales_qty_total || 0;
      acc.sales_qty_matched += o.sales_qty_matched || 0;

      (o.items || []).forEach((it) => {
        let m = acc.items[it.raw_material];
        if (!m) {
          m = acc.items[it.raw_material] = {
            raw_material: it.raw_material, item_id: it.item_id, unit: it.unit, rate: it.rate,
            should_consume: 0, should_consume_cost: 0,
            actual_consumed: 0, actual_consumed_cost: 0, hasActual: false,
            ab: { prev_closing: 0, dispatched: 0, purchased: 0, wastage: 0, closing: 0 }, hasAb: false,
            breakdown: {}, // dish -> merged should-consume breakdown row
          };
        }
        m.should_consume += it.should_consume || 0;
        if (it.should_consume_cost != null) m.should_consume_cost += it.should_consume_cost;
        // actual_consumed is null on days with no closing data — those days contribute
        // nothing (same "missing closing = 0" convention P&L/single-day audit use), but the
        // aggregate is only marked "has actual" if at least one day actually had it, so an
        // item with no closing data all window still reads "no closing stock data" rather
        // than a misleading 0.
        if (it.actual_consumed != null) {
          m.hasActual = true;
          m.actual_consumed += it.actual_consumed;
          if (it.actual_consumed_cost != null) m.actual_consumed_cost += it.actual_consumed_cost;
        }
        if (it.actual_breakdown) {
          m.hasAb = true;
          m.ab.prev_closing += it.actual_breakdown.prev_closing || 0;
          m.ab.dispatched += it.actual_breakdown.dispatched || 0;
          m.ab.purchased += it.actual_breakdown.purchased || 0;
          m.ab.wastage += it.actual_breakdown.wastage || 0;
          m.ab.closing += it.actual_breakdown.closing || 0;
        }
        (it.should_consume_breakdown || []).forEach((b) => {
          const key = b.dish;
          const bd = m.breakdown[key] || { ...b, qty_sold: 0, subtotal: 0 };
          bd.qty_sold += b.qty_sold || 0;
          bd.subtotal += b.subtotal || 0;
          m.breakdown[key] = bd;
        });
      });
    });
  });

  // Finalize each outlet: turn accumulators back into the exact same shape a single-day
  // computeRMAudit returns, so the frontend renders a range identically to one day.
  return Object.values(byOutlet).map((acc) => {
    const items = Object.values(acc.items).map((m) => {
      const should = r3(m.should_consume);
      const actual = m.hasActual ? r3(m.actual_consumed) : null;
      const variance = actual != null ? r3(actual - should) : null;
      const variancePct = actual != null && should > 0 ? Math.round(((actual - should) / should) * 1000) / 10 : null;
      return {
        raw_material: m.raw_material, item_id: m.item_id, unit: m.unit, rate: m.rate,
        should_consume: should,
        should_consume_cost: r2(m.should_consume_cost),
        should_consume_breakdown: Object.values(m.breakdown)
          .map((b) => ({ ...b, qty_sold: r3(b.qty_sold), subtotal: r3(b.subtotal) }))
          .sort((a, b) => b.subtotal - a.subtotal),
        actual_consumed: actual,
        actual_consumed_cost: m.hasActual ? r2(m.actual_consumed_cost) : null,
        actual_breakdown: m.hasAb ? {
          prev_closing: r3(m.ab.prev_closing), dispatched: r3(m.ab.dispatched),
          purchased: r3(m.ab.purchased), wastage: r3(m.ab.wastage), closing: r3(m.ab.closing),
        } : null,
        variance, variance_pct: variancePct,
      };
    }).sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0));

    const unmatched = Object.entries(acc.unmatched).map(([item_name, qty]) => ({ item_name, qty })).sort((a, b) => b.qty - a.qty);
    const dishesSold = acc.dishNames.size;
    const dishesMatched = dishesSold - unmatched.length;
    return {
      outlet_id: acc.outlet_id, date: `${from}..${to}`,
      items,
      unmatched_dishes: unmatched,
      unmapped_ingredients: [...acc.unmapped],
      never_mapped_items: Object.values(acc.neverMapped)
        .map((it) => ({ ...it, used: r3(it.used), used_cost: r2(it.used_cost) }))
        .sort((a, b) => b.used_cost - a.used_cost),
      ideal_material_cost: r2(acc.ideal_material_cost),
      actual_material_cost: r2(acc.actual_material_cost),
      dishes_sold: dishesSold,
      dishes_matched: dishesMatched,
      sales_qty_total: acc.sales_qty_total,
      sales_qty_matched: acc.sales_qty_matched,
      sales_coverage_pct: acc.sales_qty_total > 0 ? Math.round((acc.sales_qty_matched / acc.sales_qty_total) * 1000) / 10 : null,
    };
  });
}

// Raw-material-id → rate-card id, for BK-prepared items' OWN ingredients (Dosa Batter's
// rice/urad dal/etc, not the dish's ingredients). This is a separate, deliberate copy of
// the mapping the live P&L uses internally (KNOWN_MAPPINGS, inside GET /pnl/live/:date)
// rather than a shared import — P&L pricing is safety-critical (real money, tied to actual
// dispatch that day), so this dish-costing tool (a "what would this cost right now"
// browsing calculator, decoupled from any day's dispatch) is kept intentionally
// independent of it. buildCostingContext()'s rawToRate is a third, equally-independent copy
// (that function feeds RM Audit / Finance / stock-usage, so it gets the same isolation).
// All three are currently byte-identical; if you add/change an item, mirror it in the
// other two by hand — do not alias these into a shared object.
const BK_INGREDIENT_TO_RATE = {
  amchoor_raw: 'amchoor_powder', arhar_dal_raw: 'arhar_dal', besan: 'besan',
  chana_dal_raw: 'chana_dal', coconut_crush_raw: 'coconut_crush', coconut_raw: 'coconut',
  coriander_raw: 'coriander_leaves', curry_leaves_raw: 'curry_leaves',
  deggi_mirch_raw: 'deggi_mirch', desi_ghee_raw: 'desi_ghee',
  dhaniya_whole_raw: 'dhaniya_whole', drumstick_raw: 'drumstick',
  fortune_refined_raw: 'fortune_refined', garam_masala_raw: 'garam_masala',
  garlic_raw: 'garlic', ginger_raw: 'ginger', golden_sela_rice: 'golden_sela_rice',
  green_chilli_raw: 'green_chillies', gur_raw: 'gur',
  haldi_raw: 'haldi_powder', hing_raw: 'hing_powder',
  ilaychi_raw: 'ilaychi', imli_raw: 'imli',
  jeera_raw: 'jeera', kaju_raw: 'kaju', kali_mirch_raw: 'kali_mirch',
  kesar_raw: 'kesar', kishmish_raw: 'kishmish',
  meetha_soda_raw: 'meetha_soda', methi_dana_raw: 'methi_dana',
  milk_raw: 'milk', milkmaid_raw: 'milkmaid', mint_raw: 'mint',
  mustard_raw: 'mustard_seeds', onions_raw: 'onions',
  peanuts_raw: 'peanuts', petha_raw: 'petha', pineapple_raw: 'pineapple',
  poha_raw: 'poha', red_chilli_powder_raw: 'red_chilli_powder',
  rice_powder_raw: 'rice_powder', roasted_chana_raw: 'roasted_chana',
  roasted_karipatta_raw: 'roasted_karipatta', roasted_peanuts_raw: 'roasted_peanuts',
  safed_til_raw: 'safed_til', salt_raw: 'salt',
  sambhar_masala_raw: 'sambhar_masala_777', semiyan_raw: 'semiyan',
  sona_masoori_raw: 'sona_masoori_rice', sugar_raw: 'sugar',
  tadka_raw: 'tadka', tomatoes_raw: 'tomatoes',
  upma_sooji_raw: 'upma_sooji', urad_daal: 'urad_daal_whole',
  whole_red_chilli_raw: 'whole_red_chilli',
};

const PIECE_UNITS = new Set(['piece', 'pcs', 'pc']);
// Trailing period stripped before comparing — a recipe entering "Ltr." where the rate card
// says "Ltr" is the same unit, just punctuated differently, not an actual mismatch.
function unitsCompatible(a, b) {
  const ua = (a || '').toLowerCase().replace(/\.+$/, ''), ub = (b || '').toLowerCase().replace(/\.+$/, '');
  if (ua === ub) return true;
  return PIECE_UNITS.has(ua) && PIECE_UNITS.has(ub);
}

// Cost of one dish, ingredient by ingredient, at CURRENT rate card prices — not tied to any
// day's dispatch (that's what P&L's variable cost is for). Two-level lookup, same precedence
// P&L uses: a dish ingredient (e.g. "Dosa Batter") is priced directly if the rate card has it;
// otherwise, if it's itself a BK-prepared recipe, its cost is derived from ITS ingredients
// (BK_INGREDIENT_TO_RATE) divided by the BK recipe's yield. Anything neither of those two can
// resolve is reported as unpriced rather than guessed.
// Builds a memoized "cost per 1 unit of yield" lookup for BK-prepared items (Dosa Batter,
// Sambhar, chutneys), shared across every dish being costed in one call so a BK item used
// by many dishes (e.g. Dosa Batter) is only priced once, not once per dish. An ingredient
// can itself be another BK recipe's output (e.g. a combo recipe using Dosa Batter) — priced
// recursively via that recipe's own cost per Kg, with `visited` guarding a circular
// reference (A uses B uses A) from recursing forever.
function buildBkCostLookup(rateMap, bkRecipes, bkIngredientsByRecipe) {
  const cache = {};
  const resolve = (bkId, visited) => {
    if (cache[bkId] !== undefined) return cache[bkId];
    const bk = (bkRecipes || []).find(r => r.id === bkId);
    if (!bk || visited.has(bkId)) return null;
    const nextVisited = new Set(visited); nextVisited.add(bkId);
    let total = 0;
    (bkIngredientsByRecipe[bkId] || []).forEach(ing => {
      const rmId = ing.raw_material_id;
      const rateId = rateMap[rmId] ? rmId : (BK_INGREDIENT_TO_RATE[rmId] && rateMap[BK_INGREDIENT_TO_RATE[rmId]] ? BK_INGREDIENT_TO_RATE[rmId] : null);
      if (rateId) {
        total += Number(ing.qty || 0) * Number(rateMap[rateId].price);
      } else if (rmId !== bkId && (bkRecipes || []).some(r => r.id === rmId)) {
        const nested = resolve(rmId, nextVisited);
        if (nested) total += Number(ing.qty || 0) * nested.perUnit;
      }
    });
    const yieldQty = Number(bk.yield_qty) || 1;
    const result = { perUnit: yieldQty > 0 ? total / yieldQty : 0, unit: bk.yield_unit };
    cache[bkId] = result;
    return result;
  };
  return (bkId) => resolve(bkId, new Set());
}

// Pure per-recipe costing — no DB calls — so it can run once per dish inside a bulk loop
// without re-fetching rate_card/bk_recipes for every dish.
// `dishCostLookup`, if given, is called with the raw ingredient text as a last resort when
// nothing else resolves — lets a combo dish (e.g. "Lemon Rice And Filter Coffee") use
// another whole dish recipe (e.g. "Lemon Rice") as one of its own ingredients, priced at
// that dish's own total_cost per serving. qty is treated as a serving multiplier (qty 1 =
// one full serving of the nested dish included in this combo), not a weight/volume amount.
function costRecipeIngredients(recipeIngredients, rateMap, bkCostPerUnit, rateByName, convMap, dishCostLookup, bkRecipeByName) {
  const ingredients = (recipeIngredients || []).map(ing => {
    const key = normalizeIngredientName(ing.raw_material);
    const mappedId = resolveIngredientRateId(key, rateByName || {}, bkRecipeByName);
    // Exposed so the frontend's "Add Price"/"Add Recipe" shortcut (Item-wise Sales'
    // ingredient breakdown) knows what id to save under — RECIPE_RAW_MATERIAL_MAP already
    // has a manual entry for most known-unpriced BK Food items (e.g. aloo_masala), so a new
    // rate_card/bk_recipes row using this exact id is picked up immediately, no redeploy
    // needed. Genuinely novel ingredient names (mappedId null) fall back to name-matching —
    // see the "Add Price" handler, which sets the new row's `name` to match `raw_material`.
    const base = { id: ing.id, raw_material: ing.raw_material, qty: ing.qty, unit: ing.unit, mapped_id: mappedId };

    if (!mappedId) {
      const nestedDish = dishCostLookup && dishCostLookup(ing.raw_material);
      if (nestedDish) {
        const servings = Number(ing.qty) || 1;
        return { ...base, priced: true, rate: nestedDish.total_cost, rate_unit: 'serving', cost: Math.round(servings * nestedDish.total_cost * 100) / 100, via_dish_recipe: true };
      }
      return { ...base, priced: false, reason: 'not linked to any rate card item or BK recipe', cost: null, rate: null };
    }

    if (rateMap[mappedId]) {
      const rate = rateMap[mappedId];
      let qty = Number(ing.qty || 0), unit = ing.unit;
      const u = (unit || '').toLowerCase(), ru = (rate.unit || '').toLowerCase();
      // 1. Try the plain SI step first (Gm->Kg, Ml->Ltr) — resolves the common case (e.g.
      // Haldi Powder: recipe in Gm, priced per Kg) without ever consulting unit_conversions,
      // even if this same item also happens to have an unrelated bulk-unit conversion row
      // (Haldi's own is "1 Pkt = 500 Gm", irrelevant here since the rate card unit is Kg).
      let siApplied = false;
      if (u === 'gm' && ru === 'kg') { qty = qty / 1000; unit = 'Kg'; siApplied = true; }
      else if (u === 'ml' && (ru === 'ltr' || ru === 'ltr.')) { qty = qty / 1000; unit = 'Ltr'; siApplied = true; }
      // 2. Only if the SI step didn't apply, chain through unit_conversions instead — e.g.
      // Papad entering "Piece" while priced per "Pkt" (1 Pkt = 200 Pcs), or Coconut entering
      // "Gm" (crushed) while priced per "Pcs" (1 Pc = 200 Gm crushed). Whichever side of the
      // conversion (fromUnit or baseUnit) the recipe's own unit matches, convert onto the
      // other side — Piece/Pcs/Pc are treated as the same unit here too.
      if (!siApplied) {
        const conv = convMap && convMap[mappedId];
        if (conv) {
          const convFrom = (conv.fromUnit || '').toLowerCase();
          const convBase = (conv.baseUnit || '').toLowerCase();
          if (u === convFrom || (PIECE_UNITS.has(u) && PIECE_UNITS.has(convFrom))) {
            qty *= Number(conv.qty) || 1; unit = conv.baseUnit;
          } else if (u === convBase || (PIECE_UNITS.has(u) && PIECE_UNITS.has(convBase))) {
            qty /= Number(conv.qty) || 1; unit = conv.fromUnit;
          }
        }
      }
      if (!unitsCompatible(unit, rate.unit)) {
        return { ...base, priced: false, reason: `priced per ${rate.unit}, recipe uses ${ing.unit} — conversion not configured`, cost: null, rate: rate.price, rate_unit: rate.unit };
      }
      return { ...base, priced: true, rate: rate.price, rate_unit: rate.unit, cost: Math.round(qty * rate.price * 100) / 100, rate_card_id: mappedId };
    }

    const bk = bkCostPerUnit(mappedId);
    if (bk && bk.perUnit > 0) {
      const qtyKg = ing.qty_kg != null ? Number(ing.qty_kg) : Number(ing.qty || 0) / 1000;
      return { ...base, priced: true, rate: Math.round(bk.perUnit * 100) / 100, rate_unit: bk.unit, cost: Math.round(qtyKg * bk.perUnit * 100) / 100, via_bk_recipe: true };
    }
    return { ...base, priced: false, reason: 'no rate card price and no BK recipe found', cost: null, rate: null };
  });

  const totalCost = ingredients.reduce((s, i) => s + (i.cost || 0), 0);
  return { ingredients, total_cost: Math.round(totalCost * 100) / 100, unpriced_count: ingredients.filter(i => !i.priced).length };
}

async function loadCostingContext() {
  const [{ data: rates }, { data: bkRecipes }, { data: bkIngredients }, { data: unitConversions }] = await Promise.all([
    supabase.from('rate_card').select('*').eq('active', true),
    supabase.from('bk_recipes').select('*'),
    supabase.from('bk_recipe_ingredients').select('*'),
    supabase.from('unit_conversions').select('*').eq('active', true),
  ]);
  const rateMap = {};
  const rateByName = {};
  (rates || []).forEach(r => { rateMap[r.id] = r; rateByName[normalizeIngredientName(r.name)] = r.id; });
  const bkRecipeByName = {};
  // `active !== false` (not a strict `=== true`) since the column defaults null/undefined
  // on older rows that predate soft-delete — only an explicit false (a real DELETE
  // /master/recipes/:id) should exclude a recipe from being found by name here.
  (bkRecipes || []).filter(r => r.active !== false).forEach(r => { bkRecipeByName[normalizeIngredientName(r.name)] = r.id; });
  const bkIngredientsByRecipe = {};
  (bkIngredients || []).forEach(i => { (bkIngredientsByRecipe[i.recipe_id] = bkIngredientsByRecipe[i.recipe_id] || []).push(i); });
  const convMap = {};
  (unitConversions || []).forEach(c => { convMap[c.item_id] = { fromUnit: c.unit_type, qty: Number(c.qty), baseUnit: c.base_unit }; });
  return { rateMap, rateByName, bkRecipeByName, convMap, bkCostPerUnit: buildBkCostLookup(rateMap, bkRecipes, bkIngredientsByRecipe) };
}

// Recursive, memoized dish-cost resolver — lets a combo dish (e.g. "Lemon Rice And Filter
// Coffee") use another dish recipe (e.g. "Lemon Rice") as one of its own ingredients,
// looked up by name (see costRecipeIngredients' dishCostLookup param). `visited` guards a
// circular reference (A includes B includes A) from recursing forever.
function buildDishCostLookup(recipesByNormName, rateMap, bkCostPerUnit, rateByName, convMap, bkRecipeByName) {
  const cache = {};
  const resolve = (dishName, visited) => {
    const norm = normalizeDishName(dishName);
    if (cache[norm] !== undefined) return cache[norm];
    const recipe = recipesByNormName[norm];
    if (!recipe || visited.has(norm)) return (cache[norm] = null);
    const nextVisited = new Set(visited); nextVisited.add(norm);
    const costed = costRecipeIngredients(recipe.recipe_ingredients, rateMap, bkCostPerUnit, rateByName, convMap, (name) => resolve(name, nextVisited), bkRecipeByName);
    cache[norm] = costed;
    return costed;
  };
  return (dishName) => resolve(dishName, new Set());
}

async function computeDishCost(recipeId) {
  const [{ data: recipe }, { data: allRecipes }, costingContext] = await Promise.all([
    supabase.from('recipes').select('id, item_name, recipe_ingredients ( id, raw_material, qty, unit, qty_kg )').eq('id', recipeId).single(),
    supabase.from('recipes').select('id, item_name, recipe_ingredients ( id, raw_material, qty, unit, qty_kg )').eq('status', 'Active'),
    loadCostingContext(),
  ]);
  if (!recipe) return null;
  const { rateMap, rateByName, bkRecipeByName, convMap, bkCostPerUnit } = costingContext;
  const recipesByNormName = {};
  (allRecipes || []).forEach(r => { if (r.id !== recipeId) recipesByNormName[normalizeDishName(r.item_name)] = r; });
  const dishCostLookup = buildDishCostLookup(recipesByNormName, rateMap, bkCostPerUnit, rateByName, convMap, bkRecipeByName);
  const costed = costRecipeIngredients(recipe.recipe_ingredients, rateMap, bkCostPerUnit, rateByName, convMap, dishCostLookup, bkRecipeByName);
  return { item_name: recipe.item_name, ...costed };
}

// Cost for every active dish at once, keyed by normalized dish name — lets a sales table
// (many item rows) show cost-per-item without one API round trip per row.
async function computeAllDishCosts() {
  const { data: recipes } = await supabase.from('recipes')
    .select('id, item_name, recipe_ingredients ( id, raw_material, qty, unit, qty_kg )').eq('status', 'Active');
  const { rateMap, rateByName, bkRecipeByName, convMap, bkCostPerUnit } = await loadCostingContext();
  const recipesByNormName = {};
  (recipes || []).forEach(r => { recipesByNormName[normalizeDishName(r.item_name)] = r; });
  const dishCostLookup = buildDishCostLookup(recipesByNormName, rateMap, bkCostPerUnit, rateByName, convMap, bkRecipeByName);
  const byNormName = {};
  (recipes || []).forEach(r => {
    const costed = costRecipeIngredients(r.recipe_ingredients, rateMap, bkCostPerUnit, rateByName, convMap, dishCostLookup, bkRecipeByName);
    byNormName[normalizeDishName(r.item_name)] = { item_name: r.item_name, ...costed };
  });
  return byNormName;
}

// Recent actual selling price for a dish, straight from uploaded sales rows — not a
// configured/static "menu price" field (the system doesn't have one), so this is always
// derived from what it was actually sold for, most recently, across any outlet/channel.
async function getSellingPriceInfo(itemName) {
  const { data } = await supabase.from('daily_sales')
    .select('sale_date, item_price')
    .ilike('item_name', itemName)
    .order('sale_date', { ascending: false })
    .limit(50);
  const prices = (data || []).map(d => Number(d.item_price)).filter((p) => p > 0);
  if (prices.length === 0) return null;
  return {
    latest: prices[0],
    latest_date: data[0].sale_date,
    min: Math.min(...prices),
    max: Math.max(...prices),
    sample_count: prices.length,
  };
}

// ────────────────────────────────────────────────────────────
// POST /api/issuance-audit — Save issuance audit entries
// ────────────────────────────────────────────────────────────
router.post('/issuance-audit', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { entries } = req.body;
if (!entries || entries.length === 0) return res.status(400).json({ error: 'No entries' });

const rows = entries.map(e => ({
item_id: e.item_id,
item_name: e.item_name,
calculated_qty: e.calculated_qty,
issued_qty: e.issued_qty,
variance: e.variance,
source: e.source || 'recipe',
audit_date: e.date || todayIST(),
}));

const { error } = await supabase.from('issuance_audit').insert(rows);
if (error) throw error;

res.json({ success: true, count: rows.length });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ────────────────────────────────────────────────────────────
// GET /api/issuance-audit/:date — Get issuance audit for a date
// ────────────────────────────────────────────────────────────
router.get('/issuance-audit/:date', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { date } = req.params;
const { data, error } = await supabase
.from('issuance_audit')
.select('*')
.eq('audit_date', date)
.order('created_at', { ascending: false });

if (error) throw error;
res.json(data || []);
} catch (err) {
res.status(500).json({ error: err.message });
}
});
// ============================================================
// MASTER DATA API ROUTES — Add to salesRoutes.js
// Paste at the bottom before module.exports = router;
// ============================================================

// ── GET /api/master/sections — All demand sections with items
router.get('/master/sections', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { data: sections } = await supabase.from('demand_sections').select('*').order('sort_order');
const { data: items } = await supabase.from('demand_items').select('*').eq('active', true).order('sort_order');
const result = (sections || []).map(sec => ({
...sec,
items: (items || []).filter(i => i.section_id === sec.id)
}));
res.json(result);
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/master/raw-materials
router.get('/master/raw-materials', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { data } = await supabase.from('raw_materials').select('*').eq('active', true).order('name');
res.json(data || []);
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/master/recipes — All recipes with ingredients
router.get('/master/recipes', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { data: recipes } = await supabase.from('bk_recipes').select('*').eq('active', true);
const { data: ingredients } = await supabase.from('bk_recipe_ingredients').select('*');
const result = {};
(recipes || []).forEach(r => {
result[r.id] = {
name: r.name,
yield: r.yield_label || `${r.yield_qty} ${r.yield_unit}`,
yieldQty: Number(r.yield_qty),
ingredients: (ingredients || []).filter(i => i.recipe_id === r.id).map(i => ({
rawId: i.raw_material_id,
qty: Number(i.qty)
}))
};
});
res.json(result);
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/master/demand-items — Add new demand item
router.post('/master/demand-items', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { id, section_id, name, unit, sort_order } = req.body;
const { data, error } = await supabase.from('demand_items').upsert({ id, section_id, name, unit, sort_order: sort_order || 99 });
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/master/demand-items/:id — Update demand item
router.patch('/master/demand-items/:id', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { name, unit, sort_order, active } = req.body;
const updates = {};
if (name !== undefined) updates.name = name;
if (unit !== undefined) updates.unit = unit;
if (sort_order !== undefined) updates.sort_order = sort_order;
if (active !== undefined) updates.active = active;
const { error } = await supabase.from('demand_items').update(updates).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/master/demand-items/:id — Soft delete
router.delete('/master/demand-items/:id', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { error } = await supabase.from('demand_items').update({ active: false }).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/master/raw-materials — Add new raw material
router.post('/master/raw-materials', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { id, name, unit } = req.body;
const { error } = await supabase.from('raw_materials').upsert({ id, name, unit });
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/master/raw-materials/:id — Update raw material
router.patch('/master/raw-materials/:id', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { name, unit, active } = req.body;
const updates = {};
if (name !== undefined) updates.name = name;
if (unit !== undefined) updates.unit = unit;
if (active !== undefined) updates.active = active;
const { error } = await supabase.from('raw_materials').update(updates).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/master/raw-materials/:id — Soft delete
router.delete('/master/raw-materials/:id', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { error } = await supabase.from('raw_materials').update({ active: false }).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/master/recipes — Add/update recipe
router.post('/master/recipes', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { id, name, yield_qty, yield_unit, yield_label, ingredients } = req.body;
// Upsert recipe header
const { error: recErr } = await supabase.from('bk_recipes').upsert({ id, name, yield_qty, yield_unit: yield_unit || 'Kg', yield_label });
if (recErr) throw recErr;
// Replace ingredients
await supabase.from('bk_recipe_ingredients').delete().eq('recipe_id', id);
if (ingredients && ingredients.length > 0) {
const rows = ingredients.map(i => ({ recipe_id: id, raw_material_id: i.rawId, qty: i.qty }));
const { error: ingErr } = await supabase.from('bk_recipe_ingredients').insert(rows);
if (ingErr) throw ingErr;
}
// The recipe module is the single control point for its own bulk-unit conversion too —
// a yield label like "2 Kg (1 Batch)" already encodes "1 Batch = 2 Kg" by the existing
// naming convention (see Dosa/Idli/Vada Batter). Parse it out and keep unit_conversions
// in sync automatically on every save, so editing the yield here is enough instead of
// also needing a separate, easy-to-forget edit in Master Data > Conversions.
const bulkMatch = (yield_label || '').match(/\(\s*\d+(?:\.\d+)?\s+([A-Za-z]+)\s*\)/);
if (bulkMatch && yield_qty && yield_unit) {
  const bulkUnit = bulkMatch[1];
  const { error: convErr } = await supabase.from('unit_conversions').upsert(
    { unit_type: bulkUnit, item_id: id, item_name: name, qty: yield_qty, base_unit: yield_unit, notes: `1 ${bulkUnit} = ${yield_qty} ${yield_unit}` },
    { onConflict: 'unit_type,item_id' }
  );
  if (convErr) console.error('Recipe-linked unit conversion sync failed:', convErr.message);
}
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/master/recipes/:id
router.delete('/master/recipes/:id', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
await supabase.from('bk_recipe_ingredients').delete().eq('recipe_id', req.params.id);
const { error } = await supabase.from('bk_recipes').update({ active: false }).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});
// ============================================================
// UNIT CONVERSIONS API ROUTES — Add to salesRoutes.js
// Paste before module.exports = router;
// ============================================================

// ── GET /api/master/conversions — All conversions grouped by unit type
router.get('/master/conversions', async (req, res) => {
try {
    // Read-only and not price-sensitive (just unit definitions like "1 Tin = 15 Kg") —
    // any logged-in user can read this; outlet managers need it for the unit picker on
    // demand/closing-stock/wastage forms. Only mutations below stay owner-only.
    if (!await requireAuth(req, res)) return;
const { data } = await supabase.from('unit_conversions').select('*').eq('active', true).order('unit_type').order('item_name');
const grouped = {};
(data || []).forEach(row => {
if (!grouped[row.unit_type]) grouped[row.unit_type] = [];
grouped[row.unit_type].push({
item_id: row.item_id,
item_name: row.item_name,
qty: Number(row.qty),
base_unit: row.base_unit,
notes: row.notes
});
});
res.json(grouped);
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/master/conversions — Add/update a conversion
router.post('/master/conversions', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { unit_type, item_id, item_name, qty, base_unit, notes } = req.body;
const { error } = await supabase.from('unit_conversions').upsert(
{ unit_type, item_id, item_name, qty, base_unit, notes: notes || `1 ${unit_type} = ${qty} ${base_unit}` },
{ onConflict: 'unit_type,item_id' }
);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/master/conversions/:id — Update conversion qty
router.patch('/master/conversions', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { unit_type, item_id, qty, base_unit, notes } = req.body;
const updates = {};
if (qty !== undefined) updates.qty = qty;
if (base_unit !== undefined) updates.base_unit = base_unit;
if (notes !== undefined) updates.notes = notes;
const { error } = await supabase.from('unit_conversions').update(updates)
.eq('unit_type', unit_type).eq('item_id', item_id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/master/conversions — Soft delete
router.delete('/master/conversions', async (req, res) => {
try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
const { unit_type, item_id } = req.query;
const { error } = await supabase.from('unit_conversions').update({ active: false })
.eq('unit_type', unit_type).eq('item_id', item_id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});
// ============================================================
// DAILY OUTLET SALES & CASH RECONCILIATION
// Add to salesRoutes.js before module.exports = router;
// ============================================================

// Cascades a corrected closing balance forward through subsequent EXISTING rows for
// this outlet, so later days' prev_day_cash/closing stay consistent after an earlier
// day's cash_deposited changes — e.g. recording a collection for a past date shouldn't
// leave every later day showing a stale, pre-collection "available cash". Only walks
// through rows that actually exist (gap days need no update — the next real row already
// carries the balance via its own prev_day_cash once corrected). Stops early once a
// row's stored prev_day_cash already matches the computed balance, since anything
// after that should already be consistent from a prior cascade.
async function cascadeCashForward(supabase, outletId, fromDate) {
  const { data: seed } = await supabase.from('daily_outlet_sales').select('*')
    .eq('outlet_id', outletId).eq('date', fromDate).maybeSingle();
  if (!seed) return;
  let balance = Number(seed.prev_day_cash || 0) + Number(seed.cash_collected || 0) - Number(seed.cash_expense || 0) - Number(seed.cash_deposited || 0);
  let cursorDate = fromDate;
  for (let i = 0; i < 180; i++) {
    const { data: nextRow } = await supabase.from('daily_outlet_sales').select('*')
      .eq('outlet_id', outletId).gt('date', cursorDate).order('date', { ascending: true }).limit(1).maybeSingle();
    if (!nextRow) break;
    if (Number(nextRow.prev_day_cash || 0) === balance) break;
    await supabase.from('daily_outlet_sales').update({ prev_day_cash: balance }).eq('outlet_id', outletId).eq('date', nextRow.date);
    balance = balance + Number(nextRow.cash_collected || 0) - Number(nextRow.cash_expense || 0) - Number(nextRow.cash_deposited || 0);
    cursorDate = nextRow.date;
  }
}

// After a sales row is moved away from `removedDate` (see /move-submission-date), the
// row that used to follow it — if any — has a stale prev_day_cash pointing at a balance
// that no longer exists there. Re-seed the cascade from whatever row now precedes the
// gap (or zero it out if removedDate was this outlet's very first row) so the chain
// stays consistent with the row actually gone.
async function recascadeAfterRemoval(supabase, outletId, removedDate) {
  const { data: prevRow } = await supabase.from('daily_outlet_sales').select('date')
    .eq('outlet_id', outletId).lt('date', removedDate).order('date', { ascending: false }).limit(1).maybeSingle();
  if (prevRow) {
    await cascadeCashForward(supabase, outletId, prevRow.date);
    return;
  }
  const { data: nextRow } = await supabase.from('daily_outlet_sales').select('date')
    .eq('outlet_id', outletId).gt('date', removedDate).order('date', { ascending: true }).limit(1).maybeSingle();
  if (nextRow) {
    await supabase.from('daily_outlet_sales').update({ prev_day_cash: 0 }).eq('outlet_id', outletId).eq('date', nextRow.date);
    await cascadeCashForward(supabase, outletId, nextRow.date);
  }
}

// ── GET /api/outlet-sales — Get sales for a date/outlet
router.get('/outlet-sales', async (req, res) => {
  try {
    const _user = await requireAuth(req, res); if (!_user) return;
    const _outlet = req.body?.outlet_id || req.query?.outlet_id || req.params?.outlet_id;
    if (!ensureOutletAccess(_user, _outlet, res)) return;
    const { outlet_id, date, from, to } = req.query;
    let query = supabase.from('daily_outlet_sales').select('*');
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    if (date) query = query.eq('date', date);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    const { data, error } = await query.order('date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/outlet-sales/latest-cash — Get previous day closing cash for an outlet
router.get('/outlet-sales/latest-cash', async (req, res) => {
  try {
    const _user = await requireAuth(req, res); if (!_user) return;
    const _outlet = req.body?.outlet_id || req.query?.outlet_id || req.params?.outlet_id;
    if (!ensureOutletAccess(_user, _outlet, res)) return;
    const { outlet_id, before_date } = req.query;
    const { data, error } = await supabase.from('daily_outlet_sales')
      .select('*')
      .eq('outlet_id', outlet_id)
      .lt('date', before_date)
      .order('date', { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json(data && data[0] ? data[0] : null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/outlet-sales — Submit/update daily sales
router.post('/outlet-sales', async (req, res) => {
  try {
    const _user = await requireAuth(req, res); if (!_user) return;
    // franchise is a view-only role (P&L/Sales/RM Audit/Billing) — explicitly excluded
    // here since this route otherwise had no role check beyond outlet-match, which would
    // let them submit sales for their own outlet through a direct API call.
    if (!['owner', 'store_mgr', 'outlet_mgr', 'chef', 'bainmarry', 'avp'].includes(_user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const _outlet = req.body?.outlet_id || req.query?.outlet_id || req.params?.outlet_id;
    if (!ensureOutletAccess(_user, _outlet, res)) return;
    const { outlet_id, date, total_sale, swiggy_sale, zomato_sale, other_delivery_sale,
            cancelled_orders, complimentary_amount, complimentary_reason, zomato_district,
            upi_collected, cash_collected, prev_day_cash, cash_expense, cash_expense_note,
            cash_deposited, cash_deposited_to, submitted_by, notes } = req.body;

    const record = {
      outlet_id, date, total_sale, swiggy_sale, zomato_sale, other_delivery_sale,
      cancelled_orders: cancelled_orders || 0,
      complimentary_amount: complimentary_amount || 0,
      complimentary_reason: complimentary_reason || null,
      zomato_district: zomato_district || 0,
      upi_collected, cash_collected, prev_day_cash, cash_expense, cash_expense_note,
      cash_deposited, submitted_by, notes, submitted_at: new Date().toISOString()
    };

    // Only re-stamp who/when "cash deposited" was set if this submission actually
    // changes that value — otherwise an outlet manager routinely re-saving their
    // sales form (which pre-fills whatever is already in the DB) would silently
    // overwrite an owner/store-manager's collection record with their own name.
    const { data: existing } = await supabase.from('daily_outlet_sales')
      .select('cash_deposited, cash_collected, cash_expense').eq('outlet_id', outlet_id).eq('date', date).maybeSingle();
    const depositChanged = !existing || Number(existing.cash_deposited || 0) !== Number(cash_deposited || 0);
    if (depositChanged) {
      // cash_deposited_to is the outlet manager's declared recipient (from the fixed
      // CASH_RECIPIENTS list) — falls back to the submitter's own name only if they
      // didn't pick one, so this stays backward-compatible with older clients.
      record.cash_deposited_by = cash_deposited_to || submitted_by || null;
      record.cash_deposited_at = new Date().toISOString();
    }
    // Any of these changing on a past date shifts that day's closing balance, which
    // later days' prev_day_cash would otherwise go stale against — cascade forward.
    const closingChanged = depositChanged
      || Number(existing?.cash_collected || 0) !== Number(cash_collected || 0)
      || Number(existing?.cash_expense || 0) !== Number(cash_expense || 0);

    const { data, error } = await supabase.from('daily_outlet_sales').upsert(record, { onConflict: 'outlet_id,date' });

    if (error) throw error;
    if (closingChanged) await cascadeCashForward(supabase, outlet_id, date);
    // Write to Google Sheet (non-blocking)
    if (sheetsHelper) sheetsHelper.writeToSheet(supabase, outlet_id, 'daily_sales', submitted_by, { date }, { total_sale, swiggy_sale, zomato_sale, other_delivery_sale, cancelled_orders, complimentary_amount, complimentary_reason, zomato_district, upi_collected, cash_collected, prev_day_cash, cash_expense, cash_expense_note, cash_deposited, notes }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/outlet-sales/cash-collection — Owner/Store Manager records an
// actual cash collection/deposit for a specific outlet+date. This writes to the
// SAME cash_deposited field the outlet manager's daily-sales form uses, so
// there's one shared number regardless of who records it — not two competing ones.
router.patch('/outlet-sales/cash-collection', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { outlet_id, date, cash_deposited, collected_by, note } = req.body;
    if (!outlet_id || !date || cash_deposited === undefined) {
      return res.status(400).json({ error: 'outlet_id, date, and cash_deposited are required' });
    }

    const { data: existing } = await supabase.from('daily_outlet_sales')
      .select('*').eq('outlet_id', outlet_id).eq('date', date).maybeSingle();

    const record = {
      outlet_id, date,
      cash_deposited: Number(cash_deposited) || 0,
      cash_deposited_by: collected_by || null,
      cash_deposited_at: new Date().toISOString(),
      // Preserve everything else already on the row — this endpoint only ever
      // touches the deposited/collection fields, nothing else.
      ...(existing ? {
        total_sale: existing.total_sale, swiggy_sale: existing.swiggy_sale, zomato_sale: existing.zomato_sale,
        other_delivery_sale: existing.other_delivery_sale, cancelled_orders: existing.cancelled_orders,
        complimentary_amount: existing.complimentary_amount, complimentary_reason: existing.complimentary_reason,
        zomato_district: existing.zomato_district, upi_collected: existing.upi_collected,
        cash_collected: existing.cash_collected, prev_day_cash: existing.prev_day_cash,
        cash_expense: existing.cash_expense, cash_expense_note: existing.cash_expense_note,
        submitted_by: existing.submitted_by, submitted_at: existing.submitted_at, notes: existing.notes,
      } : { notes: note || null }),
    };

    const { data, error } = await supabase.from('daily_outlet_sales').upsert(record, { onConflict: 'outlet_id,date' }).select('*').single();
    if (error) throw error;
    await cascadeCashForward(supabase, outlet_id, date);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/outlet-sales/verify — Owner verifies UPI
router.patch('/outlet-sales/verify', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, date, verified } = req.body;
    const { error } = await supabase.from('daily_outlet_sales')
      .update({ verified, verified_at: new Date().toISOString() })
      .eq('outlet_id', outlet_id).eq('date', date);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── POST /api/inventory/items — Add new inventory item
router.post('/inventory/items', async (req, res) => {
  try {
    const { id, name, category, unit, threshold } = req.body;
    const { error } = await supabase.from('inventory_items').insert({ id, name, category, unit, threshold: threshold || 0 });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/inventory/items/:id — Delete inventory item
router.delete('/inventory/items/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('inventory_items').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── PATCH /api/inventory/items/:id — Update inventory item name/unit/category
router.patch('/inventory/items/:id', async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.unit !== undefined) updates.unit = req.body.unit;
    if (req.body.category !== undefined) updates.category = req.body.category;
    const { error } = await supabase.from('inventory_items').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// AUTH — Phone + PIN login
// ============================================================

router.post('/auth/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: "Phone and PIN required" });
    const { data, error } = await supabase.from('app_users')
      .select('*').eq('phone', phone).eq('active', true).single();
    if (error || !data) return res.status(401).json({ error: "User not found" });
    if (data.pin !== pin) return res.status(401).json({ error: "Incorrect PIN" });
    res.json({ id: data.id, name: data.name, phone: data.phone, role: data.role, outlet_id: data.outlet_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/users', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { data, error } = await supabase.from('app_users').select('*').order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/users', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { name, phone, role, outlet_id } = req.body;
    const finalRole = role || 'outlet_mgr';
    // outlet_mgr's whole access model (employees.js scopeForUser) keys off this —
    // silently letting it through as null used to leak every outlet's employee
    // list and advance-giving to that manager instead of just their own.
    if (finalRole === 'outlet_mgr' && !outlet_id) return res.status(400).json({ error: 'An outlet must be selected for an Outlet Manager account' });
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const { data, error } = await supabase.from('app_users')
      .insert({ name, phone, pin, role: finalRole, outlet_id: outlet_id || null })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/auth/users/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.role !== undefined) updates.role = req.body.role;
    if (req.body.outlet_id !== undefined) updates.outlet_id = req.body.outlet_id;
    if (req.body.active !== undefined) updates.active = req.body.active;
    if (req.body.pin) updates.pin = req.body.pin;
    if (req.body.pin) updates.pin = req.body.pin;
    else if (req.body.reset_pin) updates.pin = String(Math.floor(1000 + Math.random() * 9000));

    // Same guard as create — check the state this update would result in, not
    // just what's in this particular request body (a role-only edit shouldn't
    // silently orphan an already-set outlet_id, and vice versa).
    if ('role' in updates || 'outlet_id' in updates) {
      const { data: existing } = await supabase.from('app_users').select('role, outlet_id').eq('id', req.params.id).single();
      const finalRole = updates.role !== undefined ? updates.role : existing?.role;
      const finalOutlet = updates.outlet_id !== undefined ? updates.outlet_id : existing?.outlet_id;
      if (finalRole === 'outlet_mgr' && !finalOutlet) return res.status(400).json({ error: 'An outlet must be selected for an Outlet Manager account' });
    }

    const { data, error } = await supabase.from('app_users').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Employee Master (staff directory, attendance, roster, bank details) now lives in
// its own router — see routes/employees.js, mounted at /api/employees in server.js.

// ── POST /api/demands — Create demand (robust version, handles all types)
router.post('/demands', async (req, res) => {
  try {
    const { outlet_id, type, items, items_units, note, date, demand_slot, submitted_by, status } = req.body;
    if (!outlet_id || !type) return res.status(400).json({ error: "outlet_id and type are required" });
    const targetDate = date || todayIST();

    // Server-side safety net against duplicate challans — never let two draft/submitted
    // demands exist for the same outlet+date+type+slot, no matter what led here (stale
    // client-side existingRecord state, two staff submitting minutes apart, a future
    // code path that forgets this check). Update the existing one instead of inserting a
    // new row. Fulfilled/cancelled rows are deliberately excluded from this match — a
    // second order placed after the first was already dispatched is a real, separate
    // order, not a duplicate.
    let existingQuery = supabase.from('demands').select('id').eq('outlet_id', outlet_id).eq('date', targetDate).eq('type', type).in('status', ['draft', 'submitted']);
    existingQuery = demand_slot ? existingQuery.eq('demand_slot', demand_slot) : existingQuery.is('demand_slot', null);
    const { data: existingRows } = await existingQuery.order('submitted_at', { ascending: false }).limit(1);
    const existingId = existingRows && existingRows[0] && existingRows[0].id;

    // Block a brand-new (not-yet-existing) manual demand for a slot that's already been
    // dispatched — the Aug 12/13 Sector 56 incident this guards against: the old "Which
    // morning?" picker made a manager pick between two ambiguous dates by hand late at
    // night, and a wrong pick silently created a second demand for an already-fulfilled
    // slot instead of the new one they actually meant. The date picker itself is now
    // auto-computed (no more manual guess — see morningSlotDate() on the frontend), but
    // this is the authoritative backstop regardless of what the client sends. Wastage
    // (type='wastage') is unaffected — only real demand (type='manual') is slotted this
    // way; a legitimate same-day top-up request after dispatch should go through Transfer
    // or a phoned-in add at BK's dispatch screen instead of a second full demand record.
    if (!existingId && type === 'manual') {
      let fulfilledQuery = supabase.from('demands').select('id').eq('outlet_id', outlet_id).eq('date', targetDate).eq('type', 'manual').eq('status', 'fulfilled');
      fulfilledQuery = demand_slot ? fulfilledQuery.eq('demand_slot', demand_slot) : fulfilledQuery.is('demand_slot', null);
      const { data: fulfilledRows } = await fulfilledQuery.limit(1);
      if (fulfilledRows && fulfilledRows.length > 0) {
        return res.status(400).json({ error: `${demand_slot ? demand_slot.charAt(0).toUpperCase() + demand_slot.slice(1) : 'This'} demand for ${targetDate} has already been dispatched — a second demand can't be created for the same slot. Need something extra? Use Transfer, or ask Base Kitchen to add it at dispatch time.` });
      }
    }

    const itemsUnitsVal = items_units && Object.keys(items_units).length > 0 ? items_units : null;
    let data, error;
    if (existingId) {
      ({ data, error } = await supabase.from('demands').update({
        items: items || {}, items_units: itemsUnitsVal, note: note || null,
        submitted_by: submitted_by || null, status: status || 'submitted',
        submitted_at: new Date().toISOString(),
      }).eq('id', existingId).select('*').single());
    } else {
      const record = {
        outlet_id, type, items: items || {}, items_units: itemsUnitsVal,
        note: note || null, date: targetDate, demand_slot: demand_slot || null,
        submitted_by: submitted_by || null, status: status || 'submitted',
        submitted_at: new Date().toISOString(),
      };
      ({ data, error } = await supabase.from('demands').insert(record).select('*').single());
    }
    if (error) throw error;
    // Write to Google Sheet (non-blocking)
    if (sheetsHelper && outlet_id !== 'bk') sheetsHelper.writeToSheet(supabase, outlet_id, type, submitted_by, data, items).catch(() => {});
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/demands/draft — Chef/Bainmarry (and the manager) save their scoped
// category's items into today's shared draft record, merging into whatever's already
// there from the other role rather than overwriting it. Creates the draft row if this is
// the first save of the day for this outlet/date/type/slot. Used by Demand and Wastage —
// Closing Stock has its own upsert-by-day route in demands.js.
router.patch('/demands/draft', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    // bk_manager/avp added — BK now drafts/submits its own wastage the same way
    // outlets do (outlet_id='bk'), per the Stage 5 course-correction.
    if (!['owner', 'store_mgr', 'outlet_mgr', 'chef', 'bainmarry', 'bk_manager', 'avp'].includes(user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    let { outlet_id, type, items, items_units, demand_slot, submitted_by } = req.body;
    const date = req.body.date || todayIST();
    if (!outlet_id || !type) return res.status(400).json({ error: 'outlet_id and type are required' });
    if (!ensureOutletAccess(user, outlet_id, res)) return;

    // Server-side backstop matching the frontend's CATEGORY_SCOPE — a direct API call
    // can't smuggle in items outside Chef/Bainmarry's own category this way either.
    items = await filterItemsToRoleScope(user.role, items);
    items_units = await filterItemsToRoleScope(user.role, items_units);

    // status='draft' is deliberate — without it, this would find and silently rewrite the
    // most recent row for this outlet/date/type/slot regardless of state, including one
    // that's already submitted/received/fulfilled (e.g. a morning demand already dispatched
    // by BK). Only an actual still-open draft is safe to merge into; anything else must
    // start a fresh row.
    let query = supabase.from('demands').select('*').eq('outlet_id', outlet_id).eq('date', date).eq('type', type).eq('status', 'draft');
    query = demand_slot ? query.eq('demand_slot', demand_slot) : query.is('demand_slot', null);
    const { data: existingRows, error: findErr } = await query.order('submitted_at', { ascending: false }).limit(1);
    if (findErr) throw findErr;
    const existing = existingRows?.[0];

    // Same guard as POST /demands — don't start a fresh draft for a slot that's already
    // been dispatched (see the comment there for the incident this prevents).
    if (!existing && type === 'manual') {
      let fulfilledQuery = supabase.from('demands').select('id').eq('outlet_id', outlet_id).eq('date', date).eq('type', 'manual').eq('status', 'fulfilled');
      fulfilledQuery = demand_slot ? fulfilledQuery.eq('demand_slot', demand_slot) : fulfilledQuery.is('demand_slot', null);
      const { data: fulfilledRows } = await fulfilledQuery.limit(1);
      if (fulfilledRows && fulfilledRows.length > 0) {
        return res.status(400).json({ error: `${demand_slot ? demand_slot.charAt(0).toUpperCase() + demand_slot.slice(1) : 'This'} demand for ${date} has already been dispatched — a second demand can't be created for the same slot. Need something extra? Use Transfer, or ask Base Kitchen to add it at dispatch time.` });
      }
    }

    const mergedItems = { ...(existing?.items || {}), ...(items || {}) };
    const mergedUnits = { ...(existing?.items_units || {}), ...(items_units || {}) };
    const cleanUnits = Object.keys(mergedUnits).length > 0 ? mergedUnits : null;

    if (existing) {
      const { data, error } = await supabase.from('demands')
        .update({ items: mergedItems, items_units: cleanUnits })
        .eq('id', existing.id).select('*').single();
      if (error) throw error;
      return res.json(data);
    }

    const { data, error } = await supabase.from('demands').insert({
      outlet_id, type, items: mergedItems, items_units: cleanUnits,
      date, demand_slot: demand_slot || null,
      submitted_by: submitted_by || user.name || null,
      status: 'draft', submitted_at: new Date().toISOString(),
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/demands/:id/finalize — Outlet Manager (or store_mgr/owner) turns today's
// accumulated draft into the real submission. Optionally accepts final item edits too, so
// the manager can correct something in the same action as finalizing.
router.patch('/demands/:id/finalize', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { data: existing, error: findErr } = await supabase.from('demands').select('outlet_id, status').eq('id', req.params.id).single();
    if (findErr || !existing) return res.status(404).json({ error: 'Not found' });
    // AVP gets the full Base Kitchen Manager module, which includes Dispatch — that
    // needs unrestricted cross-outlet access, same as store_mgr, not just BK's own
    // demand. bk_manager's scope really is just BK's own demand, so stays outlet-locked.
    const allowed = ['owner', 'store_mgr', 'outlet_mgr', 'avp'].includes(user.role) || (user.role === 'bk_manager' && existing.outlet_id === 'bk');
    if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
    if (!ensureOutletAccess(user, existing.outlet_id, res)) return;
    // Once BK has dispatched it, the outlet's own self-service roles can no longer
    // rewrite it from their portal — the record has to stay exactly what was actually
    // sent (franchise billing and every audit trail read off it as fact). Owner/store_mgr/
    // avp keep the ability, since they may legitimately need to fix a genuine mistake.
    const OUTLET_SELF_SERVICE_ROLES = ['outlet_mgr', 'chef', 'bainmarry'];
    if (existing.status === 'fulfilled' && OUTLET_SELF_SERVICE_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Already dispatched — this demand can no longer be edited from the outlet portal.' });
    }

    const { items, items_units, submitted_by } = req.body;
    const updates = { status: 'submitted', submitted_at: new Date().toISOString() };
    if (items) updates.items = items;
    if (items_units !== undefined) updates.items_units = items_units && Object.keys(items_units).length > 0 ? items_units : null;
    if (submitted_by) updates.submitted_by = submitted_by;

    const { data, error } = await supabase.from('demands').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/demands/:id — Full items replace, for the Outlet Manager editing an
// already-finalized same-day submission without creating a duplicate row. Distinct from
// the owner-only historical qty-edit correction tool (/qty-edit) — this is same-day,
// same-outlet self-service editing.
router.patch('/demands/:id', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { data: existing, error: findErr } = await supabase.from('demands').select('outlet_id, status').eq('id', req.params.id).single();
    if (findErr || !existing) return res.status(404).json({ error: 'Not found' });
    // AVP gets the full Base Kitchen Manager module, which includes Dispatch — that
    // needs unrestricted cross-outlet access, same as store_mgr, not just BK's own
    // demand. bk_manager's scope really is just BK's own demand, so stays outlet-locked.
    const allowed = ['owner', 'store_mgr', 'outlet_mgr', 'avp'].includes(user.role) || (user.role === 'bk_manager' && existing.outlet_id === 'bk');
    if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
    if (!ensureOutletAccess(user, existing.outlet_id, res)) return;
    // Once BK has dispatched it, the outlet's own self-service roles can no longer
    // rewrite it from their portal — the record has to stay exactly what was actually
    // sent (franchise billing and every audit trail read off it as fact). Owner/store_mgr/
    // avp keep the ability, since they may legitimately need to fix a genuine mistake.
    const OUTLET_SELF_SERVICE_ROLES = ['outlet_mgr', 'chef', 'bainmarry'];
    if (existing.status === 'fulfilled' && OUTLET_SELF_SERVICE_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Already dispatched — this demand can no longer be edited from the outlet portal.' });
    }

    const { items, items_units, submitted_by } = req.body;
    const updates = {};
    if (items) updates.items = items;
    if (items_units !== undefined) updates.items_units = items_units && Object.keys(items_units).length > 0 ? items_units : null;
    if (submitted_by) updates.submitted_by = submitted_by;

    const { data, error } = await supabase.from('demands').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/demands/:id/cancel — Write off a demand the store has decided not to
// dispatch (no longer needed, duplicate, mistake) — distinct from 'fulfilled' so it can
// never be mistaken for goods that actually went out. Appends a note rather than
// overwriting so the original demand context isn't lost from the record.
router.patch('/demands/:id/cancel', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    // AVP runs Dispatch as part of the Base Kitchen Manager module — needs the same
    // cancel access store_mgr has, across every outlet, not just BK's own demand.
    if (!['owner', 'store_mgr', 'avp'].includes(user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const { data: existing, error: findErr } = await supabase.from('demands').select('note').eq('id', req.params.id).single();
    if (findErr || !existing) return res.status(404).json({ error: 'Not found' });
    const { reason } = req.body;
    const note = (existing.note ? existing.note + ' | ' : '') + `CANCELLED by ${user.name}${reason ? ': ' + reason : ''}`;
    const { data, error } = await supabase.from('demands').update({ status: 'cancelled', note }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/purchases — Create cash purchase (flexible schema)
router.post('/purchases', async (req, res) => {
  try {
    const { items, payment_mode, note, outlet_id, submitted_by, date } = req.body;
    const totalAmount = (items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    
    // Try to insert with all fields — gracefully handle missing columns
    const record = {
      outlet_id: outlet_id || 'bk',
      total_amount: totalAmount,
      payment_mode: payment_mode || 'cash',
      note: note || null,
      submitted_by: submitted_by || null,
      date: date || todayIST(),
    };
    
    // Try with items column first, fallback without it
    let result;
    const { data: d1, error: e1 } = await supabase.from('purchases').insert({ ...record, items: items || [] }).select('*').single();
    if (e1 && e1.message.includes("items")) {
      // items column doesn't exist — store items in note as JSON string
      record.note = JSON.stringify({ items: items || [], note: note || "" });
      const { data: d2, error: e2 } = await supabase.from('purchases').insert(record).select('*').single();
      if (e2) throw e2;
      result = d2;
    } else if (e1) {
      throw e1;
    } else {
      result = d1;
    }
    
    // Write to Google Sheet (non-blocking)
    if (sheetsHelper && outlet_id) sheetsHelper.writeToSheet(supabase, outlet_id, 'purchase', submitted_by, { date: date || todayIST() }, { items: items || [], total: totalAmount, payment_mode }).catch(() => {});

    // Any line explicitly linked to an inventory item (optional — most cash-purchase
    // lines stay free text) also credits the BK inventory ledger, same as a formal
    // Stock In. This is how Cash Purchase items (Duster, Phenyl, etc., bought ad hoc
    // rather than through a vendor order) stop silently drifting the running balance.
    const linkedItems = (items || []).filter(i => i.item_id).map(i => ({ item_id: i.item_id, quantity: Number(i.quantity) || 0, total_price: Number(i.amount) || 0, unit_price: (Number(i.quantity) > 0 ? (Number(i.amount) || 0) / Number(i.quantity) : null) }));
    if (linkedItems.length > 0) {
      try { await creditStockIn(linkedItems, 'cash_purchase', submitted_by); }
      catch (e) { console.error('Cash purchase inventory credit failed:', e.message); }
    }

    // Push each purchased line's paid price (amount ÷ quantity) into the rate-card ledger,
    // effective from the purchase date. Lines carry either a store item_id (cash-purchase)
    // or just a display item_name + unit (dairy/cold-drink) — resolve both. ingestPrices
    // skips anything with no rate-card match or a unit that doesn't match the rate card
    // (cold drinks have no rate_card entry and drop out here naturally). Best-effort — a
    // ledger failure never fails the purchase itself.
    try {
      const priceLines = (items || []).filter(i => Number(i.quantity) > 0 && Number(i.amount) > 0);
      if (priceLines.length) {
        const byId = await resolveByItemIds(priceLines.filter(i => i.item_id).map(i => i.item_id));
        const byName = await resolveByNames(priceLines.filter(i => !i.item_id && i.item_name).map(i => i.item_name));
        const entries = priceLines.map(i => ({
          rateCardId: i.item_id ? (byId[i.item_id]?.rateCardId || null) : (byName[normalizeRateName(i.item_name)] || null),
          price: Number(i.amount) / Number(i.quantity),
          priceUnit: i.unit || (i.item_id ? byId[i.item_id]?.baseUnit : null),
          label: i.item_name || i.item_id,
        }));
        const { written, skipped } = await ingestPrices(entries, { effectiveDate: record.date, source: 'purchase', sourceId: result?.id, createdBy: submitted_by });
        if (skipped.length) console.warn(`[rate-card ledger] purchase ${result?.id}: wrote ${written} price(s), skipped ${skipped.length}:`, skipped);
      }
    } catch (e) { console.error(`[rate-card ledger] purchase price ingest failed:`, e.message); }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/purchases/:id/photos — Upload purchase bill photo (skip if no bucket)
router.post('/purchases/:id/photos', async (req, res) => {
  try {
    const { base64, label } = req.body;
    if (!base64) return res.json({ ok: true, skipped: true });
    
    // Try to upload, but don't fail if bucket doesn't exist
    const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const filename = `${req.params.id}/${label || 'bill'}_${Date.now()}.jpg`;
    
    const { error } = await supabase.storage.from('bills').upload(filename, buffer, {
      contentType: 'image/jpeg', upsert: true,
    });
    
    if (error) {
      console.log('Photo upload skipped (bucket may not exist):', error.message);
      return res.json({ ok: true, skipped: true, reason: error.message });
    }
    
    const { data: urlData } = supabase.storage.from('bills').getPublicUrl(filename);
    res.json({ ok: true, url: urlData?.publicUrl });
  } catch (e) {
    // Don't fail the whole purchase just because photo upload failed
    console.log('Photo upload error (non-fatal):', e.message);
    res.json({ ok: true, skipped: true, reason: e.message });
  }
});

// ── PATCH /api/demands/:id/draft — Update draft demand items. Not currently called from
// the frontend (api.js exposes it but nothing invokes it), but it's a live endpoint, so it
// gets the same auth/outlet/status guards as the other demand-edit routes rather than
// staying an unauthenticated write hole.
router.patch('/demands/:id/draft', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { data: existing, error: findErr } = await supabase.from('demands').select('outlet_id, status').eq('id', req.params.id).single();
    if (findErr || !existing) return res.status(404).json({ error: 'Not found' });
    const allowed = ['owner', 'store_mgr', 'outlet_mgr', 'avp'].includes(user.role) || (user.role === 'bk_manager' && existing.outlet_id === 'bk');
    if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });
    if (!ensureOutletAccess(user, existing.outlet_id, res)) return;
    const OUTLET_SELF_SERVICE_ROLES = ['outlet_mgr', 'chef', 'bainmarry'];
    if (existing.status === 'fulfilled' && OUTLET_SELF_SERVICE_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Already dispatched — this demand can no longer be edited from the outlet portal.' });
    }
    const { items } = req.body;
    const { error } = await supabase.from('demands').update({
      items: items || {},
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ORDERS — Fetch and manage demands/orders
// ============================================================

// ── GET /api/closing-stocks — Get closing stocks history
router.get('/closing-stocks', async (req, res) => {
  try {
    const { date, outlet_id, from } = req.query;
    let query = supabase.from('closing_stocks').select('*');
    if (date) query = query.eq('date', date);
    if (from) query = query.gte('date', from);
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    query = query.order('date', { ascending: false }).order('outlet_id');
    if (from && !date) query = query.limit(500);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orders — Get orders/demands for a date (optionally filter by outlet)
router.get('/orders', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { date, status, from } = req.query;
    const outlet_id = scopedOutletFilter(user, req.query.outlet_id);
    let query = supabase.from('demands').select('*');
    if (date) query = query.eq('date', date);
    if (from) query = query.gte('date', from);
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    if (status) query = query.eq('status', status);
    query = query.order('submitted_at', { ascending: false });
    if (from && !date) query = query.limit(500);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orders/consolidated — Consolidated demand for a date
router.get('/orders/consolidated', async (req, res) => {
  try {
    const { date } = req.query;
    const { data, error } = await supabase.from('demands').select('*')
      .eq('date', date || todayIST())
      .in('type', ['manual', 'photo'])
      .in('status', ['submitted', 'received', 'issued', 'fulfilled']);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orders/dashboard-summary — Summary counts for live activity
router.get('/orders/dashboard-summary', async (req, res) => {
  try {
    const { date } = req.query;
    const d = date || todayIST();

    const [demands, purchases, issuances] = await Promise.all([
      supabase.from('demands').select('*').eq('date', d).order('submitted_at', { ascending: false }),
      supabase.from('purchases').select('*').eq('date', d).order('created_at', { ascending: false }),
      supabase.from('issuances').select('*').eq('date', d).order('submitted_at', { ascending: false }),
    ]);

    const demandData = demands.data || [];
    const purchaseData = purchases.data || [];
    const issuanceData = issuances.data || [];

    const pending = demandData.filter(d => d.status === 'submitted' || d.status === 'received');

    res.json({
      summary: {
        total_demands: demandData.filter(d => d.type === 'manual' || d.type === 'photo').length,
        pending_dispatch: pending.length,
        total_issuances: issuanceData.length,
        total_purchases: purchaseData.length,
        purchase_amount: purchaseData.reduce((s, p) => s + Number(p.total_amount || 0), 0),
      },
      demands: demandData,
      purchases: purchaseData,
      issuances: issuanceData,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/orders/:id/status — Update order status
router.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status, dispatch_notes } = req.body;
    const updates = { status };
    if (dispatch_notes !== undefined) updates.dispatch_notes = dispatch_notes;
    if (status === 'fulfilled') updates.dispatched_at = new Date().toISOString();
    const { error } = await supabase.from('demands').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/orders/:id/receive — Outlet manager confirms what they actually
// received against a dispatched challan, closing the demand → dispatch → receipt
// loop. received_items may differ from dispatch_items (shortage/damage found on
// arrival) — kept as a separate field so neither side's record gets overwritten.
router.patch('/orders/:id/receive', async (req, res) => {
  try {
    const _user = await requireAuth(req, res); if (!_user) return;
    const { data: order, error: fetchErr } = await supabase.from('demands').select('outlet_id').eq('id', req.params.id).single();
    if (fetchErr) throw fetchErr;
    if (!ensureOutletAccess(_user, order.outlet_id, res)) return;
    const { received_items } = req.body;
    if (!received_items) return res.status(400).json({ error: "received_items required" });
    const { error } = await supabase.from('demands').update({
      received_items, received_by: _user.name, received_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// DISPATCH CHALLAN — Save actual dispatched quantities
// ============================================================

// ── PATCH /api/orders/:id/dispatch — Save dispatched items, mark fulfilled
// Supports partial dispatch: checked items get dispatched, unchecked create a new pending order
router.patch('/orders/:id/dispatch', async (req, res) => {
  try {
    const { id } = req.params;
    const { dispatch_items, dispatched_by, remaining_items, items_units } = req.body;

    // 1. Get the order
    const { data: order, error: orderErr } = await supabase.from('demands')
      .select('*').eq('id', id).single();
    if (orderErr) throw orderErr;

    // Merge (not overwrite) — a "phoned-in" item added straight at dispatch time (never
    // went through the outlet manager's UnitPicker) needs its own unit tag too, or a Kg
    // item like dosa/idli batter silently falls back to the catalog default ("Batch")
    // downstream in costing, a 9x/8x error. Union with whatever the original demand
    // already had so an item that WAS tagged at demand time keeps that tag.
    const mergedItemsUnits = { ...(order.items_units || {}), ...(items_units || {}) };

    // 2. Mark order as fulfilled with dispatch items
    const { error: updateErr } = await supabase.from('demands').update({
      status: 'fulfilled',
      dispatch_items: dispatch_items || {},
      items_units: mergedItemsUnits,
      dispatched_at: new Date().toISOString(),
      dispatched_by: dispatched_by || null,
    }).eq('id', id);
    if (updateErr) throw updateErr;

    // 3. If there are remaining items, create a new pending order
    let remainingOrderId = null;
    if (remaining_items && Object.keys(remaining_items).length > 0) {
      const { data: newOrder, error: insertErr } = await supabase.from('demands').insert({
        outlet_id: order.outlet_id,
        date: order.date,
        type: order.type || 'manual',
        status: 'submitted',
        items: remaining_items,
        // Carry the same merged unit tags forward — otherwise a partially-dispatched
        // Kg item's tag would be lost on the follow-up order for whatever's left.
        items_units: mergedItemsUnits,
        note: `Remaining from partial dispatch (${Object.keys(dispatch_items).length} items sent)`,
        submitted_by: order.submitted_by,
        submitted_at: order.submitted_at,
      }).select('id').single();
      if (insertErr) console.error('Failed to create remaining order:', insertErr.message);
      else remainingOrderId = newOrder?.id;
    }

    // Store Inventory Module Stage 3 — auto stock-out against the NEW ledger
    // (items/stock_movements), on top of the unchanged logic above. Never allowed to
    // affect this response: a real dispatch that already left the building must not
    // fail or roll back because the new ledger hookup had a problem.
    try {
      await applyDispatchStockOut({
        demandId: id, type: order.type, outletId: order.outlet_id,
        dispatchItems: dispatch_items || {}, itemsUnits: mergedItemsUnits, actorName: dispatched_by,
      });
    } catch (hookErr) { console.error(`[dispatch ${id}] Stage 3 stock-out hook failed:`, hookErr.message); }

    res.json({ ok: true, remaining_order_id: remainingOrderId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/move-submission-date — Owner-only: an outlet manager submitted under
// the wrong date, so move that day's Sales / Closing Stock / Wastage entirely from
// from_date to to_date (same outlet). Closing Stock and Wastage just need their `date`
// column changed — P&L and stock-usage read live from these tables, so the correction
// takes effect immediately everywhere. Sales additionally needs its cash-carry-forward
// chain (prev_day_cash) re-threaded on both sides of the move, since that's a stored
// running balance, not something recomputed live. If the target date already has data
// for a type, that type is reported back as a conflict and skipped unless force=true.
router.post('/move-submission-date', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, from_date, to_date, types, force } = req.body;
    if (!outlet_id || !from_date || !to_date || !Array.isArray(types) || types.length === 0) {
      return res.status(400).json({ error: 'outlet_id, from_date, to_date, and types[] are required' });
    }
    if (from_date === to_date) return res.status(400).json({ error: 'from_date and to_date must be different' });

    const result = { moved: [], skipped: [], conflicts: [] };

    // ── CLOSING STOCK ── one row per outlet+date
    if (types.includes('closing')) {
      const { data: src } = await supabase.from('closing_stocks').select('*').eq('outlet_id', outlet_id).eq('date', from_date).maybeSingle();
      if (!src) {
        result.skipped.push({ type: 'closing', reason: 'No closing stock data on source date' });
      } else {
        const { data: existingTarget } = await supabase.from('closing_stocks').select('id').eq('outlet_id', outlet_id).eq('date', to_date).maybeSingle();
        if (existingTarget && !force) {
          result.conflicts.push({ type: 'closing', message: 'Target date already has closing stock data' });
        } else {
          if (existingTarget) await supabase.from('closing_stocks').delete().eq('id', existingTarget.id);
          await supabase.from('closing_stocks').update({ date: to_date }).eq('id', src.id);
          if (sheetsHelper) sheetsHelper.moveDateInSheet(supabase, outlet_id, 'closing', from_date, to_date).catch(() => {});
          result.moved.push({ type: 'closing', items: Object.keys(src.items || {}).length });
        }
      }
    }

    // ── WASTAGE ── demands table, type='wastage' — multiple entries per day are normal
    if (types.includes('wastage')) {
      const { data: srcRows } = await supabase.from('demands').select('*').eq('outlet_id', outlet_id).eq('date', from_date).eq('type', 'wastage');
      if (!srcRows || srcRows.length === 0) {
        result.skipped.push({ type: 'wastage', reason: 'No wastage data on source date' });
      } else {
        const { data: existingTarget } = await supabase.from('demands').select('id').eq('outlet_id', outlet_id).eq('date', to_date).eq('type', 'wastage').limit(1);
        if (existingTarget && existingTarget.length > 0 && !force) {
          result.conflicts.push({ type: 'wastage', message: 'Target date already has wastage data' });
        } else {
          await supabase.from('demands').update({ date: to_date }).in('id', srcRows.map(r => r.id));
          if (sheetsHelper) sheetsHelper.moveDateInSheet(supabase, outlet_id, 'wastage', from_date, to_date).catch(() => {});
          result.moved.push({ type: 'wastage', entries: srcRows.length });
        }
      }
    }

    // ── SALES ── one row per outlet+date, plus the prev_day_cash running-balance chain
    if (types.includes('sales')) {
      const { data: src } = await supabase.from('daily_outlet_sales').select('*').eq('outlet_id', outlet_id).eq('date', from_date).maybeSingle();
      if (!src) {
        result.skipped.push({ type: 'sales', reason: 'No sales data on source date' });
      } else {
        const { data: existingTarget } = await supabase.from('daily_outlet_sales').select('id').eq('outlet_id', outlet_id).eq('date', to_date).maybeSingle();
        if (existingTarget && !force) {
          result.conflicts.push({ type: 'sales', message: 'Target date already has sales data' });
        } else {
          if (existingTarget) await supabase.from('daily_outlet_sales').delete().eq('id', existingTarget.id);

          // The moved row's own prev_day_cash was computed for its old neighbors — recompute
          // it for whatever now actually precedes it at the target date before cascading.
          const { data: predB } = await supabase.from('daily_outlet_sales').select('*').eq('outlet_id', outlet_id).lt('date', to_date).order('date', { ascending: false }).limit(1).maybeSingle();
          const correctPrevCash = predB ? (Number(predB.prev_day_cash || 0) + Number(predB.cash_collected || 0) - Number(predB.cash_expense || 0) - Number(predB.cash_deposited || 0)) : 0;

          const { data: moved, error } = await supabase.from('daily_outlet_sales').update({ date: to_date, prev_day_cash: correctPrevCash }).eq('id', src.id).select().single();
          if (error) throw error;

          await recascadeAfterRemoval(supabase, outlet_id, from_date);
          await cascadeCashForward(supabase, outlet_id, to_date);

          if (sheetsHelper) sheetsHelper.writeToSheet(supabase, outlet_id, 'daily_sales', moved.submitted_by, { date: to_date }, {
            total_sale: moved.total_sale, swiggy_sale: moved.swiggy_sale, zomato_sale: moved.zomato_sale, other_delivery_sale: moved.other_delivery_sale,
            cancelled_orders: moved.cancelled_orders, complimentary_amount: moved.complimentary_amount, complimentary_reason: moved.complimentary_reason,
            zomato_district: moved.zomato_district, upi_collected: moved.upi_collected, cash_collected: moved.cash_collected, prev_day_cash: moved.prev_day_cash,
            cash_expense: moved.cash_expense, cash_expense_note: moved.cash_expense_note, cash_deposited: moved.cash_deposited, notes: moved.notes,
          }).catch(() => {});

          result.moved.push({ type: 'sales' });
        }
      }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Converts a raw stored quantity (recorded in some unit — often a demand-form unit like
// Tin or Batch) to the item's rate-card display unit, same chain computeStockUsageForDate
// uses (unit_conversions row, then an SI gm/kg or ml/ltr step). Scoped to one item so
// qty-edit doesn't need to load the whole rate card / conversion table like the P&L
// aggregation does.
function unitFactor(rawUnit, conv, itemUnit) {
  const du = (rawUnit || '').toLowerCase();
  const iu = (itemUnit || '').toLowerCase();
  let factor = 1, resolvedUnit = du;
  if (conv && du === (conv.unit_type || '').toLowerCase()) {
    factor = Number(conv.qty) || 1;
    resolvedUnit = (conv.base_unit || '').toLowerCase();
  } else if (conv && conv.base_unit && du === (conv.base_unit || '').toLowerCase()) {
    // Recorded directly in the conversion's base unit (e.g. "Piece" for an item whose
    // custom unit is Pkt) — invert instead of silently treating it as a 1:1 match.
    factor = 1 / (Number(conv.qty) || 1);
    resolvedUnit = (conv.unit_type || '').toLowerCase();
  }
  if (resolvedUnit !== iu) {
    if ((resolvedUnit === 'gm' || resolvedUnit === 'g') && iu === 'kg') factor *= 0.001;
    else if (resolvedUnit === 'kg' && (iu === 'gm' || iu === 'g')) factor *= 1000;
    else if (resolvedUnit === 'ml' && (iu === 'ltr' || iu === 'l')) factor *= 0.001;
    else if ((resolvedUnit === 'ltr' || resolvedUnit === 'l') && iu === 'ml') factor *= 1000;
  }
  return factor || 1;
}

async function getItemUnitInfo(itemId) {
  const [{ data: rate }, { data: demandItem }, { data: conv }] = await Promise.all([
    supabase.from('rate_card').select('unit').eq('id', itemId).eq('active', true).maybeSingle(),
    supabase.from('demand_items').select('unit').eq('id', itemId).maybeSingle(),
    supabase.from('unit_conversions').select('unit_type, qty, base_unit').eq('item_id', itemId).eq('active', true).maybeSingle(),
  ]);
  const itemUnit = rate?.unit || demandItem?.unit || '';
  const demandUnit = demandItem?.unit || itemUnit || '';
  return { itemUnit, demandUnit, conv: conv || null };
}

// Shared by 'stock_dispatched' and 'stock_wastage': a stock-based P&L row's displayed
// total (e.g. "Dispatched: 30 Kg") is a SUM of possibly several raw demand rows, each
// recorded in its own unit — there's no single record to overwrite with the owner's
// typed total the way the old code assumed. Instead this computes the CURRENT total in
// display units, works out the delta from the desired total, converts that delta back
// into one target row's raw unit, and adds it there — preserving every other row as-is
// rather than clobbering all matching rows with the same (wrong-unit) value.
async function applyStockLegDelta({ rows, itemId, column, desiredDisplayTotal, itemUnit, demandUnit, conv }) {
  let currentDisplayTotal = 0;
  rows.forEach(row => {
    const raw = row[column]?.[itemId];
    const rawQty = typeof raw === 'object' && raw !== null ? Number(raw.qty) : Number(raw);
    const rawUnit = row.items_units?.[itemId] || demandUnit;
    currentDisplayTotal += (rawQty || 0) * unitFactor(rawUnit, conv, itemUnit);
  });

  const deltaDisplay = desiredDisplayTotal - currentDisplayTotal;
  const target = rows[0];
  const targetRawUnit = target.items_units?.[itemId] || demandUnit;
  const targetFactor = unitFactor(targetRawUnit, conv, itemUnit);
  const targetOldRaw = target[column]?.[itemId];
  const targetOldQty = typeof targetOldRaw === 'object' && targetOldRaw !== null ? Number(targetOldRaw.qty) : Number(targetOldRaw || 0);
  const targetNewQty = Math.max(0, targetOldQty + deltaDisplay / targetFactor);

  const newMap = { ...(target[column] || {}) };
  newMap[itemId] = typeof targetOldRaw === 'object' && targetOldRaw !== null ? { ...targetOldRaw, qty: targetNewQty } : targetNewQty;

  return { targetRowId: target.id, newMap, currentDisplayTotal };
}

// ── PATCH /api/qty-edit — Owner/Store manager edits a demand/dispatch/wastage/
// closing-stock item qty. record_type selects the target: 'demand' (default,
// dispatched/demand qty on a manual demand row), 'wastage' (demands table,
// type='wastage'), 'closing_stock' (its own table, cs_-prefixed item keys),
// 'stock_dispatched'/'stock_wastage' (P&L's consumed-material rows, which show a
// converted/summed total rather than one raw record — see applyStockLegDelta).
// Every edit is logged to qty_corrections for the Corrections Log / System Logs.
router.patch('/qty-edit', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { outlet_id, date, item_id, new_qty, reason, record_type } = req.body;
    if (!outlet_id || !date || !item_id) {
      return res.status(400).json({ error: 'outlet_id, date, and item_id are required' });
    }
    if (new_qty === undefined || new_qty === null || isNaN(Number(new_qty))) {
      return res.status(400).json({ error: 'new_qty required and must be a number' });
    }
    if (Number(new_qty) < 0) {
      return res.status(400).json({ error: 'new_qty cannot be negative' });
    }

    const correctorName = req.headers['x-user-name'] ||
      (await supabase.from('app_users').select('name').eq('id', req.headers['x-user-id']).single()).data?.name ||
      'owner';

    if (record_type === 'stock_dispatched' || record_type === 'stock_wastage') {
      const isWastage = record_type === 'stock_wastage';
      const { itemUnit, demandUnit, conv } = await getItemUnitInfo(item_id);

      const { data: allRows, error: loadErr } = await supabase.from('demands')
        .select('id, type, status, items, dispatch_items, items_units')
        .eq('outlet_id', outlet_id).eq('date', date);
      if (loadErr) throw loadErr;

      const candidateRows = isWastage
        ? (allRows || []).filter(d => d.type === 'wastage')
        : (allRows || []).filter(d => d.type !== 'closing' && d.type !== 'wastage');
      const matching = candidateRows.filter(d => {
        const map = isWastage ? (d.items || {}) : (d.dispatch_items || d.items || {});
        return map[item_id] !== undefined;
      });

      if (matching.length === 0) {
        // No baseline record to adjust — create one directly with the desired total,
        // converted into the demand form's raw unit so it reads consistently later.
        const factor = unitFactor(demandUnit, conv, itemUnit);
        const rawQty = Number(new_qty) / factor;
        const insertPayload = isWastage
          ? { outlet_id, date, type: 'wastage', status: 'submitted', items: { [item_id]: rawQty }, items_units: { [item_id]: demandUnit }, submitted_by: correctorName, submitted_at: new Date().toISOString() }
          : { outlet_id, date, type: 'manual', status: 'fulfilled', items: { [item_id]: rawQty }, dispatch_items: { [item_id]: rawQty }, items_units: { [item_id]: demandUnit }, submitted_by: correctorName, submitted_at: new Date().toISOString() };
        const { error: insertErr } = await supabase.from('demands').insert(insertPayload);
        if (insertErr) throw insertErr;
        await supabase.from('qty_corrections').insert({
          demand_id: null, outlet_id, date, item_id, old_qty: 0, new_qty: Number(new_qty),
          unit: itemUnit, reason: reason || null, corrected_by: correctorName,
        });
        return res.json({ ok: true, updated: 1, created: true });
      }

      const column = isWastage ? 'items' : (matching[0].dispatch_items?.[item_id] !== undefined ? 'dispatch_items' : 'items');
      const { targetRowId, newMap, currentDisplayTotal } = await applyStockLegDelta({
        rows: matching, itemId: item_id, column, desiredDisplayTotal: Number(new_qty), itemUnit, demandUnit, conv,
      });

      const { error: updateErr } = await supabase.from('demands').update({ [column]: newMap }).eq('id', targetRowId);
      if (updateErr) throw updateErr;

      await supabase.from('qty_corrections').insert({
        demand_id: targetRowId, outlet_id, date, item_id,
        old_qty: Math.round(currentDisplayTotal * 1000) / 1000, new_qty: Number(new_qty),
        unit: itemUnit, reason: reason || null, corrected_by: correctorName,
      });
      return res.json({ ok: true, updated: matching.length, adjusted_row: targetRowId });
    }

    if (record_type === 'closing_stock') {
      const { data: row, error: loadErr } = await supabase.from('closing_stocks')
        .select('*').eq('outlet_id', outlet_id).eq('date', date).maybeSingle();
      if (loadErr) throw loadErr;

      if (!row) {
        // No closing stock submitted at all for this outlet+date yet — create the
        // row with just this one item, same as if the outlet manager had submitted it.
        // closing_stocks.submitted_by is a foreign key into Supabase Auth's users table,
        // which this app doesn't use (it has its own app_users/PIN login) — every existing
        // row already leaves it null, so match that rather than fail the insert.
        const { error: insertErr } = await supabase.from('closing_stocks').insert({
          outlet_id, date, items: { [`cs_${item_id}`]: Number(new_qty) },
          submitted_by: null, submitted_at: new Date().toISOString(),
        });
        if (insertErr) throw insertErr;
        await supabase.from('qty_corrections').insert({
          demand_id: null, outlet_id, date, item_id, old_qty: 0, new_qty: Number(new_qty),
          unit: null, reason: reason || null, corrected_by: correctorName,
        });
        return res.json({ ok: true, updated: 1, created: true });
      }

      const key = Object.keys(row.items || {}).find(k => k === item_id || k === `cs_${item_id}`) || `cs_${item_id}`;
      const oldQty = Number((row.items || {})[key]) || 0;
      const newItems = { ...row.items, [key]: Number(new_qty) };
      const { error: updateErr } = await supabase.from('closing_stocks').update({ items: newItems }).eq('id', row.id);
      if (updateErr) throw updateErr;
      await supabase.from('qty_corrections').insert({
        demand_id: null, outlet_id, date, item_id, old_qty: oldQty, new_qty: Number(new_qty),
        unit: null, reason: reason || null, corrected_by: correctorName,
      });
      return res.json({ ok: true, updated: 1 });
    }

    if (record_type === 'wastage') {
      const { data: rows, error: loadErr } = await supabase.from('demands')
        .select('id, items').eq('outlet_id', outlet_id).eq('date', date).eq('type', 'wastage');
      if (loadErr) throw loadErr;
      const matching = (rows || []).filter(d => (d.items || {})[item_id] !== undefined);

      if (matching.length === 0) {
        if ((rows || []).length > 0) {
          // A wastage submission exists for this date but doesn't include this item yet — add it.
          const target = rows[0];
          const newItems = { ...target.items, [item_id]: Number(new_qty) };
          const { error: updateErr } = await supabase.from('demands').update({ items: newItems }).eq('id', target.id);
          if (updateErr) throw updateErr;
          await supabase.from('qty_corrections').insert({
            demand_id: target.id, outlet_id, date, item_id, old_qty: 0, new_qty: Number(new_qty),
            unit: null, reason: reason || null, corrected_by: correctorName,
          });
          return res.json({ ok: true, updated: 1 });
        }
        // No wastage submitted at all for this outlet+date — create it, same as a manager submission.
        const { error: insertErr } = await supabase.from('demands').insert({
          outlet_id, date, type: 'wastage', status: 'submitted', items: { [item_id]: Number(new_qty) },
          submitted_by: correctorName, submitted_at: new Date().toISOString(),
        });
        if (insertErr) throw insertErr;
        await supabase.from('qty_corrections').insert({
          demand_id: null, outlet_id, date, item_id, old_qty: 0, new_qty: Number(new_qty),
          unit: null, reason: reason || null, corrected_by: correctorName,
        });
        return res.json({ ok: true, updated: 1, created: true });
      }

      const corrections = [];
      for (const row of matching) {
        const oldQty = Number(row.items[item_id]);
        const newItems = { ...row.items, [item_id]: Number(new_qty) };
        const { error: updateErr } = await supabase.from('demands').update({ items: newItems }).eq('id', row.id);
        if (updateErr) throw updateErr;
        corrections.push({ demand_id: row.id, old_qty: oldQty });
      }
      for (const c of corrections) {
        await supabase.from('qty_corrections').insert({
          demand_id: c.demand_id, outlet_id, date, item_id, old_qty: c.old_qty, new_qty: Number(new_qty),
          unit: null, reason: reason || null, corrected_by: correctorName,
        });
      }
      return res.json({ ok: true, updated: corrections.length, corrections });
    }

    // Default ('demand'): dispatched/demand qty on a manual demand row.
    // 1. Find all demand rows for this outlet+date that contain the item
    const { data: allDemands, error: loadErr } = await supabase.from('demands')
      .select('id, outlet_id, date, type, items, dispatch_items, status')
      .eq('outlet_id', outlet_id).eq('date', date);
    if (loadErr) throw loadErr;

    // 2. Find demands that have this item in dispatch_items or items (skip closing/wastage types)
    const matchingDemands = (allDemands || []).filter(d => {
      if (d.type === 'closing' || d.type === 'wastage') return false;
      const dispItems = d.dispatch_items || d.items || {};
      return dispItems[item_id] !== undefined;
    });

    if (matchingDemands.length === 0) {
      return res.status(404).json({ error: `Item '${item_id}' not found in any demand for ${outlet_id} on ${date}` });
    }

    // 3. Update ALL matching demands (could be morning + evening)
    const corrections = [];
    for (const order of matchingDemands) {
      const useDispatch = order.dispatch_items && order.dispatch_items[item_id] !== undefined;
      const column = useDispatch ? 'dispatch_items' : 'items';
      const currentMap = { ...(order[column] || {}) };
      const oldVal = currentMap[item_id];
      const oldQty = typeof oldVal === 'object' && oldVal !== null ? Number(oldVal.qty) : Number(oldVal);

      // Write new value preserving shape
      if (typeof oldVal === 'object' && oldVal !== null) {
        currentMap[item_id] = { ...oldVal, qty: Number(new_qty) };
      } else {
        currentMap[item_id] = Number(new_qty);
      }

      // Update the demand row
      const { error: updateErr } = await supabase.from('demands')
        .update({ [column]: currentMap })
        .eq('id', order.id);
      if (updateErr) throw updateErr;

      corrections.push({ demand_id: order.id, old_qty: oldQty });
    }

    // 4. Log corrections
    for (const c of corrections) {
      await supabase.from('qty_corrections').insert({
        demand_id: c.demand_id,
        outlet_id,
        date,
        item_id,
        old_qty: c.old_qty,
        new_qty: Number(new_qty),
        unit: null,
        reason: reason || null,
        corrected_by: correctorName,
      });
    }

    res.json({ ok: true, updated: corrections.length, corrections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/qty-edit-batch — Owner/Store manager saves multiple item edits for ONE
// outlet+date+record_type in a single request. Exists specifically to avoid a read-
// modify-write race: /qty-edit reads the row, merges in one field, and writes it back —
// firing that per-cell in parallel (as the Closing Stock/Wastage grid's batch "Save"
// does) means several requests read the SAME pre-edit row, and whichever write lands
// last wins, silently discarding every other concurrent edit to that row. This endpoint
// reads the row once, applies every edit to one in-memory copy, and writes once, so
// there's only ever a single write per row no matter how many cells changed.
router.patch('/qty-edit-batch', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { outlet_id, date, record_type, edits, reason } = req.body;
    if (!outlet_id || !date || !Array.isArray(edits) || edits.length === 0) {
      return res.status(400).json({ error: 'outlet_id, date, and a non-empty edits[] are required' });
    }
    for (const e of edits) {
      if (!e.item_id || e.new_qty === undefined || e.new_qty === null || isNaN(Number(e.new_qty))) {
        return res.status(400).json({ error: `Invalid edit for item '${e.item_id}': new_qty must be a number` });
      }
      if (Number(e.new_qty) < 0) {
        return res.status(400).json({ error: `${e.item_id}: quantity cannot be negative` });
      }
    }

    const correctorName = req.headers['x-user-name'] ||
      (await supabase.from('app_users').select('name').eq('id', req.headers['x-user-id']).single()).data?.name ||
      'owner';

    if (record_type === 'closing_stock') {
      const { data: row, error: loadErr } = await supabase.from('closing_stocks')
        .select('*').eq('outlet_id', outlet_id).eq('date', date).maybeSingle();
      if (loadErr) throw loadErr;

      const items = { ...(row?.items || {}) };
      const corrections = [];
      for (const { item_id, new_qty } of edits) {
        const key = Object.keys(items).find(k => k === item_id || k === `cs_${item_id}`) || `cs_${item_id}`;
        const oldQty = Number(items[key]) || 0;
        items[key] = Number(new_qty);
        corrections.push({ item_id, old_qty: oldQty, new_qty: Number(new_qty) });
      }

      if (row) {
        const { error: updateErr } = await supabase.from('closing_stocks').update({ items }).eq('id', row.id);
        if (updateErr) throw updateErr;
      } else {
        const { error: insertErr } = await supabase.from('closing_stocks').insert({
          outlet_id, date, items, submitted_by: null, submitted_at: new Date().toISOString(),
        });
        if (insertErr) throw insertErr;
      }
      await supabase.from('qty_corrections').insert(corrections.map(c => ({
        demand_id: null, outlet_id, date, item_id: c.item_id, old_qty: c.old_qty, new_qty: c.new_qty,
        unit: null, reason: reason || null, corrected_by: correctorName,
      })));
      return res.json({ ok: true, updated: corrections.length });
    }

    if (record_type === 'wastage') {
      const { data: rows, error: loadErr } = await supabase.from('demands')
        .select('id, items').eq('outlet_id', outlet_id).eq('date', date).eq('type', 'wastage');
      if (loadErr) throw loadErr;
      const targetRows = (rows || []).map(r => ({ id: r.id, items: { ...(r.items || {}) } }));

      const corrections = [];
      const changedRowIds = new Set();
      let newRowItems = null;
      for (const { item_id, new_qty } of edits) {
        let target = targetRows.find(r => r.items[item_id] !== undefined) || targetRows[0];
        if (target) {
          const oldQty = Number(target.items[item_id]) || 0;
          target.items[item_id] = Number(new_qty);
          changedRowIds.add(target.id);
          corrections.push({ demand_id: target.id, item_id, old_qty: oldQty, new_qty: Number(new_qty) });
        } else {
          if (!newRowItems) newRowItems = {};
          const oldQty = Number(newRowItems[item_id]) || 0;
          newRowItems[item_id] = Number(new_qty);
          corrections.push({ demand_id: null, item_id, old_qty: oldQty, new_qty: Number(new_qty), _new: true });
        }
      }
      for (const row of targetRows) {
        if (!changedRowIds.has(row.id)) continue;
        const { error: updateErr } = await supabase.from('demands').update({ items: row.items }).eq('id', row.id);
        if (updateErr) throw updateErr;
      }
      if (newRowItems) {
        const { data: created, error: insertErr } = await supabase.from('demands').insert({
          outlet_id, date, type: 'wastage', status: 'submitted', items: newRowItems,
          submitted_by: correctorName, submitted_at: new Date().toISOString(),
        }).select().single();
        if (insertErr) throw insertErr;
        corrections.forEach((c) => { if (c._new) c.demand_id = created.id; });
      }
      await supabase.from('qty_corrections').insert(corrections.map(c => ({
        demand_id: c.demand_id, outlet_id, date, item_id: c.item_id, old_qty: c.old_qty, new_qty: c.new_qty,
        unit: null, reason: reason || null, corrected_by: correctorName,
      })));
      return res.json({ ok: true, updated: corrections.length });
    }

    res.status(400).json({ error: `Unsupported record_type '${record_type}' for batch edit` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/corrections — Owner: list recent qty corrections
router.get('/corrections', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, date, item_id, limit = 100 } = req.query;
    let q = supabase.from('qty_corrections').select('*')
      .order('corrected_at', { ascending: false }).limit(Math.min(Number(limit), 500));
    if (outlet_id) q = q.eq('outlet_id', outlet_id);
    if (date) q = q.eq('date', date);
    if (item_id) q = q.eq('item_id', item_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orders/:id/challan — Get dispatch challan for an order
router.get('/orders/:id/challan', async (req, res) => {
  try {
    const { data, error } = await supabase.from('demands')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// FIX: Missing routes that frontend expects (were causing 404s)
// ============================================================

// ── GET /api/sales — Frontend calls getSales(params) with query params
// Backend had /sales/:date but frontend expects /sales?date=...&outlet=...
router.get('/sales', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner', 'avp', 'head_chef', 'franchise', 'bk_manager');
    if (!user) return;
    const { date, from, to } = req.query;
    const outlet = scopedOutletFilter(user, req.query.outlet);
    if (!date && !(from && to)) return res.status(400).json({ error: 'date, or from+to, query param required' });

    const [data, costingContext, crockeryPackagingRules] = await Promise.all([
      fetchAllDailySales({ date, from, to, outlet_code: (outlet && outlet !== 'all') ? outlet : undefined }),
      // Priced as-of the day (single-date) or the range end (from/to) so packaging/crockery
      // economics reflect the prices in effect then, not just today's.
      buildCostingContext(date || to),
      getCrockeryPackagingRules(),
    ]);
    const { rateMap, convFactorFor } = costingContext;

    // Dine In / Pickup / Delivery — three separate buckets for unit-economics purposes, even
    // though the underlying packaging/crockery allowance rule (below) still treats Pickup and
    // Delivery as one "takeaway" need (same box either way) — same order_type convention used
    // everywhere else in this file (computeDailySalesRevenue, computeCrockeryPackagingItems,
    // the outlet-level counts below).
    const bucketOf = (row) => row.order_type === 'Dine In' ? 'dine_in'
      : row.order_type === 'Pick Up' ? 'pickup'
      : row.order_type?.includes('Delivery') ? 'delivery' : null;

    // Packaging/Crockery add-on cost per item — the fixed per-outlet-per-day operational
    // allowance (see computeCrockeryPackagingItems, now covering all 6 outlets) isn't a
    // per-dish recipe, so there's no dish-specific "this parcel needs 1 box" fact to attach
    // directly. Instead it's averaged: every Dine-in unit sold at that outlet that day shares
    // that day's total crockery cost equally; every Pickup/Delivery unit shares that day's
    // total packaging cost equally (computed once across BOTH, since the rule itself doesn't
    // distinguish a customer pickup from a Swiggy/Zomato delivery — same box either way — so
    // Pickup and Delivery get the identical ₹/unit rate here, just kept as separate columns
    // downstream).
    const byOutletDay = {};
    (data || []).forEach((r) => {
      const key = `${r.outlet_code}|${r.sale_date}`;
      (byOutletDay[key] || (byOutletDay[key] = [])).push(r);
    });
    const addonPerUnit = {}; // "outlet|date" -> { dine_in, pickup, delivery } — ₹ per unit sold
    Object.entries(byOutletDay).forEach(([key, rows]) => {
      const [oid] = key.split('|');
      const dineInQty = rows.filter((r) => r.order_type === 'Dine In').reduce((s, r) => s + Number(r.item_quantity || 0), 0);
      const takeawayQty = rows.filter((r) => r.order_type === 'Pick Up' || r.order_type?.includes('Delivery')).reduce((s, r) => s + Number(r.item_quantity || 0), 0);
      // Sambhar/Chutney sides are per-order (see SAMBHAR_CHUTNEY_SIDES) but only for orders
      // containing a Dosa/Idli/Vada item — so their cost is spread only across THOSE items'
      // units that day, not all takeaway units (a rice-only order shouldn't absorb a share
      // of a side it never got).
      const sidesEligibleQty = rows.filter((r) => (r.order_type === 'Pick Up' || r.order_type?.includes('Delivery')) && isDosaIdliVadaRow(r)).reduce((s, r) => s + Number(r.item_quantity || 0), 0);
      const crockeryItems = computeCrockeryPackagingItems(oid, rows, {}, rateMap, convFactorFor, crockeryPackagingRules);
      let dineInCost = 0, takeawayCost = 0, sidesCost = 0;
      crockeryItems.forEach((it) => {
        if (it.rate == null) return;
        (it.should_consume_breakdown || []).forEach((b) => {
          const c = b.per_dish * b.qty_sold * it.rate;
          if (b.dish === 'Dine-in items (crockery)') dineInCost += c;
          else if (b.dish === 'Pickup/Delivery orders (packaging)') takeawayCost += c;
          else if (b.dish === 'Pickup/Delivery orders with Dosa/Idli/Vada (sides)') sidesCost += c;
        });
      });
      const dineInRate = dineInQty > 0 ? dineInCost / dineInQty : 0;
      const takeawayRate = takeawayQty > 0 ? takeawayCost / takeawayQty : 0;
      const sidesRate = sidesEligibleQty > 0 ? sidesCost / sidesEligibleQty : 0;
      addonPerUnit[key] = { dine_in: dineInRate, pickup: takeawayRate, delivery: takeawayRate, sides: sidesRate };
    });

    // Category-matched containers (Dosa Box Small, Podi Idli Container, 500ML Container,
    // Vada Lifafa) are deterministic per single unit sold — unlike the averaged Bio Spoon
    // rate above, there's no need to spread these across the outlet-day; a dosa parcel
    // always needs exactly 1 Dosa Box Small regardless of what else sold that day. Computed
    // once here (₹ per unit of a matching dish) and added on top of addonPerUnit per row below.
    const categoryContainerRate = {}; // TAKEAWAY_CATEGORY_CONTAINERS key -> ₹ per matching unit sold
    TAKEAWAY_CATEGORY_CONTAINERS.forEach((rule) => {
      const trackedUnit = rateMap[rule.item_id]?.unit || 'Pcs';
      const perUnit = convFactorFor(rule.item_id, 'Piece', trackedUnit);
      const price = rateMap[rule.item_id]?.price;
      categoryContainerRate[rule.key] = price != null ? perUnit * price : 0;
    });

    // Aggregate by item — split into Dine In / Pickup / Delivery sub-totals too, each
    // carrying its own packaging/crockery add-on cost, so the Sales tab can show true
    // per-unit economics depending on how an item was actually sold, not just recipe food cost.
    const itemMap = {};
    const outletMap = {};
    let totalOrders = new Set();

    (data || []).forEach(row => {
      if (!itemMap[row.item_name]) {
        itemMap[row.item_name] = {
          item_name: row.item_name, category: row.category_name, qty: 0, revenue: 0,
          dine_in_qty: 0, dine_in_revenue: 0, dine_in_addon_cost: 0,
          pickup_qty: 0, pickup_revenue: 0, pickup_addon_cost: 0,
          delivery_qty: 0, delivery_revenue: 0, delivery_addon_cost: 0, delivery_commission_cost: 0,
        };
      }
      itemMap[row.item_name].qty += row.item_quantity;
      itemMap[row.item_name].revenue += row.item_total;
      const bucket = bucketOf(row);
      if (bucket) {
        const rate = addonPerUnit[`${row.outlet_code}|${row.sale_date}`]?.[bucket] || 0;
        let categoryRate = 0, sidesRate = 0;
        if ((bucket === 'pickup' || bucket === 'delivery') && CROCKERY_PACKAGING_OUTLETS.has(row.outlet_code)) {
          const match = matchTakeawayCategoryContainer(row);
          if (match) categoryRate = categoryContainerRate[match.key] || 0;
          if (isDosaIdliVadaRow(row)) sidesRate = addonPerUnit[`${row.outlet_code}|${row.sale_date}`]?.sides || 0;
        }
        itemMap[row.item_name][`${bucket}_qty`] += Number(row.item_quantity || 0);
        itemMap[row.item_name][`${bucket}_revenue`] += Number(row.item_total || 0);
        itemMap[row.item_name][`${bucket}_addon_cost`] += Number(row.item_quantity || 0) * (rate + categoryRate + sidesRate);
        // Swiggy/Zomato charge 40% commission on the order value — same rate P&L's
        // deliveryCommission uses (see computeDailySalesRevenue's swiggy/zomato split by
        // `area`). "Other" aggregator delivery (area not Zomato/Swiggy — e.g. own-fleet)
        // pays no platform commission, so it's excluded here, matching P&L's own_delivery
        // treatment.
        if (bucket === 'delivery' && (row.area === 'Zomato' || row.area === 'Swiggy')) {
          itemMap[row.item_name].delivery_commission_cost += Number(row.item_total || 0) * 0.4;
        }
      }

      if (!outletMap[row.outlet_code]) {
        outletMap[row.outlet_code] = { outlet_code: row.outlet_code, outlet_name: row.outlet, orders: new Set(), revenue: 0, dine_in: 0, delivery: 0, pickup: 0, dine_in_revenue: 0, delivery_revenue: 0, pickup_revenue: 0 };
      }
      outletMap[row.outlet_code].orders.add(row.invoice_no);
      totalOrders.add(row.invoice_no);
    });

    const orderRevenue = {};
    (data || []).forEach(row => {
      const key = `${row.outlet_code}-${row.invoice_no}`;
      if (!orderRevenue[key]) {
        orderRevenue[key] = { outlet_code: row.outlet_code, total: row.order_total, order_type: row.order_type };
      }
    });

    // Store Sales (dine-in + pickup) vs Delivery (Swiggy/Zomato/other delivery partners) —
    // same order_type classification as the existing dine_in/delivery/pickup order counts,
    // just summing order_total instead of counting, so the split always matches the totals.
    Object.values(orderRevenue).forEach(order => {
      if (outletMap[order.outlet_code]) {
        outletMap[order.outlet_code].revenue += order.total;
        if (order.order_type === 'Dine In') { outletMap[order.outlet_code].dine_in++; outletMap[order.outlet_code].dine_in_revenue += order.total; }
        else if (order.order_type?.includes('Delivery')) { outletMap[order.outlet_code].delivery++; outletMap[order.outlet_code].delivery_revenue += order.total; }
        else if (order.order_type === 'Pick Up') { outletMap[order.outlet_code].pickup++; outletMap[order.outlet_code].pickup_revenue += order.total; }
      }
    });

    Object.values(outletMap).forEach(o => { o.orders = o.orders.size; });

    const items = Object.values(itemMap)
      .map((i) => ({ ...i, dine_in_addon_cost: Math.round(i.dine_in_addon_cost * 100) / 100, pickup_addon_cost: Math.round(i.pickup_addon_cost * 100) / 100, delivery_addon_cost: Math.round(i.delivery_addon_cost * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue);
    const outlets = Object.values(outletMap);

    res.json({
      date,
      total_items: items.length,
      total_orders: totalOrders.size,
      total_revenue: items.reduce((s, i) => s + i.revenue, 0),
      items,
      outlets,
      // What's covered by the Packaging/Crockery add-on above — sent alongside so the
      // Sales tab's "what's included" dropdown doesn't need a second round trip.
      crockery_packaging_rules: crockeryPackagingRules,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/recipes/petpooja — Frontend calls getRecipesPetpooja()
// Backend had /recipes but frontend expects /recipes/petpooja
router.get('/recipes/petpooja', async (req, res) => {
  try {
    const { data: recipes, error } = await supabase
      .from('recipes')
      .select(`
        id, item_name, item_type, category, status,
        recipe_ingredients (
          id, raw_material, qty, unit, qty_kg
        )
      `)
      .eq('status', 'Active')
      .order('item_name');

    if (error) throw error;
    res.json(recipes || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STAFF DEMANDS — Food & Dress Requests
// ============================================================

// ── GET /api/staff-demands/items — Get master staff demand items (DB-driven)
router.get('/staff-demands/items', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_demand_items')
      .select('*')
      .eq('active', true)
      .order('category')
      .order('sort_order');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/staff-demands — Get staff demands (filter by outlet, date, category)
router.get('/staff-demands', async (req, res) => {
  try {
    const { outlet_id, date, category, shift } = req.query;
    let query = supabase.from('staff_demands').select('*');
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    if (date) query = query.eq('date', date);
    if (category) query = query.eq('category', category);
    if (shift) query = query.eq('shift', shift);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/staff-demands — Submit a staff demand (food or dress)
router.post('/staff-demands', async (req, res) => {
  try {
    const { outlet_id, date, shift, category, items, note, submitted_by } = req.body;
    if (!outlet_id || !category || !items || items.length === 0) {
      return res.status(400).json({ error: 'outlet_id, category, and items are required' });
    }

    // For food: upsert by outlet+date+shift+category (one entry per shift)
    if (category === 'food' && shift) {
      const { data, error } = await supabase.from('staff_demands').upsert({
        outlet_id,
        date: date || todayIST(),
        shift,
        category,
        items,
        note,
        submitted_by: submitted_by || outlet_id,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'outlet_id,date,shift,category' });
      if (error) throw error;
      return res.json({ ok: true, type: 'upsert' });
    }

    // For dress: always insert (no upsert)
    const { data, error } = await supabase.from('staff_demands').insert({
      outlet_id,
      date: date || todayIST(),
      shift: shift || null,
      category,
      items,
      note,
      submitted_by: submitted_by || outlet_id,
    });
    if (error) throw error;
    res.json({ ok: true, type: 'insert' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/staff-demands/items — Add new staff demand item
router.post('/staff-demands/items', async (req, res) => {
  try {
    const { id, category, name, unit, input_type, options, sort_order } = req.body;
    const { error } = await supabase.from('staff_demand_items').upsert({
      id, category, name, unit, input_type: input_type || 'number',
      options: options || null, sort_order: sort_order || 99,
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/staff-demands/items/:id — Soft delete
router.delete('/staff-demands/items/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('staff_demand_items')
      .update({ active: false })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// RATE CARD — Item prices for P&L calculation
// ============================================================

// ── GET /api/rate-card — All active rates
router.get('/rate-card', async (req, res) => {
  try {
    // avp/head_chef need read access too — the Item-wise Sales "+ Recipe" ingredient
    // picker (SalesUpload) loads the full rate card to offer as ingredient candidates
    // alongside raw_materials, and those two roles can already reach it.
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { data, error } = await supabase.from('rate_card').select('*')
      .eq('active', true).order('category').order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rate-card — Add/update rate
router.post('/rate-card', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner'); // returns the user object (for created_by), owner-only
    if (!user) return;
    const { id, name, category, unit, price } = req.body;
    const { error } = await supabase.from('rate_card').upsert({
      id, name, category, unit, price: price || 0, updated_at: new Date().toISOString()
    });
    if (error) throw error;
    // Record the manual price in the ledger, effective today — REQUIRED, not optional: a
    // dated read resolves as-of the ledger, so without this row every dated calculation
    // (P&L, RM Audit) would keep seeing the item's previous ledger price and the owner's
    // edit would silently not take effect. Forward-only, so it never rewrites the past.
    if (price != null && Number.isFinite(Number(price))) {
      await appendRateCardPrice({ rateCardId: id, effectiveDate: todayIST(), price, source: 'manual', createdBy: user.name });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/rate-card/:id — Update price
router.patch('/rate-card/:id', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner'); // returns the user object (for created_by), owner-only
    if (!user) return;
    const updates = {};
    if (req.body.price !== undefined) updates.price = req.body.price;
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.unit !== undefined) updates.unit = req.body.unit;
    if (req.body.category !== undefined) updates.category = req.body.category;
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase.from('rate_card').update(updates).eq('id', req.params.id);
    if (error) throw error;
    // Append a manual ledger row when the price changed, effective today — required for the
    // edit to take effect under as-of pricing (see POST /rate-card). Forward-only.
    if (req.body.price !== undefined && Number.isFinite(Number(req.body.price))) {
      await appendRateCardPrice({ rateCardId: req.params.id, effectiveDate: todayIST(), price: req.body.price, source: 'manual', createdBy: user.name });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/rate-card/:id — Soft delete
router.delete('/rate-card/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('rate_card').update({ active: false }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/rate-card/price-matrix — the Rate Alert spreadsheet: every active item with
// its full dated price series (from rate_card_prices), collapsed to one price per day
// (latest wins on a day with two challans). The frontend pivots this into an items × dates
// grid with per-step deltas. Registered BEFORE /rate-card/:id/... so "price-matrix" isn't
// captured as an :id.
router.get('/rate-card/price-matrix', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef', 'bk_manager', 'store_mgr')) return;
    const [{ data: rc, error: rcErr }, { data: rows, error: rowsErr }] = await Promise.all([
      supabase.from('rate_card').select('id, name, category, unit').eq('active', true),
      supabase.from('rate_card_prices').select('rate_card_id, effective_date, price, source, created_at'),
    ]);
    if (rcErr) throw rcErr;
    if (rowsErr) throw rowsErr;
    // Collapse to one price per (item, effective_date) — latest created wins, matching the
    // as-of resolver's own same-day tie-break.
    const byItem = {};
    (rows || []).forEach(r => {
      const m = (byItem[r.rate_card_id] ||= {});
      const cur = m[r.effective_date];
      if (!cur || r.created_at > cur.created_at) m[r.effective_date] = { price: Number(r.price), source: r.source, created_at: r.created_at };
    });
    const items = (rc || []).map(it => ({
      id: it.id, name: it.name, category: it.category, unit: it.unit,
      prices: Object.entries(byItem[it.id] || {})
        // created_at included for the SEED_DATE ("Opening") row specifically — that row's
        // effective_date is a synthetic placeholder (2000-01-01), so the frontend shows
        // when this baseline price was actually recorded instead of that fake date.
        .map(([effective_date, v]) => ({ effective_date, price: v.price, source: v.source, created_at: v.created_at }))
        .sort((a, b) => (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : 0)),
    })).sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/rate-card/:id/price-history — the dated price ledger for one item, newest
// first: every challan/purchase/manual/seed price change with its effective date and source.
// Backs the Rate Card master's "price history" popover and the "last updated" badge.
router.get('/rate-card/:id/price-history', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const { data, error } = await supabase.from('rate_card_prices')
      .select('effective_date, price, source, source_id, created_by, created_at')
      .eq('rate_card_id', req.params.id)
      .order('effective_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// FIXED COSTS — Monthly recurring costs per outlet
// ============================================================
// Each row now belongs to a specific month (2026_08_12_fixed_costs_monthly.sql) instead
// of being one evergreen value forever — Water/Electricity/Wastage genuinely differ
// month to month, so a single current figure was silently misrepresenting every PAST
// month's P&L (Finance module, Daily P&L) as if that same number applied then too.
// resolveFixedCostsForMonth below is the read-side rule both use: for a target month,
// take the LATEST row at-or-before that month per (outlet_id, cost_head) — so Rent/
// Salary (rarely changed) don't need re-entry every month, while a head with a fresher
// entry for the target month uses that instead. `is_current_month` tells the caller
// (FixedCostsPanel) whether this is a real entry for the month being viewed or a
// carried-forward value from an earlier month.
function resolveFixedCostsForMonth(allRows, targetMonth) {
  const latest = {}; // "outlet_id|cost_head" -> best row so far (month <= targetMonth, highest month)
  (allRows || []).forEach((r) => {
    if (r.month > targetMonth) return; // a future month's entry doesn't apply yet
    const key = `${r.outlet_id}|${r.cost_head}`;
    if (!latest[key] || r.month > latest[key].month) latest[key] = r;
  });
  return Object.values(latest).map((r) => ({ ...r, is_current_month: r.month === targetMonth }));
}

// ── GET /api/fixed-costs — resolved fixed costs for one month (default: current month)
router.get('/fixed-costs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, month } = req.query;
    const targetMonth = month || todayIST().slice(0, 7);
    let query = supabase.from('fixed_costs').select('*').eq('active', true).order('outlet_id').order('cost_head');
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(resolveFixedCostsForMonth(data, targetMonth));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/fixed-costs — Add/update fixed cost FOR A SPECIFIC MONTH. Writes a new row
// for that month rather than overwriting whatever the value used to be — a past month's
// P&L keeps using what was actually true then, even after this month's bill changes it.
router.post('/fixed-costs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, cost_head, label, amount, category, month } = req.body;
    if (!month) return res.status(400).json({ error: 'month (YYYY-MM) is required' });
    const { error } = await supabase.from('fixed_costs').upsert({
      outlet_id, cost_head, label, amount: amount || 0, category: category || 'fixed', month,
      updated_at: new Date().toISOString()
    }, { onConflict: 'outlet_id,cost_head,month' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/fixed-costs — Soft delete ONE MONTH's entry, not the whole head's history
router.delete('/fixed-costs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, cost_head, month } = req.query;
    if (!month) return res.status(400).json({ error: 'month (YYYY-MM) is required' });
    const { error } = await supabase.from('fixed_costs')
      .update({ active: false }).eq('outlet_id', outlet_id).eq('cost_head', cost_head).eq('month', month);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fixed-cost header dropdown — a shared master list of labels (Rent, Salary, Water, ...)
// so the same cost head is spelled identically across outlets instead of drifting into
// "Maintenance"/"Maintainance"/"maintenence" variants that never reconcile. Stored as one
// JSON array in the generic app_config k/v table (no dedicated table / migration needed);
// falls back to a sensible default set until the owner adds their own.
const DEFAULT_FIXED_COST_HEADS = ['Rent', 'Electricity', 'Salary', 'Porter', 'Maintenance', 'New Equipments', 'Water'];

// ── GET /api/fixed-cost-heads — the dropdown options
router.get('/fixed-cost-heads', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { data, error } = await supabase.from('app_config').select('value').eq('key', 'fixed_cost_heads').maybeSingle();
    if (error) throw error;
    let heads = data?.value ? JSON.parse(data.value) : null;
    if (!Array.isArray(heads) || heads.length === 0) heads = DEFAULT_FIXED_COST_HEADS;
    res.json(heads);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/fixed-cost-heads — add a new label to the dropdown (case-insensitive dedupe)
router.post('/fixed-cost-heads', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const label = (req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label is required' });
    const { data } = await supabase.from('app_config').select('value').eq('key', 'fixed_cost_heads').maybeSingle();
    let heads = data?.value ? JSON.parse(data.value) : null;
    if (!Array.isArray(heads) || heads.length === 0) heads = [...DEFAULT_FIXED_COST_HEADS];
    if (!heads.some(h => String(h).toLowerCase() === label.toLowerCase())) heads.push(label);
    heads.sort((a, b) => String(a).localeCompare(String(b)));
    const { error } = await supabase.from('app_config').upsert({ key: 'fixed_cost_heads', value: JSON.stringify(heads) }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ ok: true, heads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/fixed-cost-heads?label= — remove a label from the dropdown (a mistaken
// entry). Does not touch fixed_costs rows already using that label — only the picker list.
router.delete('/fixed-cost-heads', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const label = (req.query.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label is required' });
    const { data } = await supabase.from('app_config').select('value').eq('key', 'fixed_cost_heads').maybeSingle();
    let heads = data?.value ? JSON.parse(data.value) : [...DEFAULT_FIXED_COST_HEADS];
    heads = heads.filter(h => String(h).toLowerCase() !== label.toLowerCase());
    const { error } = await supabase.from('app_config').upsert({ key: 'fixed_cost_heads', value: JSON.stringify(heads) }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ ok: true, heads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/crockery-packaging-rules — what's covered by the Packaging/Crockery
// add-on shown on the Sales tab and folded into RM Audit/P&L (see
// computeCrockeryPackagingItems above). avp/head_chef get read access too, same tier
// as rate-card (the Sales tab's "what's included" dropdown is visible to both).
router.get('/crockery-packaging-rules', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    res.json(await getCrockeryPackagingRules());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/crockery-packaging-rules — add an item to the Dine In or Pickup/Delivery
// rule, or update its quantity if already present (upsert by item_id within that rule
// only — the SAME item can appear in both rules independently, e.g. Bio Spoon already
// does). Owner-only, same tier as every other master-data write in this file.
router.post('/crockery-packaging-rules', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { rule_type, item_id, name, qty } = req.body;
    if (!['dine_in', 'takeaway'].includes(rule_type)) return res.status(400).json({ error: "rule_type must be 'dine_in' or 'takeaway'" });
    if (!item_id || !name) return res.status(400).json({ error: 'item_id and name are required' });
    if (!(Number(qty) > 0)) return res.status(400).json({ error: 'qty must be a positive number' });
    const rules = await getCrockeryPackagingRules();
    const list = rules[rule_type];
    const existing = list.find((r) => r.item_id === item_id);
    if (existing) existing.qty = Number(qty);
    else list.push({ item_id, name, qty: Number(qty) });
    const { error } = await supabase.from('app_config').upsert({ key: 'crockery_packaging_rules', value: JSON.stringify(rules) }, { onConflict: 'key' });
    if (error) throw error;
    res.json(rules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/crockery-packaging-rules?rule_type=&item_id= — remove an item from one
// rule (a mistaken addition, or a packaging item the outlet stopped using).
router.delete('/crockery-packaging-rules', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { rule_type, item_id } = req.query;
    if (!['dine_in', 'takeaway'].includes(rule_type)) return res.status(400).json({ error: "rule_type must be 'dine_in' or 'takeaway'" });
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });
    const rules = await getCrockeryPackagingRules();
    rules[rule_type] = rules[rule_type].filter((r) => r.item_id !== item_id);
    const { error } = await supabase.from('app_config').upsert({ key: 'crockery_packaging_rules', value: JSON.stringify(rules) }, { onConflict: 'key' });
    if (error) throw error;
    res.json(rules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// P&L COMPUTATION — Real-time from dispatched items + rate card
// ============================================================

// ── GET /api/pnl/live/:date — Compute P&L for a date from actual data
router.get('/pnl/live/:date', async (req, res) => {
  try {
    // outlet_mgr added for the outlet-side Performance Dashboard's COGS Score (needs
    // effective_sale to turn ideal/actual material cost into a % of sale) — forced to
    // their own outlet below, same as franchise already is. chef added the same way.
    const user = await requireRole(req, res, 'owner', 'avp', 'head_chef', 'franchise', 'outlet_mgr', 'chef');
    if (!user) return;
    const { date } = req.params;
    const outlet = scopedOutletFilter(user, req.query.outlet); // optional outlet filter, forced for franchise/outlet_mgr

    // None of these ten queries depend on each other's results — fired concurrently
    // instead of one-at-a-time, so this endpoint's total latency is bounded by the
    // slowest single query rather than the sum of all of them.
    const [
      { data: rates },
      { data: allOrders },
      { data: demandItemsRaw },
      { data: unitConversions },
      { data: purchases },
      salesByOutlet,
      { data: fixedCosts },
      { data: bkRecipes },
      { data: bkIngredients },
      { data: invItemsList },
      bkPurchaseCostingContext,
    ] = await Promise.all([
      supabase.from('rate_card').select('id, name, category, unit, price').eq('active', true),
      supabase.from('demands').select('*').eq('date', date),
      supabase.from('demand_items').select('id, unit').eq('active', true),
      supabase.from('unit_conversions').select('*').eq('active', true),
      supabase.from('purchases').select('*').eq('date', date),
      // Revenue now comes from real PetPooja billing (daily_sales) instead of the
      // outlet manager's manual "Daily Sales & Cash" entry — see
      // computeDailySalesRevenue above.
      computeDailySalesRevenue(date),
      supabase.from('fixed_costs').select('*').eq('active', true),
      supabase.from('bk_recipes').select('*'),
      supabase.from('bk_recipe_ingredients').select('*'),
      supabase.from('inventory_items').select('id, name, demand_item_id'),
      // Own costing context (rate_card/BK-recipe pricing) for computeBkPurchaseByOutlet
      // below — deliberately a separate build rather than reusing this route's own
      // hand-rolled rateMap/convMap (different shape), so the BK Purchase figure here
      // exactly matches Finance's, not a similar-but-drifting variant. Priced as-of the P&L
      // date; its .priceAsOf ledger resolver also dates this route's own rateMap below (no
      // second ledger fetch).
      buildCostingContext(date),
    ]);
    const bkPurchaseByOutlet = await computeBkPurchaseByOutlet(date, date, bkPurchaseCostingContext);
    // Denominator for BK Fixed Cost's proportional split below (see the "BK FIXED COST
    // SHARE" block inside the per-outlet loop) — total across the same 6-outlet set the
    // equal split used to divide by, computed once here rather than per-outlet iteration.
    const totalBkPurchaseAllOutlets = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'].reduce((s, oid) => s + (bkPurchaseByOutlet[oid] || 0), 0);
    // Priced as-of the P&L date via the ledger resolver on the context built above, so this
    // route's dispatch costs and hand-rolled BK recipe costs (bkCostPerKg below reads
    // rateMap[...].price) reflect the prices in effect that day — and a past P&L never
    // changes when a new price lands later.
    const rateMap = {};
    (rates || []).forEach(r => { rateMap[r.id] = { ...r, price: bkPurchaseCostingContext.priceAsOf(r.id, date) }; });
    const orders = (allOrders || []).filter(o => o.status === 'fulfilled' || o.dispatch_items);
    const demandUnitMap = {};
    (demandItemsRaw || []).forEach(i => { demandUnitMap[i.id] = i.unit; });
    const convMap = {};
    (unitConversions || []).forEach(c => {
      convMap[c.item_id] = { fromUnit: c.unit_type, qty: Number(c.qty), baseUnit: c.base_unit };
    });

    // Get days in month for daily fixed cost
    const dateObj = new Date(date);
    const daysInMonth = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0).getDate();
    // Resolve fixed_costs to this date's month — a row belongs to a specific month now
    // (Water/Electricity/etc. genuinely differ month to month), so summing every active
    // row regardless of month would blend past and future bills into today's figure.
    // Walks back to the latest entry at-or-before this month per (outlet,cost_head), so
    // Rent/Salary (rarely re-entered) still apply without needing a fresh row every month.
    const resolvedFixedCosts = resolveFixedCostsForMonth(fixedCosts, date.slice(0, 7));

    // Get inventory items for mapping raw_material_id → rate_card id
    const invByName = {};
    (invItemsList || []).forEach(i => { invByName[i.name?.toLowerCase()] = i.id; invByName[i.id] = i.id; });
    
    // Build mapping: raw_material_id → rate_card id (handles _raw suffix, name matching)
    const rawToRateMap = {};
    const rateByName = {};
    (rates || []).forEach(r => { rateByName[r.name?.toLowerCase().trim()] = r.id; });
    const invNameToRate = {};
    (invItemsList || []).forEach(i => { 
      // If inventory item has a rate card entry, map it
      if (rateMap[i.id]) invNameToRate[i.name?.toLowerCase().trim()] = i.id;
    });
    
    // Complete raw material → rate card mapping
    // Recipe ingredients use _raw suffix IDs; rate card uses clean IDs.
    // This map resolves every known mismatch.
    //
    // NOT aliased to BK_INGREDIENT_TO_RATE (a byte-identical copy, module-level, near
    // computeRMAudit) even though the two currently agree — BK_INGREDIENT_TO_RATE's own
    // comment says it's "a separate, deliberate copy of the mapping the live P&L uses
    // internally... P&L pricing is safety-critical... kept intentionally independent" of
    // that dish-costing browsing tool. This IS that live P&L mapping (this whole block
    // lives inside GET /pnl/live/:date), so sharing a reference with the thing it was
    // deliberately kept apart from would be exactly backwards — a stray edit to the
    // browsing tool's table could then silently change real P&L numbers. Left as its own
    // copy; if you add/change an item here, mirror it in BK_INGREDIENT_TO_RATE and
    // buildCostingContext's own rawToRate by hand — three places, on purpose.
    const KNOWN_MAPPINGS = {
      amchoor_raw: 'amchoor_powder', arhar_dal_raw: 'arhar_dal', besan: 'besan',
      chana_dal_raw: 'chana_dal', coconut_crush_raw: 'coconut_crush', coconut_raw: 'coconut',
      coriander_raw: 'coriander_leaves', curry_leaves_raw: 'curry_leaves',
      deggi_mirch_raw: 'deggi_mirch', desi_ghee_raw: 'desi_ghee',
      dhaniya_whole_raw: 'dhaniya_whole', drumstick_raw: 'drumstick',
      fortune_refined_raw: 'fortune_refined', garam_masala_raw: 'garam_masala',
      garlic_raw: 'garlic', ginger_raw: 'ginger', golden_sela_rice: 'golden_sela_rice',
      green_chilli_raw: 'green_chillies', gur_raw: 'gur',
      haldi_raw: 'haldi_powder', hing_raw: 'hing_powder',
      ilaychi_raw: 'ilaychi', imli_raw: 'imli',
      jeera_raw: 'jeera', kaju_raw: 'kaju', kali_mirch_raw: 'kali_mirch',
      kesar_raw: 'kesar', kishmish_raw: 'kishmish',
      meetha_soda_raw: 'meetha_soda', methi_dana_raw: 'methi_dana',
      milk_raw: 'milk', milkmaid_raw: 'milkmaid', mint_raw: 'mint',
      mustard_raw: 'mustard_seeds', onions_raw: 'onions',
      peanuts_raw: 'peanuts', petha_raw: 'petha', pineapple_raw: 'pineapple',
      poha_raw: 'poha', red_chilli_powder_raw: 'red_chilli_powder',
      rice_powder_raw: 'rice_powder', roasted_chana_raw: 'roasted_chana',
      roasted_karipatta_raw: 'roasted_karipatta', roasted_peanuts_raw: 'roasted_peanuts',
      safed_til_raw: 'safed_til', salt_raw: 'salt',
      sambhar_masala_raw: 'sambhar_masala_777', semiyan_raw: 'semiyan',
      sona_masoori_raw: 'sona_masoori_rice', sugar_raw: 'sugar',
      tadka_raw: 'tadka', tomatoes_raw: 'tomatoes',
      upma_sooji_raw: 'upma_sooji', urad_daal: 'urad_daal_whole',
      whole_red_chilli_raw: 'whole_red_chilli',
    };

    const findRateId = (rmId) => {
      if (rateMap[rmId]) return rmId;
      if (KNOWN_MAPPINGS[rmId] && rateMap[KNOWN_MAPPINGS[rmId]]) return KNOWN_MAPPINGS[rmId];
      const stripped = rmId.replace(/_raw$/, '');
      if (rateMap[stripped]) return stripped;
      if (KNOWN_MAPPINGS[stripped] && rateMap[KNOWN_MAPPINGS[stripped]]) return KNOWN_MAPPINGS[stripped];
      // Try inventory item lookup
      const invItem = (invItemsList || []).find(i => i.id === rmId || i.id === stripped);
      if (invItem && rateMap[invItem.id]) return invItem.id;
      return null;
    };

    const bkRecipeMap = {};
    (bkRecipes || []).forEach(r => {
      const ings = (bkIngredients || []).filter(i => i.recipe_id === r.id);
      bkRecipeMap[r.id] = {
        ...r,
        yieldQty: Number(r.yield_qty) || 1,
        ingredients: ings.map(i => {
          // Try to find rate card item: raw_material_id might be inventory item id or name
          const rmId = i.raw_material_id || i.raw_material;
          const invId = invByName[rmId] || invByName[rmId?.toLowerCase()] || rmId;
          return { rawId: rmId, inv_id: invId, qty: Number(i.qty) || 0, unit: i.unit || 'Kg' };
        })
      };
    });

    // Cost per Kg for a BK recipe, recursively — an ingredient can itself be another BK
    // recipe's output (e.g. a combo recipe using Dosa Batter), priced via that recipe's own
    // cost instead of being silently skipped as unpriced. `visited` guards a circular
    // reference (A uses B uses A) from recursing forever; memoized since the same nested
    // recipe can be reused by several dispatched items in one P&L computation.
    // Self-contained unit conversion (SI + unit_conversions table) rather than reusing the
    // per-outlet-loop `getUnitConv` below, since this helper is built once, outside that loop.
    const bkIngredientUnitConv = (fromUnit, rateUnit, rmId) => {
      const fu = (fromUnit || 'kg').toLowerCase();
      const ru = (rateUnit || 'kg').toLowerCase();
      let factor = 1;
      let unit = fu;
      const conv = convMap[rmId];
      if (conv && fu === conv.fromUnit.toLowerCase()) { factor = conv.qty; unit = (conv.baseUnit || '').toLowerCase(); }
      if (unit !== ru) {
        if ((unit === 'gm' || unit === 'g') && ru === 'kg') factor *= 0.001;
        else if (unit === 'kg' && (ru === 'gm' || ru === 'g')) factor *= 1000;
        else if (unit === 'ml' && (ru === 'ltr' || ru === 'l')) factor *= 0.001;
        else if ((unit === 'ltr' || unit === 'l') && ru === 'ml') factor *= 1000;
      }
      return factor;
    };
    const bkCostPerKgCache = {};
    const bkCostPerKg = (recipeId, visited = new Set()) => {
      if (bkCostPerKgCache[recipeId] !== undefined) return bkCostPerKgCache[recipeId];
      const recipe = bkRecipeMap[recipeId];
      if (!recipe || visited.has(recipeId)) return null;
      const nextVisited = new Set(visited); nextVisited.add(recipeId);
      let cost = 0;
      (recipe.ingredients || []).forEach(ing => {
        const rmId = ing.inv_id || ing.rawId;
        const rateId = findRateId(rmId);
        const ingRate = rateId ? rateMap[rateId] : null;
        if (ingRate) {
          const factor = bkIngredientUnitConv(ing.unit, ingRate.unit, rmId);
          cost += ing.qty * factor * Number(ingRate.price);
        } else if (rmId !== recipeId && bkRecipeMap[rmId]) {
          const nested = bkCostPerKg(rmId, nextVisited);
          if (nested != null) cost += ing.qty * nested;
        }
      });
      const result = recipe.yieldQty > 0 ? cost / recipe.yieldQty : 0;
      bkCostPerKgCache[recipeId] = result;
      return result;
    };

    // Helper: get demand item display name
    const demandItemNameMap = {};
    (demandItemsRaw || []).forEach(i => { demandItemNameMap[i.id] = i.name || i.id; });
    const getDemandItemName = (id) => demandItemNameMap[id] || id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // 7. Compute per-outlet P&L
    const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
    const pnlResults = [];

    for (const oid of (outlet && outlet !== 'all' ? [outlet] : outletIds)) {
      // ── REVENUE — from real PetPooja billing (daily_sales), not the outlet
      // manager's manual entry. Cancelled invoices are already excluded from
      // totalSale/storeSale/swiggy/zomato/otherDelivery at the source (see
      // computeDailySalesRevenue), so unlike the old formula there's no
      // separate "− cancelledOrders" step here; cancelledOrders below is now
      // purely informational (shown in the revenue breakdown, not deducted).
      const sales = salesByOutlet[oid];
      const totalSale = Number(sales?.total_sale || 0);
      const cancelledOrders = Number(sales?.cancelled_amount || 0);
      const complimentaryAmt = Number(sales?.complimentary_amount || 0);
      const swiggy = Number(sales?.swiggy_sale || 0);
      const zomato = Number(sales?.zomato_sale || 0);
      const otherDelivery = Number(sales?.other_delivery_sale || 0);
      const deliverySale = swiggy + zomato + otherDelivery;
      // Delivery platforms charge 40% commission — net delivery revenue is 60%
      const deliveryCommission = Math.round((swiggy + zomato) * 0.4);
      const netDeliverySale = Math.round((swiggy + zomato) * 0.6) + otherDelivery;
      const storeSale = Number(sales?.store_sale || 0);
      // Effective sale = store sale + 60% of (Swiggy+Zomato) + other delivery - complimentary
      const effectiveSale = storeSale + netDeliverySale - complimentaryAmt;

      // ── VARIABLE COST (dispatched items × rate card, BK-recipe fallback) — computed via
      // the SAME shared computeBkPurchaseByOutlet/computeBkPurchaseDetail functions
      // Finance's outlet-pnl uses, instead of this route's own separate hand-rolled
      // per-item loop (unit-conversion chain, BK-recipe cost/Kg resolution, etc.) that
      // used to live here. The two had quietly drifted apart over time — this route's own
      // bk_purchase field (below) already matched Finance's figure, but variable_cost/
      // total_expense/net_profit still came from this old loop and DIDN'T, so the same
      // Daily P&L card showed two disagreeing "what did we buy from BK" numbers at once.
      // Seeding totalVariableCost directly from bkPurchaseByOutlet[oid] (not re-summing
      // bkPurchaseDetail's own items) guarantees variable_cost and bk_purchase are
      // identical below, not just close.
      const bkPurchaseDetail = await computeBkPurchaseDetail(oid, date, date, bkPurchaseCostingContext);
      const variableByCategory = {};
      const itemBreakdown = [];
      let totalVariableCost = bkPurchaseByOutlet[oid] || 0;
      bkPurchaseDetail.items.forEach(it => {
        const cat = bkPurchaseCostingContext.rateMap[it.item_id]?.category || 'Food';
        variableByCategory[cat] = (variableByCategory[cat] || 0) + it.total_amount;
        itemBreakdown.push({
          item_id: it.item_id, name: it.name, category: cat,
          qty: it.total_qty, raw_qty: it.total_qty, unit: it.unit, raw_unit: it.unit,
          rate: it.total_qty > 0 ? Math.round(it.total_amount / it.total_qty * 100) / 100 : null,
          cost: it.total_amount,
        });
      });

      // ── DAILY PURCHASES ── split by line-item type (vendor_payment vs new_purchase).
      // Existing records predate the type field — treat those as new_purchase.
      const outletPurchases = (purchases || []).filter(p => p.outlet_id === oid);
      const dailyPurchaseTotal = outletPurchases.reduce((sum, p) => sum + Number(p.total_amount || 0), 0);
      let vendorPayments = 0, newPurchases = 0;
      // Cold Drink & Water is purchased directly (never dispatched from Base Kitchen, no
      // rate-card price to multiply a qty by), so there's no way to cost it the same way
      // as every other Material Cost category — the actual amount paid today IS the cost.
      // Pulled out of the generic Purchases bucket into its own Variable Cost category
      // below instead, so it shows up "along with all the categories" there.
      const coldDrinkItemTotals = {}; // item_name -> { qty, amount, unit }
      outletPurchases.forEach(p => {
        (p.items || []).forEach(i => {
          const amt = Number(i.amount) || 0;
          if (i.type === 'vendor_payment') { vendorPayments += amt; return; }
          if (i.type === 'cold_drink_purchase') {
            const key = i.item_name || 'Cold Drink';
            if (!coldDrinkItemTotals[key]) coldDrinkItemTotals[key] = { qty: 0, amount: 0, unit: i.unit || 'Pcs' };
            coldDrinkItemTotals[key].qty += Number(i.quantity) || 0;
            coldDrinkItemTotals[key].amount += amt;
            return;
          }
          newPurchases += amt;
        });
      });
      const coldDrinkPurchaseTotal = Object.values(coldDrinkItemTotals).reduce((s, v) => s + v.amount, 0);
      if (coldDrinkPurchaseTotal > 0) {
        totalVariableCost += coldDrinkPurchaseTotal;
        variableByCategory['Cold Drink'] = (variableByCategory['Cold Drink'] || 0) + coldDrinkPurchaseTotal;
        Object.entries(coldDrinkItemTotals).forEach(([name, v]) => {
          itemBreakdown.push({
            item_id: `cold_drink_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
            name, category: 'Cold Drink', qty: v.qty, unit: v.unit,
            rate: v.qty > 0 ? Math.round(v.amount / v.qty * 100) / 100 : null,
            cost: Math.round(v.amount * 100) / 100,
          });
        });
      }
      // Purchases recorded before per-item breakdown existed (empty items array) still count
      // toward the total but can't be split — fold them into new_purchase so nothing goes missing.
      const unsplit = dailyPurchaseTotal - (vendorPayments + newPurchases + coldDrinkPurchaseTotal);
      if (unsplit > 0.5) newPurchases += unsplit;
      // Now excludes Cold Drink's amount, which moved into Variable Cost above — without
      // this, the same rupees would be counted twice in total_expense.
      const purchasesExclColdDrink = Math.round((dailyPurchaseTotal - coldDrinkPurchaseTotal) * 100) / 100;

      // ── FIXED COSTS (daily = monthly / days in month) ──
      const outletFixed = resolvedFixedCosts.filter(f => f.outlet_id === oid);
      const monthlyFixed = outletFixed.reduce((sum, f) => sum + Number(f.amount || 0), 0);
      const dailyFixedCost = Math.round(monthlyFixed / daysInMonth);
      const fixedBreakdown = outletFixed.map(f => ({
        cost_head: f.cost_head, label: f.label,
        monthly: Number(f.amount), daily: Math.round(Number(f.amount) / daysInMonth)
      }));

      // ── BK FIXED COST SHARE — proportional to how much each outlet actually bought
      // from BK today (bk_purchase), not split equally. An outlet that didn't buy from
      // BK today carries none of BK's fixed cost today; an outlet that bought more
      // carries more. Falls back to an equal split only on a day with zero BK purchases
      // everywhere (nothing to prorate against) — same fallback Finance's outlet-pnl uses.
      const bkFixed = resolvedFixedCosts.filter(f => f.outlet_id === 'bk');
      const bkMonthlyFixed = bkFixed.reduce((sum, f) => sum + Number(f.amount || 0), 0);
      const bkDailyFixed = Math.round(bkMonthlyFixed / daysInMonth);
      const bkSharePerOutlet = totalBkPurchaseAllOutlets > 0
        ? Math.round(bkDailyFixed * (bkPurchaseByOutlet[oid] || 0) / totalBkPurchaseAllOutlets)
        : Math.round(bkDailyFixed / outletIds.length);

      // ── TOTALS ──
      const totalExpense = totalVariableCost + dailyFixedCost + bkSharePerOutlet + purchasesExclColdDrink;
      const netProfit = effectiveSale - totalExpense;
      const margin = effectiveSale > 0 ? (netProfit / effectiveSale * 100) : 0;

      pnlResults.push({
        outlet_id: oid,
        date,
        // Revenue
        total_sale: totalSale,
        delivery_sale: deliverySale,
        delivery_commission: deliveryCommission,
        net_delivery_sale: netDeliverySale,
        store_sale: storeSale,
        cancelled_orders: cancelledOrders,
        complimentary: complimentaryAmt,
        effective_sale: effectiveSale,
        // Variable cost
        variable_cost: Math.round(totalVariableCost),
        variable_by_category: variableByCategory,
        item_breakdown: itemBreakdown,
        cold_drink_purchase_total: Math.round(coldDrinkPurchaseTotal),
        // What was actually dispatched from Base Kitchen today, priced at rate-card/
        // BK-recipe cost — NOT the same number as variable_cost above (which is the
        // Yesterday Closing + Dispatched − Wastage − Today Closing "actual consumption"
        // formula). Same computeBkPurchaseByOutlet the Finance module uses, so this
        // figure never drifts from that one. See CLAUDE.md / finance.js for why the two
        // are deliberately different metrics.
        bk_purchase: Math.round(bkPurchaseByOutlet[oid] || 0),
        // Fixed cost
        daily_fixed_cost: dailyFixedCost,
        bk_share: bkSharePerOutlet,
        fixed_breakdown: fixedBreakdown,
        monthly_fixed: monthlyFixed,
        // Purchases — excludes Cold Drink, which is now counted in Variable Cost above.
        daily_purchases: purchasesExclColdDrink,
        vendor_payments: Math.round(vendorPayments),
        new_purchases: Math.round(newPurchases),
        // Summary
        total_expense: Math.round(totalExpense),
        net_profit: Math.round(netProfit),
        margin: Math.round(margin * 10) / 10,
        days_in_month: daysInMonth,
      });
    }

    // Add ALL-outlets summary — Elan is excluded from the consolidated total (still
    // available on its own via its individual outlet_id row) since it's a franchise
    // whose numbers the owner doesn't want blended into the company-wide P&L.
    if (!outlet || outlet === 'all') {
      const consolidated = pnlResults.filter(r => r.outlet_id !== 'elan');
      const summary = {
        outlet_id: 'all',
        date,
        total_sale: consolidated.reduce((s, r) => s + r.total_sale, 0),
        delivery_sale: consolidated.reduce((s, r) => s + r.delivery_sale, 0),
        store_sale: consolidated.reduce((s, r) => s + r.store_sale, 0),
        cancelled_orders: consolidated.reduce((s, r) => s + r.cancelled_orders, 0),
        complimentary: consolidated.reduce((s, r) => s + r.complimentary, 0),
        effective_sale: consolidated.reduce((s, r) => s + r.effective_sale, 0),
        variable_cost: consolidated.reduce((s, r) => s + r.variable_cost, 0),
        bk_purchase: consolidated.reduce((s, r) => s + (r.bk_purchase || 0), 0),
        daily_fixed_cost: consolidated.reduce((s, r) => s + r.daily_fixed_cost, 0),
        bk_share: consolidated.reduce((s, r) => s + r.bk_share, 0),
        daily_purchases: consolidated.reduce((s, r) => s + r.daily_purchases, 0),
        vendor_payments: consolidated.reduce((s, r) => s + (r.vendor_payments || 0), 0),
        new_purchases: consolidated.reduce((s, r) => s + (r.new_purchases || 0), 0),
        total_expense: consolidated.reduce((s, r) => s + r.total_expense, 0),
        net_profit: consolidated.reduce((s, r) => s + r.net_profit, 0),
        days_in_month: consolidated[0]?.days_in_month || 30,
      };
      summary.margin = summary.effective_sale > 0 ? Math.round(summary.net_profit / summary.effective_sale * 1000) / 10 : 0;
      pnlResults.unshift(summary);
    }

    res.json({ date, days_in_month: pnlResults[0]?.days_in_month || 30, pnl: pnlResults });
  } catch (err) {
    console.error('P&L computation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DAILY STOCK USAGE — Opening, Closing, Used, Variable Cost
// Formula: Opening = (Prev Closing - Wastage) + Dispatched
//          Used = Opening - Today Closing
//          Variable Cost = Used × Rate
// ============================================================

// Rate card + BK recipe costing + unit conversions + the demand-unit-aware conversion
// factor helper — the pricing setup computeStockUsageForDate needs, extracted so
// /api/wastage/cost (and any other per-item costing endpoint) can reuse the exact same
// rate-card/recipe/conversion resolution instead of a third, possibly-drifting copy of
// this logic (RecipesPanel and CogsDash on the frontend already each have their own).
// `asOfDate` ('YYYY-MM-DD', optional) prices everything as of that date via the
// rate_card_prices ledger — the latest price at-or-before it, carried forward (see the
// 2026_08_27 migration). Omitted → current rate_card.price, i.e. behaviour identical to
// before this became date-aware. The full ledger is loaded once; `ctx.withDate(date)` on
// the returned context re-resolves rateMap + BK recipe costs for a DIFFERENT date entirely
// in memory (no extra query), so a month/range caller prices each day correctly off a
// single fetch instead of rebuilding the whole context 30 times.
async function buildCostingContext(asOfDate) {
  // None of these queries depend on each other's results — fired concurrently instead
  // of one-at-a-time so this function's total latency is bounded by the slowest single
  // query, not the sum of all of them (this alone was most of /stock-usage and /audit's
  // multi-second load time).
  const [
    { data: rates },
    { data: bkRecipes },
    { data: bkIngredients },
    { data: invItemsList },
    { data: demandItemsRaw },
    { data: unitConversions },
    { data: priceRows },
  ] = await Promise.all([
    supabase.from('rate_card').select('id, name, category, unit, price').eq('active', true),
    supabase.from('bk_recipes').select('*'),
    supabase.from('bk_recipe_ingredients').select('*'),
    supabase.from('inventory_items').select('id, name, demand_item_id'),
    supabase.from('demand_items').select('id, name, unit').eq('active', true),
    supabase.from('unit_conversions').select('*').eq('active', true),
    // Whole ledger loaded once — small (one row per item per price change) and reused
    // across every date a withDate() caller asks for. created_at is the tie-break when two
    // prices share an effective_date (e.g. two challans the same day) — latest wins.
    supabase.from('rate_card_prices').select('rate_card_id, effective_date, price, created_at'),
  ]);
  // baseRateMap holds each item's CURRENT price (rate_card.price). The priced rateMap the
  // context exposes is derived from it per-date below; resolveRateId/convFactorFor only ever
  // read KEYS/units off it (never the price), so they stay valid across dates unchanged.
  const baseRateMap = {};
  const rateByName = {};
  (rates || []).forEach(r => { baseRateMap[r.id] = r; rateByName[normalizeIngredientName(r.name)] = r.id; });
  const rateMap = baseRateMap; // resolveRateId/computeBkRecipe below reference `rateMap` for existence/units

  // Ledger indexed by item, newest-first, for as-of resolution. Supabase returns
  // effective_date as an ISO 'YYYY-MM-DD' string, so lexical compare == date compare.
  const priceHistoryByRate = {};
  (priceRows || []).forEach(p => { (priceHistoryByRate[p.rate_card_id] ||= []).push(p); });
  // Newest first: by effective_date, then created_at as the same-day tie-break so the
  // latest price paid on a day wins (two challans for the same item on one date).
  const cmpDesc = (a, b, k) => (a[k] < b[k] ? 1 : a[k] > b[k] ? -1 : 0);
  Object.values(priceHistoryByRate).forEach(list => list.sort((a, b) =>
    cmpDesc(a, b, 'effective_date') || cmpDesc(a, b, 'created_at')));
  // Price of one item as of a date: latest ledger row effective on-or-before it (carry
  // forward). No date → current price. No ledger row at all → current price (defensive;
  // the baseline seed means every active item has at least one row from 2000-01-01).
  const priceAsOf = (id, date) => {
    const cur = baseRateMap[id] ? Number(baseRateMap[id].price) : null;
    if (!date) return cur;
    const hist = priceHistoryByRate[id];
    if (!hist || !hist.length) return cur;
    for (const row of hist) { if (row.effective_date <= date) return Number(row.price); }
    return cur;
  };
  const bkRecipeByName = {};
  // `active !== false` (not a strict `=== true`) since the column defaults null/undefined
  // on older rows that predate soft-delete — only an explicit false (a real DELETE
  // /master/recipes/:id) should exclude a recipe from being found by name here.
  (bkRecipes || []).filter(r => r.active !== false).forEach(r => { bkRecipeByName[normalizeIngredientName(r.name)] = r.id; });

  const convMap = {}; // { item_id: { from_unit, qty, base_unit } }
  (unitConversions || []).forEach(c => {
    convMap[c.item_id] = { fromUnit: c.unit_type, qty: Number(c.qty), baseUnit: c.base_unit };
  });

  // Build demand item name/unit maps
  const demandNameMap = {};
  const demandUnitMap = {};
  (demandItemsRaw || []).forEach(i => { demandNameMap[i.id] = i.name; demandUnitMap[i.id] = i.unit; });

  // Build inventory → demand_item mapping
  const invByName = {};
  (invItemsList || []).forEach(i => {
    if (i.demand_item_id) invByName[i.id] = i.demand_item_id;
    if (i.name) invByName[i.name.toLowerCase()] = i.demand_item_id || i.id;
  });

    // Explicit raw material → rate card mapping
    // Recipe ingredients use _raw suffix IDs; rate card uses clean IDs.
    // This map resolves every known mismatch.
    //
    // Byte-identical to BK_INGREDIENT_TO_RATE (module-level, near computeRMAudit) and to
    // KNOWN_MAPPINGS (inside GET /pnl/live/:date) — three copies of the same table. Left
    // separate on purpose rather than aliased to a shared object: BK_INGREDIENT_TO_RATE's
    // own comment says it's deliberately kept independent of the live P&L route for
    // safety (real money, tied to actual dispatch), and this function — buildCostingContext
    // — is arguably even more safety-critical, since it feeds RM Audit, Finance's
    // outlet-pnl, and stock-usage in addition to P&L. Coupling it to the browsing-tool's
    // table would risk the same thing that comment was written to prevent, just one hop
    // further out. If you add/change an item here, mirror it in the other two by hand.
    const rawToRate = {
      amchoor_raw: 'amchoor_powder', arhar_dal_raw: 'arhar_dal', besan: 'besan',
      chana_dal_raw: 'chana_dal', coconut_crush_raw: 'coconut_crush', coconut_raw: 'coconut',
      coriander_raw: 'coriander_leaves', curry_leaves_raw: 'curry_leaves',
      deggi_mirch_raw: 'deggi_mirch', desi_ghee_raw: 'desi_ghee',
      dhaniya_whole_raw: 'dhaniya_whole', drumstick_raw: 'drumstick',
      fortune_refined_raw: 'fortune_refined', garam_masala_raw: 'garam_masala',
      garlic_raw: 'garlic', ginger_raw: 'ginger', golden_sela_rice: 'golden_sela_rice',
      green_chilli_raw: 'green_chillies', gur_raw: 'gur',
      haldi_raw: 'haldi_powder', hing_raw: 'hing_powder',
      ilaychi_raw: 'ilaychi', imli_raw: 'imli',
      jeera_raw: 'jeera', kaju_raw: 'kaju', kali_mirch_raw: 'kali_mirch',
      kesar_raw: 'kesar', kishmish_raw: 'kishmish',
      meetha_soda_raw: 'meetha_soda', methi_dana_raw: 'methi_dana',
      milk_raw: 'milk', milkmaid_raw: 'milkmaid', mint_raw: 'mint',
      mustard_raw: 'mustard_seeds', onions_raw: 'onions',
      peanuts_raw: 'peanuts', petha_raw: 'petha', pineapple_raw: 'pineapple',
      poha_raw: 'poha', red_chilli_powder_raw: 'red_chilli_powder',
      rice_powder_raw: 'rice_powder', roasted_chana_raw: 'roasted_chana',
      roasted_karipatta_raw: 'roasted_karipatta', roasted_peanuts_raw: 'roasted_peanuts',
      safed_til_raw: 'safed_til', salt_raw: 'salt',
      sambhar_masala_raw: 'sambhar_masala_777', semiyan_raw: 'semiyan',
      sona_masoori_raw: 'sona_masoori_rice', sugar_raw: 'sugar',
      tadka_raw: 'tadka', tomatoes_raw: 'tomatoes',
      upma_sooji_raw: 'upma_sooji', urad_daal: 'urad_daal_whole',
      whole_red_chilli_raw: 'whole_red_chilli',
    };

    // Resolve a raw material ID to its rate card ID
    const resolveRateId = (rmId) => {
      // 1. Direct match in rate card
      if (rateMap[rmId]) return rmId;
      // 2. Explicit mapping
      if (rawToRate[rmId] && rateMap[rawToRate[rmId]]) return rawToRate[rmId];
      // 3. Strip _raw suffix
      const stripped = rmId.replace(/_raw$/, '');
      if (rateMap[stripped]) return stripped;
      // 4. Inventory mapping
      const invMapped = invByName[rmId] || invByName[rmId?.toLowerCase()];
      if (invMapped && rateMap[invMapped]) return invMapped;
      // 5. Not found
      return null;
    };

    // Build BK recipe map with computed cost per Kg. An ingredient can itself be another
    // BK recipe's output (e.g. a combo recipe using Dosa Batter) — priced recursively via
    // that recipe's own cost per Kg, with `visited` guarding a circular reference (A uses
    // B uses A) from recursing forever.
    const bkRecipesById = {};
    (bkRecipes || []).forEach(r => { bkRecipesById[r.id] = r; });
    const bkIngredientsByRecipeId = {};
    (bkIngredients || []).forEach(i => { (bkIngredientsByRecipeId[i.recipe_id] ||= []).push(i); });
    // Recompute every BK recipe's cost/Kg against a given (priced) rateMap. A factory,
    // not a one-shot, because a date-scoped context reprices its ingredients — so Sambhar's
    // own cost moves with the raw-material prices in effect on that date, entirely in memory.
    const buildBkRecipeMap = (pricedRateMap) => {
      const bkRecipeMap = {};
      const computeBkRecipe = (recipeId, visited = new Set()) => {
        if (bkRecipeMap[recipeId]) return bkRecipeMap[recipeId];
        const r = bkRecipesById[recipeId];
        if (!r || visited.has(recipeId)) return null;
        const nextVisited = new Set(visited); nextVisited.add(recipeId);
        const yieldQty = Number(r.yield_qty) || 1;
        let batchCost = 0;
        (bkIngredientsByRecipeId[recipeId] || []).forEach(ing => {
          const rmId = ing.raw_material_id || ing.raw_material;
          const rateId = resolveRateId(rmId);
          const ingRate = rateId ? pricedRateMap[rateId] : null;
          if (ingRate) {
            const ingUnit = (ing.unit || 'Kg').toLowerCase();
            const rateUnit = (ingRate.unit || 'Kg').toLowerCase();
            let factor = 1;
            let fromUnit = ingUnit;
            // Check unit_conversions for non-standard units first (e.g. Tin -> Kg),
            // then chain an SI step on top if that base unit still isn't the rate's unit.
            const conv = convMap[rmId];
            if (conv && ingUnit === conv.fromUnit.toLowerCase()) {
              factor = conv.qty;
              fromUnit = (conv.baseUnit || '').toLowerCase();
            }
            if (fromUnit !== rateUnit) {
              if ((fromUnit === 'gm' || fromUnit === 'g') && rateUnit === 'kg') factor *= 0.001;
              else if (fromUnit === 'kg' && (rateUnit === 'gm' || rateUnit === 'g')) factor *= 1000;
              else if (fromUnit === 'ml' && (rateUnit === 'ltr' || rateUnit === 'l')) factor *= 0.001;
              else if ((fromUnit === 'ltr' || fromUnit === 'l') && rateUnit === 'ml') factor *= 1000;
            }
            batchCost += (Number(ing.qty) || 0) * factor * Number(ingRate.price);
          } else if (rmId !== recipeId && bkRecipesById[rmId]) {
            const nested = computeBkRecipe(rmId, nextVisited);
            if (nested) batchCost += (Number(ing.qty) || 0) * nested.costPerKg;
          }
        });
        const costPerKg = yieldQty > 0 ? batchCost / yieldQty : 0;
        const result = { name: r.name || r.id, costPerKg, yieldQty };
        bkRecipeMap[recipeId] = result;
        return result;
      };
      (bkRecipes || []).forEach(r => computeBkRecipe(r.id));
      return bkRecipeMap;
    };

    // rateMap for a date: each item's row with its as-of price. No date → the base map
    // (current prices) UNCHANGED — the exact object every existing caller already got, so
    // the non-dated path is byte-for-byte identical to before.
    const buildRateMapForDate = (date) => {
      if (!date) return baseRateMap;
      const m = {};
      for (const id in baseRateMap) m[id] = { ...baseRateMap[id], price: priceAsOf(id, date) };
      return m;
    };

    // Conversion factor from a specific recorded unit to a target (usually rate-card)
    // unit — chains through unit_conversions then an SI step, same as everywhere else.
    // `rawUnit` is whatever unit that particular entry was recorded in (may differ
    // entry-to-entry now that managers can pick a unit per submission); falls back to
    // the item's default demand unit when the entry predates that feature or didn't
    // override it.
    const convFactorFor = (itemId, rawUnit, targetUnit) => {
      const du = (rawUnit || demandUnitMap[itemId] || targetUnit || '').toLowerCase();
      const ru = (targetUnit || '').toLowerCase();
      if (du === ru) return 1;
      let factor = 1;
      let resolvedUnit = du;
      const conv = convMap[itemId];
      if (conv && du === conv.fromUnit.toLowerCase()) {
        factor = conv.qty;
        resolvedUnit = (conv.baseUnit || '').toLowerCase();
      } else if (conv && conv.baseUnit && du === conv.baseUnit.toLowerCase()) {
        // Recorded directly in the conversion's base unit (e.g. "Piece" for an item
        // whose custom unit is Pkt) — invert instead of silently 1:1-matching it,
        // which used to overstate/understate consumption by the full conversion ratio.
        factor = 1 / (Number(conv.qty) || 1);
        resolvedUnit = conv.fromUnit.toLowerCase();
      }
      if (resolvedUnit !== ru) {
        if ((resolvedUnit === 'gm' || resolvedUnit === 'g') && ru === 'kg') factor *= 0.001;
        else if (resolvedUnit === 'kg' && (ru === 'gm' || ru === 'g')) factor *= 1000;
        else if (resolvedUnit === 'ml' && (ru === 'ltr' || ru === 'l')) factor *= 0.001;
        else if ((resolvedUnit === 'ltr' || resolvedUnit === 'l') && ru === 'ml') factor *= 1000;
      }
      return factor;
    };

    // Static (date-independent) half of the context — helpers + lookups that never depend
    // on price. Spread into every date-scoped context so withDate() only has to swap the
    // two priced members.
    const staticCtx = { rateByName, bkRecipeByName, convMap, demandNameMap, demandUnitMap, convFactorFor, bkIngredientsByRecipeId, bkRecipesById, resolveRateId, priceAsOf };

    // Build the context for one date: static half + this date's priced rateMap and BK
    // recipe costs. withDate() re-prices in memory off the already-loaded ledger — no query
    // — returning a fresh, independent context so concurrent per-day resolutions in a range
    // loop never clobber a shared object.
    const contextForDate = (date) => {
      const pricedRateMap = buildRateMapForDate(date);
      const ctx = {
        ...staticCtx,
        rateMap: pricedRateMap,
        bkRecipeMap: buildBkRecipeMap(pricedRateMap),
        asOfDate: date || null,
      };
      ctx.withDate = contextForDate;
      return ctx;
    };
    // bkIngredientsByRecipeId/bkRecipesById/resolveRateId exposed (previously local-only)
    // so computeRMAudit can walk a nested BK recipe's OWN ingredients (e.g. White Chutney
    // -> Coconut Crush -> Coconut) for should-consume purposes — see the note there. Purely
    // additive: every existing caller destructuring this return is unaffected.
    return contextForDate(asOfDate);
}

// Dispatched items (this period, this outlet) × rate card / BK-recipe cost — same
// "rate card first, then BK recipe fallback" pricing rule as everywhere else in the app
// (see CLAUDE.md), just summed over a date range instead of computed per order for
// display. Deliberately NOT the actual-consumption formula (closing stock, wastage) —
// this is "what did we actually order/pay Base Kitchen for", full stop. Originally lived
// in finance.js (the owner asked for exactly this simplification there: "i dont want to
// focus on closing and wastage, its simple what was total ordered from base kitchen");
// moved here so /pnl/live's per-outlet cards can show the same figure instead of a
// second, possibly-drifting copy of this logic.
async function computeBkPurchaseByOutlet(from, to, costingContext) {
  const { rateMap, bkRecipeMap, convFactorFor } = costingContext;
  const { data: orders, error } = await supabase.from("demands").select("outlet_id, items, dispatch_items, status").gte("date", from).lte("date", to);
  if (error) throw error;
  const dispatched = (orders || []).filter((o) => o.status === "fulfilled" || o.dispatch_items);
  const byOutlet = {};
  dispatched.forEach((o) => {
    const items = o.dispatch_items || o.items || {};
    let cost = 0;
    Object.entries(items).forEach(([itemId, qty]) => {
      const q = Number(qty) || 0;
      if (q <= 0) return;
      // Per-record unit override (e.g. dosa/idli batter demanded in Kg since Aug 11,
      // 2026 — see CLAUDE.md/demand form) — was hardcoded null here, which silently fell
      // back to demand_items' catalog default unit ("Batch" for dosa/idli), multiplying
      // every already-Kg dispatch qty by the Batch→Kg conversion factor (9x/8x) on top of
      // itself. Same items_units-first pattern computeStockUsageForDate already uses for
      // the core COGS/Material Cost figure below — this function just hadn't been updated
      // to match when the demand form switched to Kg.
      const rawUnit = (o.items_units || {})[itemId] || null;
      const rate = rateMap[itemId];
      if (rate) {
        cost += q * convFactorFor(itemId, rawUnit, rate.unit) * Number(rate.price);
      } else if (bkRecipeMap[itemId]) {
        cost += q * convFactorFor(itemId, rawUnit, "Kg") * bkRecipeMap[itemId].costPerKg;
      }
    });
    byOutlet[o.outlet_id] = (byOutlet[o.outlet_id] || 0) + cost;
  });
  return byOutlet;
}

// Same dispatched-items-at-rate-card-cost basis as computeBkPurchaseByOutlet above, just
// broken out per item per date instead of summed into one outlet total — powers Finance's
// BK Purchase drill-down (one outlet, every item dispatched from Base Kitchen across the
// range, day by day). An item with no rate-card or BK-recipe pricing basis is excluded
// here too, same as the total above, so the two figures always reconcile.
async function computeBkPurchaseDetail(outletId, from, to, costingContext) {
  const { rateMap, bkRecipeMap, demandNameMap, demandUnitMap, convFactorFor } = costingContext;
  const { data: orders, error } = await supabase.from("demands").select("outlet_id, date, items, dispatch_items, status").eq("outlet_id", outletId).gte("date", from).lte("date", to);
  if (error) throw error;
  const dispatched = (orders || []).filter((o) => o.status === "fulfilled" || o.dispatch_items);
  const itemsById = {};
  const datesSet = new Set();
  dispatched.forEach((o) => {
    const items = o.dispatch_items || o.items || {};
    Object.entries(items).forEach(([itemId, qty]) => {
      const q = Number(qty) || 0;
      if (q <= 0) return;
      // See the same fix in computeBkPurchaseByOutlet above — rawUnit was hardcoded null.
      const rawUnit = (o.items_units || {})[itemId] || null;
      const rate = rateMap[itemId];
      let amount = 0;
      if (rate) {
        amount = q * convFactorFor(itemId, rawUnit, rate.unit) * Number(rate.price);
      } else if (bkRecipeMap[itemId]) {
        amount = q * convFactorFor(itemId, rawUnit, "Kg") * bkRecipeMap[itemId].costPerKg;
      } else {
        return;
      }
      if (!itemsById[itemId]) itemsById[itemId] = { item_id: itemId, name: demandNameMap[itemId] || itemId.replace(/_/g, " "), unit: demandUnitMap[itemId] || "", byDate: {}, total_qty: 0, total_amount: 0 };
      const bucket = itemsById[itemId];
      if (!bucket.byDate[o.date]) bucket.byDate[o.date] = { qty: 0, amount: 0 };
      bucket.byDate[o.date].qty += q;
      bucket.byDate[o.date].amount += amount;
      bucket.total_qty += q;
      bucket.total_amount += amount;
      datesSet.add(o.date);
    });
  });
  const items = Object.values(itemsById).map((it) => ({
    ...it,
    total_qty: Math.round(it.total_qty * 1000) / 1000,
    total_amount: Math.round(it.total_amount * 100) / 100,
    byDate: Object.fromEntries(Object.entries(it.byDate).map(([d, v]) => [d, { qty: Math.round(v.qty * 1000) / 1000, amount: Math.round(v.amount * 100) / 100 }])),
  })).sort((a, b) => b.total_amount - a.total_amount);
  return { dates: [...datesSet].sort(), items };
}

// Lightweight, dashboard-wide check: any outlet sitting on a closing-stock draft that was
// never finalized, for today or yesterday — the exact silent-zero trap the P&L warning
// (prev/today_closing_draft) surfaces once you're already looking at one outlet. This is
// lighter (no recipe/rate-card join) so it's cheap enough to run on every Owner Dashboard
// page load, not just when P&L is open.
router.get('/closing-stock-draft-alerts', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'avp', 'head_chef')) return;
    const today = todayIST();
    const y = new Date(); y.setMinutes(y.getMinutes() + 330); y.setDate(y.getDate() - 1);
    const yesterday = y.toISOString().split('T')[0];
    const { data, error } = await supabase.from('closing_stocks').select('outlet_id, date, status').in('date', [yesterday, today]);
    if (error) throw error;
    const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
    const alerts = [];
    for (const oid of outletIds) {
      for (const d of [yesterday, today]) {
        const rows = (data || []).filter(r => r.outlet_id === oid && r.date === d);
        const hasSubmitted = rows.some(r => r.status === 'submitted');
        const hasDraft = rows.some(r => r.status === 'draft');
        if (!hasSubmitted && hasDraft) alerts.push({ outlet_id: oid, date: d });
      }
    }
    res.json({ alerts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The categories the owner wants an explicit ✅/❌ for within a closing stock
// submission — a closing_stocks row existing at all only proves SOMETHING was punched,
// not that every category was. Not the full 8 (skips Vegetable/Masala/Cleaning) — scoped
// to the ones the owner asked to see broken out (also used, equally weighted, by the
// outlet Performance Dashboard's Punch Score).
const CLOSING_CHECK_SECTIONS = ['grocery', 'packaging', 'food', 'dairy', 'cold_drink', 'gas'];

// ── GET /api/punch-status/:date — Which of the 7 required daily punches (Sales,
// Wastage, Demand, Closing, Dairy Purchase, Cold Drink Purchase, Verify Dispatch) each
// outlet (including franchises) has NOT done yet for a given date. Powers the Daily
// P&L "Missing Punches" pill so the owner can see exactly what to chase instead of
// checking each outlet by hand, and the outlet-facing Performance Dashboard's Punch
// Score. Closing Stock also gets a per-category breakdown (closing_categories) — a
// submitted row only proves something was punched, not that every category actually
// got filled in. outlet_mgr can call this too (for their own Performance Dashboard) —
// scopedOutletFilter forces them to their own outlet_id regardless of ?outlet=,
// same defensive pattern as every other outlet-scoped read route.
//
// Used to also append a 'bk' pseudo-outlet checking whether Store Manager had submitted
// bk_closing_stock (a daily physical recount) that day. Removed — Stage 6 of the Store
// Inventory Module retired that screen (see 2026_08_27 nav changes): the whole point of
// the new ledger is that current stock is always known live from stock_movements, so a
// fresh manual recount is no longer a required DAILY action the way it used to be
// (Closing Counts is periodic reconciliation, not a daily punch). Leaving the old check
// in place would have shown a permanent false "missing" flag once nothing writes to
// bk_closing_stock anymore — removed rather than force-fit to a new table that doesn't
// actually represent a daily requirement.
router.get('/punch-status/:date', async (req, res) => {
  try {
    // outlet_mgr/chef: outlet-side Performance Dashboard's Punch Score card — same
    // scopedOutletFilter confinement as every other outlet-scoped read route below.
    const user = await requireRole(req, res, 'owner', 'avp', 'head_chef', 'outlet_mgr', 'chef');
    if (!user) return;
    const date = req.params.date;
    const allOutletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
    const scopedOutlet = scopedOutletFilter(user, req.query.outlet);
    const outletIds = scopedOutlet ? [scopedOutlet] : allOutletIds;
    const [
      { data: sales },
      { data: wastage },
      { data: demand },
      { data: closing },
      { data: purchases },
      { data: dispatched },
      sectionMap,
    ] = await Promise.all([
      supabase.from('daily_outlet_sales').select('outlet_id').eq('date', date).in('outlet_id', outletIds),
      supabase.from('demands').select('outlet_id').eq('date', date).eq('type', 'wastage').eq('status', 'submitted').in('outlet_id', outletIds),
      supabase.from('demands').select('outlet_id').eq('date', date).eq('type', 'manual').in('status', ['submitted', 'fulfilled']).in('outlet_id', outletIds),
      supabase.from('closing_stocks').select('outlet_id, items').eq('date', date).eq('status', 'submitted').in('outlet_id', outletIds),
      supabase.from('purchases').select('outlet_id, items').eq('date', date).in('outlet_id', outletIds),
      // Only 'fulfilled' orders (actually dispatched) count toward "needs verifying" —
      // an outlet with nothing dispatched that day has nothing to verify, so it's not
      // flagged at all rather than showing a false-positive missing punch.
      supabase.from('demands').select('outlet_id, received_at').eq('date', date).eq('status', 'fulfilled').in('outlet_id', outletIds),
      getDemandItemSectionMap(),
    ]);

    const has = (rows, oid) => (rows || []).some(r => r.outlet_id === oid);
    const outlets = outletIds.map((oid) => {
      const missing = [];
      if (!has(sales, oid)) missing.push('sales');
      if (!has(wastage, oid)) missing.push('wastage');
      if (!has(demand, oid)) missing.push('demand');
      if (!has(closing, oid)) missing.push('closing');
      const oPurchases = (purchases || []).filter(p => p.outlet_id === oid);
      if (!oPurchases.some(p => (p.items || []).some(i => i.type === 'dairy_purchase'))) missing.push('dairy_purchase');
      // cold_drink_purchase_none: an explicit "nothing to buy today" marker (see the DC
      // Purchase screen's "Not Purchased Today" button) — counts the same as a real
      // purchase for punch purposes, since not buying cold drinks every single day is
      // legitimate and shouldn't cost the manager their score.
      if (!oPurchases.some(p => (p.items || []).some(i => i.type === 'cold_drink_purchase' || i.type === 'cold_drink_purchase_none'))) missing.push('cold_drink_purchase');
      if ((dispatched || []).some(d => d.outlet_id === oid && !d.received_at)) missing.push('dispatch_verify');

      const closingRow = (closing || []).find(c => c.outlet_id === oid);
      const punchedSections = new Set();
      Object.keys(closingRow?.items || {}).forEach((key) => {
        const bareId = key.startsWith('cs_') ? key.slice(3) : key;
        const section = sectionMap[bareId];
        if (section) punchedSections.add(section);
      });
      const closing_categories = Object.fromEntries(CLOSING_CHECK_SECTIONS.map((sec) => [sec, punchedSections.has(sec)]));

      return { outlet_id: oid, missing, closing_categories };
    });

    res.json({ date, outlets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Extracted so /api/audit/:date (recipe-based leakage audit) can reuse the exact same
// per-outlet consumption numbers P&L and COGS Compare already show, instead of a second,
// possibly-drifting computation. Internal function — no req/res, no auth check (callers
// that expose this over HTTP are responsible for their own requireOwner).
// `costingContext` is optional — pass an already-built one (see buildCostingContext) when
// the caller needs it separately too (computeRMAudit used to call buildCostingContext()
// a second time after this function's own internal call, duplicating six queries for
// nothing); omit it and this fetches its own, same as before.
// Tried generalizing this to accept a { from, to } range once (so Finance's
// Consumption pill could compute a whole month in one shot instead of summing N
// single-day calls) — reverted. The Math.max(0, opening − closing) floor further down
// is NOT telescoping-safe: summing each day's floored usage is a genuinely different
// number from flooring once over the whole range whenever any individual day's balance
// dips (transfers, corrections, a same-day purchase landing oddly) — verified against
// real data, a 12-day range differed from the sum of its 12 daily calls by ~46,000 on a
// ~450,000 base. Since RM Audit/Daily P&L's own month view already IS "sum of daily
// calls" (DailyPnL's fetchMonthlyPnl does exactly that), that's the definition every
// other monthly figure in this app already uses — so Finance's Consumption pill sums
// day-by-day too (see computeConsumptionByOutlet in finance.js), just with bounded
// concurrency instead of firing every day's queries at once.
async function computeStockUsageForDate(date, outlet, costingContext) {
  {
    const prevDate = new Date(date);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = prevDate.toISOString().split('T')[0];

    // buildCostingContext() (unless already provided) and the six queries below don't
    // depend on each other's results (only the computation further down needs all of them
    // together), so they're all fired in one batch instead of one-at-a-time — this was
    // most of this endpoint's multi-second load time.
    const [
      { rateMap, bkRecipeMap, convMap, demandNameMap, demandUnitMap, convFactorFor },
      { data: prevClosing },
      { data: todayClosing },
      { data: prevClosingDraft },
      { data: todayClosingDraft },
      { data: todayWastage },
      { data: todayOrders },
      { data: confirmedTransfers },
      { data: todayPurchases },
    ] = await Promise.all([
      // Priced as-of this day when we build our own context, so consumption is valued at
      // that day's prices. A caller passing its own context is responsible for having priced
      // it for the right date (finance's day-loops pass costingContext.withDate(ds)).
      costingContext ? Promise.resolve(costingContext) : buildCostingContext(date),
      // 2. Previous day closing stock (from closing_stocks table, NOT demands) — status
      // filter excludes a still-in-progress Chef/Bainmarry draft from being treated as the
      // day's real closing figure.
      supabase.from('closing_stocks').select('outlet_id, items, items_units').eq('date', prevDateStr).eq('status', 'submitted'),
      // 3. Today closing stock
      supabase.from('closing_stocks').select('outlet_id, items, items_units').eq('date', date).eq('status', 'submitted'),
      // Draft-status closing stock (same dates) — queried separately so the P&L can tell
      // the owner "someone punched this but it was never finalized" apart from "nobody
      // touched it at all". Both read as has_..._submitted: false above, but they call for
      // very different action (nudge the outlet manager to finalize vs. chase the outlet
      // for numbers), so collapsing them into one generic "missing" warning was misleading.
      supabase.from('closing_stocks').select('outlet_id').eq('date', prevDateStr).eq('status', 'draft'),
      supabase.from('closing_stocks').select('outlet_id').eq('date', date).eq('status', 'draft'),
      // 4. Today wastage — status filter excludes a still-in-progress Chef/Bainmarry draft
      // from being treated as real wastage until the manager finalizes it.
      supabase.from('demands').select('outlet_id, items, items_units').eq('type', 'wastage').eq('date', date).eq('status', 'submitted'),
      // 5. Today dispatched
      supabase.from('demands').select('outlet_id, items, items_units, dispatch_items, status').eq('date', date),
      // 6. Today's confirmed inter-outlet transfers — a pending (unconfirmed) transfer
      // deliberately doesn't show up here at all, so it can't affect either outlet's
      // numbers until the receiver has actually confirmed what arrived.
      supabase.from('outlet_transfers').select('from_outlet_id, to_outlet_id, received_items').eq('date', date).eq('status', 'confirmed'),
      // 7. Today's Dairy/Cold Drink Purchase — these items are never dispatched from Base
      // Kitchen (outlets buy them directly), so without this the formula's only inbound
      // leg is Dispatched, which is always 0 for them — "actual consumed" silently
      // ignored every litre of milk/paneer/cold drink actually bought that day.
      supabase.from('purchases').select('outlet_id, items').eq('date', date),
    ]);
    const nameToItemId = {};
    Object.entries(demandNameMap).forEach(([id, name]) => { nameToItemId[(name || '').trim().toLowerCase()] = id; });
    const dispatched = (todayOrders || []).filter(o => o.status === 'fulfilled' || o.dispatch_items);

    // 6. Compute per outlet
    // 'bk' included as a regular entry (Stage 5 course-correction): confirmed with the
    // owner BK works exactly like an outlet now — its own demand-from-Store lands in
    // `demands` with outlet_id='bk' same as any real outlet's dispatch, its own wastage
    // and closing stock now go through the same closing_stocks/demands tables (see
    // BKClosingWastage.jsx) — so the exact same per-outlet formula below (Opening =
    // Yesterday Closing, +Dispatched, -Wastage, -Today Closing = Consumed) already
    // computes BK's figure correctly with no special-casing needed. This replaces the
    // old separate BK block that used to run further down (removed) — that one read
    // bk_closing_stock + inventory_movements, both confirmed to be Store's real data,
    // mislabeled, not BK's at all.
    const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid', 'bk'];
    const results = [];
    const outletLoopList = (!outlet || outlet === 'all') ? outletIds : [outlet];
    for (const oid of outletLoopList) {
      const prevCS = (prevClosing || []).find(d => d.outlet_id === oid);
      const prevItems = prevCS?.items || {};
      const prevUnits = prevCS?.items_units || {};
      const todayCS = (todayClosing || []).find(d => d.outlet_id === oid);
      const todayItems = todayCS?.items || {};
      const todayUnits = todayCS?.items_units || {};

      // Aggregate wastage — keep each record's own recorded unit (multiple wastage
      // submissions in a day could each use a different unit for the same item)
      const wastageEntries = {}; // { item_id: [{ qty, unit }] }
      (todayWastage || []).filter(d => d.outlet_id === oid).forEach(w => {
        Object.entries(w.items || {}).forEach(([id, qty]) => {
          if (!wastageEntries[id]) wastageEntries[id] = [];
          wastageEntries[id].push({ qty: Number(qty) || 0, unit: (w.items_units || {})[id] || null });
        });
      });

      // Aggregate dispatched — dispatch fulfills a specific demand record, so it inherits
      // that same record's items_units rather than having its own unit selection
      const dispatchedEntries = {};
      dispatched.filter(o => o.outlet_id === oid).forEach(o => {
        const items = o.dispatch_items || o.items || {};
        Object.entries(items).forEach(([id, qty]) => {
          if (!dispatchedEntries[id]) dispatchedEntries[id] = [];
          dispatchedEntries[id].push({ qty: Number(qty) || 0, unit: (o.items_units || {})[id] || null });
        });
      });

      // Aggregate inter-outlet transfers — received_items (the receiver-confirmed actual
      // qty) is the number both sides' math uses, so what leaves the sender exactly
      // equals what enters the receiver by construction, same value read from both sides
      // of the same row. No per-entry unit override like dispatch/wastage have (the
      // Transfer form only offers each item's own demand unit), so unit is always null
      // here and convFactorFor falls back to the item's default demand unit.
      const transferOutEntries = {};
      const transferInEntries = {};
      confirmedTransfers.forEach(t => {
        if (t.from_outlet_id === oid) {
          Object.entries(t.received_items || {}).forEach(([id, qty]) => {
            if (!transferOutEntries[id]) transferOutEntries[id] = [];
            transferOutEntries[id].push({ qty: Number(qty) || 0, unit: null });
          });
        }
        if (t.to_outlet_id === oid) {
          Object.entries(t.received_items || {}).forEach(([id, qty]) => {
            if (!transferInEntries[id]) transferInEntries[id] = [];
            transferInEntries[id].push({ qty: Number(qty) || 0, unit: null });
          });
        }
      });

      // Aggregate Dairy/Cold Drink Purchase — a separate inbound leg alongside dispatch,
      // matched by item name (purchases.items has no item_id) rather than the recipe/rate
      // matching the rest of this file uses, since the purchase form's dropdown already
      // guarantees an exact name match against demand_items.
      const purchasedEntries = {};
      (todayPurchases || []).filter(p => p.outlet_id === oid).forEach(p => {
        (p.items || []).filter(i => i.type === 'dairy_purchase' || i.type === 'cold_drink_purchase').forEach(i => {
          const id = nameToItemId[(i.item_name || '').trim().toLowerCase()];
          if (!id) return;
          if (!purchasedEntries[id]) purchasedEntries[id] = [];
          purchasedEntries[id].push({ qty: Number(i.quantity) || 0, unit: i.unit || null });
        });
      });

      // All unique item IDs — normalize cs_ prefix to avoid duplicates
      // closing_stocks uses cs_butter, dispatched uses butter — both refer to same item
      const allIdsRaw = [
        ...Object.keys(prevItems), ...Object.keys(todayItems),
        ...Object.keys(wastageEntries), ...Object.keys(dispatchedEntries), ...Object.keys(purchasedEntries),
        ...Object.keys(transferOutEntries), ...Object.keys(transferInEntries),
      ];
      // Normalize: strip cs_ prefix, deduplicate
      const allIds = new Set(allIdsRaw.map(id => id.startsWith('cs_') ? id.replace('cs_', '') : id));

      const itemDetails = [];
      let totalUsedCost = 0;

      allIds.forEach(itemId => {
        const csId = `cs_${itemId}`;

        // Raw quantities (in whatever unit each entry recorded — could be Batch, Tin, Kg, Pcs, etc.)
        const rawPrev = Number(prevItems[csId] || prevItems[itemId] || 0);
        const rawPrevUnit = prevUnits[csId] || prevUnits[itemId] || null;
        const rawClosing = Number(todayItems[csId] || todayItems[itemId] || 0);
        const rawClosingUnit = todayUnits[csId] || todayUnits[itemId] || null;

        // Determine pricing and category
        const rate = rateMap[itemId];
        const bkRecipe = bkRecipeMap[itemId];

        let unitPrice = 0;
        let itemName = itemId;
        let itemCategory = 'Other';
        let itemUnit = '';
        // What unitPrice is actually denominated in — normally identical to itemUnit
        // (both branches below set them together), UNLESS itemUnit gets overridden further
        // down for display/consumption purposes while the price stays in its original
        // rate-card unit (see the Gas Cylinder override). Kept separate so usedCost/rate
        // below always price the right unit instead of assuming they still match.
        let priceUnit = '';

        if (rate) {
          unitPrice = Number(rate.price);
          itemName = rate.name;
          itemCategory = rate.category || 'Other';
          itemUnit = rate.unit || '';
          priceUnit = itemUnit;
        } else if (bkRecipe) {
          unitPrice = bkRecipe.costPerKg;
          itemName = bkRecipe.name;
          itemCategory = 'Food';
          itemUnit = 'Kg';
          priceUnit = 'Kg';
        } else {
          itemName = demandNameMap[itemId] || itemId.replace(/_/g, ' ');
          itemUnit = demandUnitMap[itemId] || '';
          priceUnit = itemUnit;
        }
        // Gas Cylinder is priced/ordered by whole cylinder (rate.unit='Pcs') but a
        // partially-used cylinder's closing stock — and therefore how much gas was
        // actually consumed today — is naturally a weight, not a whole-Pcs count (same
        // reasoning as CLOSING_STOCK_UNIT_DEFAULTS on the frontend forcing Kg entry for
        // it). itemUnit changes to Kg here so prev_closing/closing/dispatched/used —
        // which feed both /api/stock-usage and RM Audit (computeRMAudit calls this
        // function) — come out in real Kg instead of a fractional, hard-to-read Pcs
        // count. priceUnit deliberately stays 'Pcs' (the rate card's real unit) so the
        // cost math below still prices correctly instead of treating ₹2,100 as a
        // per-Kg rate. See unit_conversions: 1 Pcs = 19 Kg.
        if (itemId === 'gas_cylinder') itemUnit = 'Kg';
        // Converts a quantity already expressed in itemUnit into priceUnit terms — 1 when
        // they match (every item except the Gas Cylinder override above).
        const priceConvFactor = convFactorFor(itemId, itemUnit, priceUnit);

        // Convert each of the four components using its OWN recorded unit (falls back to
        // the item's default demand unit when an entry didn't override it), then combine —
        // this is what lets different days/records legitimately use different units for the
        // same item without corrupting the consumed-material formula.
        const prevQty = rawPrev * convFactorFor(itemId, rawPrevUnit, itemUnit);
        const closingQty = rawClosing * convFactorFor(itemId, rawClosingUnit, itemUnit);
        const wastageQty = (wastageEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);
        const dispatchedQty = (dispatchedEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);
        const transferOutQty = (transferOutEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);
        const transferInQty = (transferInEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);
        const purchasedQty = (purchasedEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);

        // Default demand unit's conversion — used only for display labeling (conv_qty /
        // conv_base_unit below), independent of which unit any specific entry actually used.
        const demandUnit = demandUnitMap[itemId] || itemUnit;
        const du = (demandUnit || '').toLowerCase();
        const ru = (itemUnit || '').toLowerCase();
        const conv = convMap[itemId];
        const defaultFactor = convFactorFor(itemId, demandUnit, itemUnit);

        // Transfer in/out slot in exactly like an extra dispatch leg — positive for the
        // receiving outlet, negative for the sending one — so a confirmed transfer moves
        // "used" between the two outlets' books without changing their combined total.
        // Purchased is a second inbound leg alongside Dispatched — the only one dairy/cold
        // drink items ever have, since Base Kitchen never dispatches them.
        const openingQty = Math.max(0, prevQty - wastageQty) + dispatchedQty + purchasedQty + transferInQty - transferOutQty;
        const usedQty = Math.max(0, openingQty - closingQty);
        // usedQty is in itemUnit terms; unitPrice is in priceUnit terms — priceConvFactor
        // bridges the two (1 for every item except the Gas Cylinder override above, where
        // skipping this would price a Kg quantity at the per-cylinder rate, a 19x error).
        const usedCost = usedQty * priceConvFactor * unitPrice;

        // If no conversion was actually needed (demand unit already matches the rate
        // unit), show the item's own unit rather than an unrelated conv-table base unit.
        const displayUnit = du === ru || defaultFactor === 1 ? itemUnit : (conv ? conv.baseUnit : itemUnit);

        if (openingQty > 0 || closingQty > 0 || usedQty > 0 || dispatchedQty > 0 || purchasedQty > 0 || transferInQty > 0 || transferOutQty > 0) {
          itemDetails.push({
            item_id: itemId, name: itemName, category: itemCategory,
            unit: displayUnit,
            demand_unit: demandUnit,
            prev_closing: Math.round(prevQty * 1000) / 1000,
            wastage: Math.round(wastageQty * 1000) / 1000,
            dispatched: Math.round(dispatchedQty * 1000) / 1000,
            purchased: Math.round(purchasedQty * 1000) / 1000,
            transfer_in: Math.round(transferInQty * 1000) / 1000,
            transfer_out: Math.round(transferOutQty * 1000) / 1000,
            closing: Math.round(closingQty * 1000) / 1000,
            used: Math.round(usedQty * 1000) / 1000,
            // Default demand unit's conversion factor — for display only; the actual costing
            // above may have used a different factor per entry if a manager overrode the unit.
            conv_factor: defaultFactor,
            // Raw master conversion row (e.g. "1 Pkt = 200 Gm") — distinct from conv_factor,
            // which is the full compound factor (Pkt -> Gm -> Kg) used for costing above.
            conv_qty: conv ? conv.qty : null,
            conv_base_unit: conv ? conv.baseUnit : null,
            has_rate_card: !!rate,
            // Shown per displayUnit, not priceUnit — so it reads consistently with the
            // qty fields above (e.g. Gas Cylinder shows ₹/Kg, not the rate card's ₹/Pcs).
            rate: Math.round(unitPrice * priceConvFactor * 100) / 100,
            used_cost: Math.round(usedCost * 100) / 100,
          });
          totalUsedCost += usedCost;
        }
      });

      const byCategory = {};
      itemDetails.forEach(item => {
        if (!byCategory[item.category]) byCategory[item.category] = 0;
        byCategory[item.category] += item.used_cost;
      });

      results.push({
        outlet_id: oid, date,
        has_prev_closing: true, // treat missing as zero
        has_today_closing: true, // treat missing as zero
        prev_closing_submitted: !!prevCS,
        today_closing_submitted: !!todayCS,
        prev_closing_draft: !prevCS && (prevClosingDraft || []).some(d => d.outlet_id === oid),
        today_closing_draft: !todayCS && (todayClosingDraft || []).some(d => d.outlet_id === oid),
        total_used_cost: Math.round(totalUsedCost),
        variable_cost_by_category: byCategory,
        items: itemDetails.sort((a, b) => b.used_cost - a.used_cost),
      });
    }

    // ALL summary — same Elan exclusion as /pnl/live, so the consolidated variable-cost
    // figure that overrides P&L's 'all' row stays consistent with it. 'bk' excluded too,
    // same reasoning as always (BK preps for outlets rather than serving customers, so
    // its consumption is a distinct stream, not part of the outlet total) — it's now in
    // `results` because it flows through the same per-outlet loop above, so it has to be
    // filtered back out here explicitly rather than relying on it never being there.
    if (!outlet || outlet === 'all') {
      const consolidated = results.filter(r => r.outlet_id !== 'elan' && r.outlet_id !== 'bk');
      const summary = {
        outlet_id: 'all', date,
        has_prev_closing: true,
        has_today_closing: true,
        prev_closing_submitted: consolidated.every(r => r.prev_closing_submitted),
        today_closing_submitted: consolidated.every(r => r.today_closing_submitted),
        prev_closing_draft: consolidated.some(r => r.prev_closing_draft),
        today_closing_draft: consolidated.some(r => r.today_closing_draft),
        total_used_cost: consolidated.reduce((s, r) => s + r.total_used_cost, 0),
        variable_cost_by_category: {},
        items: [],
      };
      consolidated.forEach(r => {
        Object.entries(r.variable_cost_by_category).forEach(([cat, cost]) => {
          summary.variable_cost_by_category[cat] = (summary.variable_cost_by_category[cat] || 0) + cost;
        });
      });
      results.unshift(summary);
    }

    // BK's "used" leg is no longer computed separately here (Stage 5 course-correction)
    // — it's already in `results` from the main per-outlet loop above, since 'bk' is now
    // a regular entry in outletIds. The old version of this block read bk_closing_stock
    // + inventory_movements, both confirmed (with the owner) to be Store's real data,
    // mislabeled as BK's — removed rather than left in place, since it would otherwise
    // silently overwrite the correct entry the main loop already pushed for 'bk'.

    return { date, outlets: results };
  }
}

router.get('/stock-usage/:date', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner', 'avp', 'head_chef', 'franchise');
    if (!user) return;
    const result = await computeStockUsageForDate(req.params.date, scopedOutletFilter(user, req.query.outlet));
    res.json(result);
  } catch (err) {
    console.error('Stock usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/wastage/cost — Day-wise wastage cost per item, all outlets or one, for a
// date range. Same rate-card-first / BK-recipe-fallback costing as the consumed-material
// formula, applied only to wastage entries — powers the owner's Wastage grid's cost view,
// and the outlet Performance Dashboard's Wastage card (outlet_mgr/chef access, scoped to
// their own outlet_id regardless of what's requested, same defensive pattern as every
// other outlet-scoped read route).
router.get('/wastage/cost', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner', 'avp', 'head_chef', 'outlet_mgr', 'chef');
    if (!user) return;
    const { from } = req.query;
    if (!from) return res.status(400).json({ error: 'from is required' });
    const outlet_id = scopedOutletFilter(user, req.query.outlet_id);

    // Loaded once (undated); each wastage row is then priced as-of ITS OWN date so a past
    // day's wastage is valued at that day's prices. Per-date contexts are memoized so
    // withDate() (which rebuilds rateMap + BK recipe costs in memory) runs at most once per
    // distinct date, not once per row.
    const baseCtx = await buildCostingContext();
    const { demandNameMap, demandUnitMap, convFactorFor } = baseCtx;
    const ctxByDate = {};
    const ctxForDate = (d) => (ctxByDate[d] ||= baseCtx.withDate(d));

    let query = supabase.from('demands').select('outlet_id, date, items, items_units').eq('type', 'wastage').gte('date', from);
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    const { data: wastageRows, error } = await query;
    if (error) throw error;

    const results = [];
    (wastageRows || []).forEach(row => {
      const { rateMap, bkRecipeMap } = ctxForDate(row.date);
      Object.entries(row.items || {}).forEach(([itemId, qty]) => {
        const rate = rateMap[itemId];
        const bkRecipe = bkRecipeMap[itemId];
        let unitPrice = 0, itemUnit = '', itemName = itemId, itemCategory = 'Other';
        if (rate) {
          unitPrice = Number(rate.price); itemUnit = rate.unit || ''; itemName = rate.name; itemCategory = rate.category || 'Other';
        } else if (bkRecipe) {
          unitPrice = bkRecipe.costPerKg; itemUnit = 'Kg'; itemName = bkRecipe.name; itemCategory = 'Food';
        } else {
          itemName = demandNameMap[itemId] || itemId.replace(/_/g, ' ');
          itemUnit = demandUnitMap[itemId] || '';
        }
        const rawUnit = (row.items_units || {})[itemId] || null;
        const factor = convFactorFor(itemId, rawUnit, itemUnit);
        const convQty = (Number(qty) || 0) * factor;
        results.push({
          outlet_id: row.outlet_id, date: row.date, item_id: itemId, name: itemName,
          category: itemCategory, unit: itemUnit, qty: Math.round(convQty * 1000) / 1000,
          rate: Math.round(unitPrice * 100) / 100, cost: Math.round(convQty * unitPrice * 100) / 100,
          has_rate_card: !!(rate || bkRecipe),
        });
      });
    });

    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── GET /api/history/challans — Order challans last 30 days
router.get('/history/challans', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data, error } = await supabase.from('purchase_orders')
      .select('*')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/history/dispatches — Dispatched demands last 30 days
router.get('/history/dispatches', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data, error } = await supabase.from('demands')
      .select('*')
      .eq('type', 'manual')
      .eq('status', 'fulfilled')
      .gte('dispatched_at', thirtyDaysAgo.toISOString())
      .order('dispatched_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// GOOGLE SHEETS SETUP
// ============================================================
router.get('/sheets/setup', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    if (!sheetsHelper) {
      return res.status(400).json({ error: 'Google Sheets module not available' });
    }
    const results = await sheetsHelper.setupAllOutlets(supabase);
    res.json({ outlets: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CASH HANDOVER TRACKING
// ============================================================

router.get('/cash-handovers', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { month, date, from_role, to_role } = req.query;
    let query = supabase.from('cash_handovers').select('*').order('date', { ascending: false });
    if (date) query = query.eq('date', date);
    if (month) { const lastDay = new Date(Number(month.slice(0,4)), Number(month.slice(5,7)), 0).getDate(); query = query.gte('date', `${month}-01`).lte('date', `${month}-${String(lastDay).padStart(2,'0')}`); }
    if (from_role) query = query.eq('from_role', from_role);
    if (to_role) query = query.eq('to_role', to_role);
    if (!date && !month) query = query.limit(100);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Append-only — a custodian (Ravinder/Sahil/Ganga) can hand over cash to an owner more
// than once in a day, so this must not collapse multiple entries into one row the way
// the old upsert (onConflict: date,outlet_id,from_role) did.
router.post('/cash-handovers', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { date, from_role, from_name, to_role, to_name, outlet_id, amount, note } = req.body;
    if (!date || !amount) return res.status(400).json({ error: "Date and amount required" });
    // Every handover recorded by the app today is a custodian (Ravinder/Sahil/Ganga)
    // submitting to an owner — neither frontend form sends from_role/to_role, only
    // from_name/to_name, but the column is NOT NULL, so default it here.
    const { data, error } = await supabase.from('cash_handovers')
      .insert({ date, from_role: from_role || 'custodian', from_name, to_role: to_role || 'owner', to_name, outlet_id: outlet_id || null, amount: Number(amount), note })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cash-handovers/custodian/:name — Custodian Ledger data source. Sums cash
// an intermediate holder (Ravinder/Sahil/Ganga) has collected from outlets
// (daily_outlet_sales.cash_deposited where cash_deposited_by = :name, across all outlets/
// dates) against what they've since handed over to an owner (cash_handovers where
// from_name = :name) to get their current running balance — same "collected minus
// deposited" shape as the per-outlet Cash Ledger, one level up the chain.
router.get('/cash-handovers/custodian/:name', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const name = req.params.name;
    const { data: collections, error: collErr } = await supabase.from('daily_outlet_sales')
      .select('outlet_id, date, cash_deposited, cash_deposited_at')
      .eq('cash_deposited_by', name).order('date', { ascending: false });
    if (collErr) throw collErr;
    const { data: handovers, error: hoErr } = await supabase.from('cash_handovers')
      .select('*').eq('from_name', name).order('date', { ascending: false });
    if (hoErr) throw hoErr;

    // to_role distinguishes a real handover up the chain (owner) from cash the
    // custodian spent directly out of what they're holding (expense) — both reduce
    // the running balance, but only the former counts as "handed over".
    const ownerRows = (handovers || []).filter((h) => h.to_role !== 'expense');
    const expenseRows = (handovers || []).filter((h) => h.to_role === 'expense');

    const total_collected = (collections || []).reduce((s, c) => s + (Number(c.cash_deposited) || 0), 0);
    const total_handed_over = ownerRows.reduce((s, h) => s + (Number(h.amount) || 0), 0);
    const total_expenses = expenseRows.reduce((s, h) => s + (Number(h.amount) || 0), 0);

    res.json({
      name, total_collected, total_handed_over, total_expenses,
      balance: total_collected - total_handed_over - total_expenses,
      collections: collections || [], handovers: handovers || [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// PAYTM RECONCILIATION
// ============================================================

router.get('/paytm-actuals', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { month } = req.query; // YYYY-MM
    const year = Number((month || today().slice(0, 7)).slice(0, 4));
    const mon = Number((month || today().slice(0, 7)).slice(5, 7));
    const startDate = `${month || today().slice(0, 7)}-01`;
    const lastDay = new Date(year, mon, 0).getDate(); // correct last day of month
    const endDate = `${month || today().slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    const { data, error } = await supabase.from('paytm_actuals').select('*')
      .gte('date', startDate).lte('date', endDate).order('date');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/paytm-actuals', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { date, outlet_id, actual_amount } = req.body;
    const { data, error } = await supabase.from('paytm_actuals')
      .upsert({ date, outlet_id, actual_amount: Number(actual_amount) || 0 }, { onConflict: 'date,outlet_id' })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// RM ORDER CONFIG — 10-day requirement per item
// ============================================================

router.get('/rm-order-config', async (req, res) => {
  try {
    // Store managers (e.g. whoever's generating a challan) need to read this to see
    // the requirement the owner set — only setting it (POST below) stays owner-only.
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { data, error } = await supabase.from('rm_order_config').select('*');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rm-order-config', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { items } = req.body;
    if (!items || items.length === 0) return res.json({ ok: true, count: 0 });
    const upserts = items.map(i => ({
      item_id: i.item_id, rm_qty: Number(i.rm_qty) || 0,
      rm_unit: i.rm_unit || null, updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('rm_order_config').upsert(upserts, { onConflict: 'item_id' });
    if (error) throw error;
    res.json({ ok: true, count: upserts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/rm-order-config/suggest', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const { data: movements } = await supabase.from('inventory_movements')
      .select('item_id, quantity')
      .eq('type', 'stock_out')
      .gte('created_at', tenDaysAgo.toISOString());
    const usage = {};
    (movements || []).forEach(m => {
      usage[m.item_id] = (usage[m.item_id] || 0) + Math.abs(Number(m.quantity));
    });
    res.json(usage);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// PURCHASE ORDERS — Order Challans
// ============================================================

router.get('/purchase-orders', async (req, res) => {
  try {
    // Drivers read this to find their vegetable order for the day (see PATCH below).
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp', 'driver')) return;
    const { status, limit, date, from } = req.query;
    let query = supabase.from('purchase_orders').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (date) query = query.eq('date', date);
    if (from) query = query.gte('date', from);
    if (limit) query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/purchase-orders/:id', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { data, error } = await supabase.from('purchase_orders')
      .select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/purchase-orders', async (req, res) => {
  try {
    // Store managers generate challans day-to-day; owner-only here was blocking the
    // main use case entirely, not just the RM-requirement facilitator above.
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp')) return;
    const { items, notes, created_by, date } = req.body;
    const orderDate = date || todayIST();
    const { data: existing } = await supabase.from('purchase_orders')
      .select('id').eq('date', orderDate);
    const seq = (existing?.length || 0) + 1;
    const orderNumber = `PO-${orderDate}-${String(seq).padStart(3, '0')}`;
    const totalItems = Object.keys(items || {}).length;
    const { data, error } = await supabase.from('purchase_orders').insert({
      order_number: orderNumber, date: orderDate, status: 'pending',
      items: items || {}, total_items: totalItems, notes, created_by,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/purchase-orders/:id', async (req, res) => {
  try {
    // Was unguarded. Drivers use this to record bought_qty/total_price per item on
    // their vegetable order (a metadata-only update to purchase_orders.items — it
    // never touches inventory_stock, unlike the actual Stock-In/receive flow).
    // bk_manager added: the Vendor Challans (Beta) screen's legacy Order Challan
    // back-fill edit uses this same endpoint, and bk_manager has that tab (SCOPED_ROLE_TABS
    // in App.jsx) — was 403ing on save before this, same class of gap as inventory.js's
    // gate() needing the same widening earlier in this migration.
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp', 'driver', 'bk_manager')) return;
    const updates = {};
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.items !== undefined) updates.items = req.body.items;
    if (req.body.received_by !== undefined) {
      updates.received_by = req.body.received_by;
      updates.received_at = new Date().toISOString();
    }
    const { data: updated, error } = await supabase.from('purchase_orders').update(updates).eq('id', req.params.id).select('date, items').single();
    if (error) throw error;

    // Push each priced line's paid price (total_price ÷ bought_qty) into the rate-card
    // ledger, effective from the ORDER's own date (this is almost always a same-day-or-
    // later backfill, not a live receive, so today's date would be wrong — Rate Alert
    // needs the day the price was actually paid). This was the one gap in the price
    // ledger: every OTHER price source (vendor challans, cash/dairy purchases, manual
    // edits) already fed it, but this legacy Order Challan back-fill never did — real
    // priced Vegetable orders were silently invisible to Rate Alert. Best-effort, same as
    // the cash-purchase path above — a ledger failure never fails the save itself.
    if (req.body.items !== undefined) {
      try {
        const priceLines = Object.entries(updated.items || {})
          .map(([itemId, it]) => ({ itemId, qty: it.bought_qty != null ? Number(it.bought_qty) : Number(it.received_qty), price: Number(it.total_price), unit: it.unit }))
          .filter((l) => l.qty > 0 && l.price > 0);
        if (priceLines.length) {
          const byId = await resolveByItemIds(priceLines.map((l) => l.itemId));
          const entries = priceLines.map((l) => ({
            rateCardId: byId[l.itemId]?.rateCardId || null,
            price: l.price / l.qty,
            priceUnit: l.unit || byId[l.itemId]?.baseUnit,
            label: l.itemId,
          }));
          const { written, skipped } = await ingestPrices(entries, { effectiveDate: updated.date, source: 'legacy_order', sourceId: req.params.id, createdBy: req.body.received_by || null });
          if (skipped.length) console.warn(`[rate-card ledger] purchase order ${req.params.id}: wrote ${written} price(s), skipped ${skipped.length}:`, skipped);
        }
      } catch (e) { console.error(`[rate-card ledger] purchase order price ingest failed:`, e.message); }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/system-logs — Unified, owner-only activity log across every
// submission/edit action in the app: who did what, when, for which outlet+date.
// Normalizes several tables (demands, closing_stocks, daily_outlet_sales,
// purchases, qty_corrections) into one flat, chronological timeline so managers
// can't dispute what was actually submitted and when.
router.get('/system-logs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, from, to } = req.query;
    const defaultFrom = new Date(`${todayIST()}T00:00:00Z`); defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
    const fromDate = from || defaultFrom.toISOString().split('T')[0];
    const toDate = to || todayIST();

    const applyOutlet = (q) => outlet_id && outlet_id !== 'all' ? q.eq('outlet_id', outlet_id) : q;

    const [demandsRes, closingRes, salesRes, purchasesRes, correctionsRes] = await Promise.all([
      applyOutlet(supabase.from('demands').select('id, outlet_id, date, type, demand_slot, items, dispatch_items, status, submitted_by, submitted_at, dispatched_by, dispatched_at').gte('date', fromDate).lte('date', toDate)),
      applyOutlet(supabase.from('closing_stocks').select('outlet_id, date, items, submitted_by, submitted_at').gte('date', fromDate).lte('date', toDate)),
      applyOutlet(supabase.from('daily_outlet_sales').select('outlet_id, date, total_sale, cash_collected, cash_deposited, cash_deposited_by, cash_deposited_at, submitted_by, submitted_at').gte('date', fromDate).lte('date', toDate)),
      applyOutlet(supabase.from('purchases').select('outlet_id, date, total_amount, payment_mode, submitted_by, submitted_at').gte('date', fromDate).lte('date', toDate)),
      applyOutlet(supabase.from('qty_corrections').select('outlet_id, date, item_id, old_qty, new_qty, reason, corrected_by, corrected_at').gte('date', fromDate).lte('date', toDate)),
    ]);

    const logs = [];

    (demandsRes.data || []).forEach((d) => {
      const itemCount = Object.keys(d.items || {}).length;
      if (d.type === 'manual') {
        logs.push({
          category: 'demand', outlet_id: d.outlet_id, date: d.date,
          actor: d.submitted_by || 'Unknown', timestamp: d.submitted_at,
          detail: `${d.demand_slot === 'evening' ? 'Evening' : 'Morning'} demand submitted — ${itemCount} items`,
        });
      } else if (d.type === 'wastage') {
        logs.push({
          category: 'wastage', outlet_id: d.outlet_id, date: d.date,
          actor: d.submitted_by || 'Unknown', timestamp: d.submitted_at,
          detail: `Wastage recorded — ${itemCount} items`,
        });
      }
      if (d.dispatched_at) {
        const dispatchCount = Object.keys(d.dispatch_items || {}).length;
        logs.push({
          category: 'dispatch', outlet_id: d.outlet_id, date: d.date,
          actor: d.dispatched_by || 'Unknown', timestamp: d.dispatched_at,
          detail: `Dispatched (${d.status}) — ${dispatchCount} items`,
        });
      }
    });

    (closingRes.data || []).forEach((c) => {
      logs.push({
        category: 'closing_stock', outlet_id: c.outlet_id, date: c.date,
        actor: c.submitted_by || 'Unknown', timestamp: c.submitted_at,
        detail: `Closing stock submitted — ${Object.keys(c.items || {}).length} items`,
      });
    });

    (salesRes.data || []).forEach((s) => {
      logs.push({
        category: 'sales', outlet_id: s.outlet_id, date: s.date,
        actor: s.submitted_by || 'Unknown', timestamp: s.submitted_at,
        detail: `Daily sales submitted — Total ₹${Number(s.total_sale || 0).toLocaleString('en-IN')}, Cash ₹${Number(s.cash_collected || 0).toLocaleString('en-IN')}`,
      });
      if (s.cash_deposited_at) {
        logs.push({
          category: 'cash', outlet_id: s.outlet_id, date: s.date,
          actor: s.cash_deposited_by || 'Unknown', timestamp: s.cash_deposited_at,
          detail: `Cash collection recorded — ₹${Number(s.cash_deposited || 0).toLocaleString('en-IN')}`,
        });
      }
    });

    (purchasesRes.data || []).forEach((p) => {
      logs.push({
        category: 'purchase', outlet_id: p.outlet_id, date: p.date,
        actor: p.submitted_by || 'Unknown', timestamp: p.submitted_at,
        detail: `Cash purchase — ₹${Number(p.total_amount || 0).toLocaleString('en-IN')} (${p.payment_mode || 'cash'})`,
      });
    });

    (correctionsRes.data || []).forEach((c) => {
      logs.push({
        category: 'correction', outlet_id: c.outlet_id, date: c.date,
        actor: c.corrected_by || 'Unknown', timestamp: c.corrected_at,
        detail: `Qty corrected — ${c.item_id}: ${c.old_qty} → ${c.new_qty} (${c.reason || 'no reason given'})`,
      });
    });

    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
// Franchise Billing corrections — Qty/Rate edits made in the Edit/Done UI used to be
// component state only, so they vanished on every refresh. Persisted here as one row per
// outlet+month bill in the generic app_config key/value table (key format:
// "franchise_billing:{outlet_id}:{month}", value is a JSON string) rather than a
// dedicated table, so this works immediately with no schema migration required. Saved in
// a single batch when "Done" is tapped, not per-keystroke.
// ────────────────────────────────────────────────────────────

// ── GET /api/bk-recipe-costs — cost-per-unit for every BK-prepared item (Sambhar, Dosa
// Batter, chutneys, ...), the same rate-card-first-then-BK-recipe-cost rule P&L/RM Audit/
// dish costing already use. Franchise Billing was pricing these purely off the rate card
// (which BK-prepared items never have — they're priced via their own recipe instead), so
// every one of them billed at ₹0. Reuses buildCostingContext's bkRecipeMap rather than a
// second implementation of the same resolution logic.
router.get('/bk-recipe-costs', async (req, res) => {
  try {
    if (!await requireRole(req, res, 'owner', 'store_mgr', 'avp', 'head_chef', 'franchise')) return;
    const { bkRecipeMap } = await buildCostingContext();
    res.json(bkRecipeMap);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/franchise-billing/corrections', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner', 'store_mgr', 'avp', 'head_chef', 'franchise');
    if (!user) return;
    const month = req.query.month;
    const outlet_id = scopedOutletFilter(user, req.query.outlet_id);
    if (!outlet_id || !month) return res.status(400).json({ error: 'outlet_id and month are required' });
    const { data, error } = await supabase.from('app_config').select('value')
      .eq('key', `franchise_billing:${outlet_id}:${month}`).maybeSingle();
    if (error) throw error;
    const parsed = data?.value ? JSON.parse(data.value) : {};
    res.json({ edits: parsed.edits || {}, day_edits: parsed.day_edits || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/franchise-billing/corrections', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!['owner', 'store_mgr', 'avp'].includes(user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const { outlet_id, month, edits, day_edits } = req.body;
    if (!outlet_id || !month) return res.status(400).json({ error: 'outlet_id and month are required' });
    const value = JSON.stringify({ edits: edits || {}, day_edits: day_edits || {}, updated_by: user.name, updated_at: new Date().toISOString() });
    const { error } = await supabase.from('app_config').upsert({
      key: `franchise_billing:${outlet_id}:${month}`, value,
    }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ ok: true, edits: edits || {}, day_edits: day_edits || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
// Franchise Settings — owner-controlled markup % (on material cost) and royalty %
// (on revenue) per franchise outlet, effective-dated. Every save is a new row, never an
// UPDATE, so a bill for a past month always reflects the terms actually in force then
// even after the agreement is later renegotiated. `is_franchise` itself lives on the
// `outlets` table (PATCH /api/outlets/:id) since it's a structural flag, not a term.
// ────────────────────────────────────────────────────────────

// ── GET /api/franchise-settings — full version history (optionally one outlet)
router.get('/franchise-settings', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner', 'avp', 'franchise');
    if (!user) return;
    const outlet_id = scopedOutletFilter(user, req.query.outlet_id);
    let query = supabase.from('franchise_settings').select('*').order('outlet_id').order('effective_from', { ascending: false });
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/franchise-settings — record a new agreement version
router.post('/franchise-settings', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner');
    if (!user) return;
    const { outlet_id, markup_pct, royalty_pct, effective_from, notes, category_markup } = req.body;
    if (!outlet_id || !effective_from) return res.status(400).json({ error: 'outlet_id and effective_from are required' });
    const markup = Number(markup_pct);
    const royalty = Number(royalty_pct);
    if (!Number.isFinite(markup) || markup < 0 || markup > 100) return res.status(400).json({ error: 'markup_pct must be a number between 0 and 100' });
    if (!Number.isFinite(royalty) || royalty < 0 || royalty > 100) return res.status(400).json({ error: 'royalty_pct must be a number between 0 and 100' });
    // Optional per-category override on top of the flat markup_pct above — e.g. a lower
    // markup on Packaging, higher on prepared Food. Any category not present here just
    // uses markup_pct, same as before this existed. Validated the same way as the flat
    // field (a number 0-100) so a bad category override can't silently corrupt a bill.
    let categoryMarkup = {};
    if (category_markup && typeof category_markup === 'object') {
      for (const [catId, pct] of Object.entries(category_markup)) {
        const n = Number(pct);
        if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: `category_markup.${catId} must be a number between 0 and 100` });
        categoryMarkup[catId] = n;
      }
    }
    let { error } = await supabase.from('franchise_settings').insert({
      outlet_id, markup_pct: markup, royalty_pct: royalty, effective_from, notes: notes || null, created_by: user.name,
      category_markup: categoryMarkup,
    });
    // Falls back to inserting without category_markup if the column doesn't exist yet
    // (migration 2026_08_27_franchise_settings_category_markup.sql not applied to this DB
    // yet) — without this, every "New Agreement Version" save breaks outright the moment
    // this route deploys, until someone remembers to run the migration first. PostgREST's
    // own code for "column not in its schema cache" is PGRST204 (not Postgres's raw
    // undefined_column 42703 — PostgREST intercepts it before it reaches that far).
    if (error && error.code === 'PGRST204') {
      console.warn('[franchise-settings] category_markup column missing — insert retried without it. Run migration 2026_08_27_franchise_settings_category_markup.sql.');
      ({ error } = await supabase.from('franchise_settings').insert({
        outlet_id, markup_pct: markup, royalty_pct: royalty, effective_from, notes: notes || null, created_by: user.name,
      }));
    }
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/franchise-settings/:id — undo a mistaken agreement entry
router.delete('/franchise-settings/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('franchise_settings').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/franchise-billing/summary — markup/BK-share/royalty totals for one
// outlet's monthly bill, on top of the existing item-level Material Cost (which stays
// client-computed in FranchiseBilling so manual corrections keep flowing through).
// The BK-share ratio needs every outlet's material cost, which a franchise-scoped user
// can't fetch directly, so it's computed here server-side.
router.get('/franchise-billing/summary', async (req, res) => {
  try {
    const user = await requireRole(req, res, 'owner', 'avp', 'franchise');
    if (!user) return;
    const outlet_id = scopedOutletFilter(user, req.query.outlet_id);
    // 3 ways to scope this: ?from=&to= (an explicit range — the Week pill), ?date= (a
    // single day — the Date pill, equivalent to from===to), or ?month= (the Month pill,
    // the original/default). Everything below (material cost, revenue, agreement lookup)
    // already queries an explicit [monthStart, monthEnd] range regardless of which of the
    // three was used, so this just normalizes all three down to that one range. `month` is
    // still derived either way (from `from` or `date`) since it's kept as the response's own
    // `month` field — the caller's corrections/agreement lookups are keyed by month, so they
    // don't need their own separate range-vs-day-vs-month branching.
    const explicitFrom = req.query.from;
    const explicitTo = req.query.to;
    const date = req.query.date;
    const month = explicitFrom ? explicitFrom.slice(0, 7) : date ? date.slice(0, 7) : req.query.month;
    if (!outlet_id || !month) return res.status(400).json({ error: 'outlet_id and month (or date, or from/to) are required' });

    const [y, mo] = month.split('-').map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const monthStart = explicitFrom || date || `${month}-01`;
    // Built from y/mo/daysInMonth directly rather than `new Date(y, mo, 0).toISOString()` —
    // that constructs the date in the SERVER's local timezone (IST, UTC+5:30) then converts
    // to UTC for the ISO string, which lands on the 30th instead of the 31st for a 31-day
    // month (midnight IST on the 31st is still the 30th in UTC). Harmless before this
    // proration existed (nothing compared monthEnd's exact date against daysInMonth), but
    // silently made daysInRange one short of daysInMonth for every whole-month query,
    // under-billing BK Share by ~3% every month once the ratio was introduced.
    const monthEnd = explicitTo || date || `${month}-${String(daysInMonth).padStart(2, '0')}`;
    // BK's fixed costs (rent, salaries, ...) are stored as one flat MONTHLY figure — fine
    // as-is for a whole-month query (daysInRange === daysInMonth below, so this is a no-op),
    // but billing a single day (or a week) off the FULL month's rent would overstate that
    // period's BK Share. Prorated by the fraction of the month actually being queried. A
    // Week range that happens to cross a calendar month boundary uses the FROM date's
    // month length for this — a known simplification, not exact for that edge case, but
    // the ratio's numerator (daysInRange) is still exactly right either way.
    const daysInRange = Math.round((new Date(monthEnd) - new Date(monthStart)) / 86400000) + 1;
    const fixedCostProration = daysInRange / daysInMonth;

    const allOutletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];

    const [{ rateMap, bkRecipeMap, demandUnitMap, convFactorFor }, { data: demands, error: demandsErr }, { data: agreements, error: agreementsErr }, { data: bkFixed, error: bkFixedErr }, salesByOutlet] = await Promise.all([
      // Priced as-of month end — the whole month's dispatch is valued at that month's
      // prices, and because prices are forward-only a later challan never reprices a past
      // month's franchise bill.
      buildCostingContext(monthEnd),
      supabase.from('demands').select('outlet_id, dispatch_items').eq('type', 'manual').neq('status', 'draft').gte('date', monthStart).lte('date', monthEnd),
      supabase.from('franchise_settings').select('*').eq('outlet_id', outlet_id).lte('effective_from', monthEnd).order('effective_from', { ascending: false }).limit(1),
      supabase.from('fixed_costs').select('amount').eq('outlet_id', 'bk').eq('active', true),
      // Real PetPooja billing (daily_sales), not daily_outlet_sales — that table is the
      // outlet manager's old manual "Daily Sales & Cash" entry, abandoned once the app
      // switched to syncing real billing data. It was still wired in here: Elan had ZERO
      // daily_outlet_sales rows for August despite ₹8.25L in real revenue that month, so
      // Royalty (revenue × royalty_pct) was silently billing ₹0 royalty every month.
      computeDailySalesRevenue({ from: monthStart, to: monthEnd }),
    ]);
    if (demandsErr) throw demandsErr;
    if (agreementsErr) throw agreementsErr;
    if (bkFixedErr) throw bkFixedErr;

    // Material cost per outlet — dispatched qty × rate card price (BK-recipe fallback for
    // items with no rate card row), same pricing rule as /pnl/live's variable-cost block
    // and /wastage/cost. Raw (uncorrected) on purpose: this ratio must be computed the same
    // way for every outlet, and a franchise's own manual bill corrections shouldn't skew
    // how much of BK's fixed cost gets allocated to it.
    const materialCostByOutlet = {};
    allOutletIds.forEach(id => { materialCostByOutlet[id] = 0; });
    (demands || []).forEach(d => {
      if (!allOutletIds.includes(d.outlet_id)) return;
      Object.entries(d.dispatch_items || {}).forEach(([itemId, qty]) => {
        if (!qty || qty <= 0) return;
        const rate = rateMap[itemId];
        const bkRecipe = bkRecipeMap[itemId];
        let unitPrice = 0, itemUnit = '';
        if (rate) { unitPrice = Number(rate.price); itemUnit = rate.unit || ''; }
        else if (bkRecipe) { unitPrice = bkRecipe.costPerKg; itemUnit = 'Kg'; }
        else return;
        const rawUnit = demandUnitMap[itemId] || itemUnit;
        const factor = convFactorFor(itemId, rawUnit, itemUnit);
        materialCostByOutlet[d.outlet_id] += (Number(qty) || 0) * factor * unitPrice;
      });
    });
    const rawOutletMaterialCost = materialCostByOutlet[outlet_id] || 0;
    const rawMaterialCostAllOutlets = Object.values(materialCostByOutlet).reduce((s, v) => s + v, 0);
    const bkShareRatio = rawMaterialCostAllOutlets > 0 ? rawOutletMaterialCost / rawMaterialCostAllOutlets : 0;

    const bkMonthlyFixed = (bkFixed || []).reduce((s, f) => s + Number(f.amount || 0), 0) * fixedCostProration;
    const revenue = salesByOutlet[outlet_id]?.total_sale || 0;

    const agreement = agreements && agreements[0]
      ? { markup_pct: Number(agreements[0].markup_pct), royalty_pct: Number(agreements[0].royalty_pct), effective_from: agreements[0].effective_from, notes: agreements[0].notes, category_markup: agreements[0].category_markup || {} }
      : null;

    res.json({
      outlet_id, month, date: date || null, from: monthStart, to: monthEnd, agreement,
      bk_share_ratio: bkShareRatio,
      // Already prorated to daysInRange when a single day (or any partial period) was
      // requested — bk_monthly_fixed is a slight misnomer for that case (it's really "BK
      // fixed cost for the requested period"), kept as-is so existing month-mode callers
      // don't need to change anything.
      bk_monthly_fixed: Math.round(bkMonthlyFixed),
      revenue: Math.round(revenue),
      raw_outlet_material_cost: Math.round(rawOutletMaterialCost),
      raw_material_cost_all_outlets: Math.round(rawMaterialCostAllOutlets),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// Attached as properties on the router (a function, which can hold arbitrary properties
// in JS) rather than switched to a named-export object — every existing
// `require('./salesRoutes')` call site treats this as the router itself
// (`app.use('/api', salesRoutes)`), so that has to keep working unchanged. Exported for
// the Finance module (finance.js) to reuse the same revenue/costing logic instead of a
// second, possibly-drifting copy of the rate-card/BK-recipe pricing rules.
module.exports.computeDailySalesRevenue = computeDailySalesRevenue;
module.exports.buildCostingContext = buildCostingContext;
module.exports.computeBkPurchaseByOutlet = computeBkPurchaseByOutlet;
module.exports.computeBkPurchaseDetail = computeBkPurchaseDetail;
module.exports.resolveFixedCostsForMonth = resolveFixedCostsForMonth;
// Exported for finance.js's Consumption-basis pill — same Yesterday Closing + Dispatched
// − Wastage − Today Closing formula Daily P&L/RM Audit already use, reused per-day
// instead of a second, possibly-drifting copy of this logic.
module.exports.computeStockUsageForDate = computeStockUsageForDate;
