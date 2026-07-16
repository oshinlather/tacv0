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
const { requireAuth, requireOwner, requireRole, ensureOutletAccess, invalidateUser } = require('./authGuards');
const { todayIST } = require('../helpers');
const { creditStockIn } = require('../inventoryLedger');
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
// Every daily_sales read needs to page through with .range() until a page comes back short.
async function fetchAllDailySales({ date, from, to, outlet_code, select }) {
  const rows = [];
  const PAGE = 1000;
  for (let pageFrom = 0; ; pageFrom += PAGE) {
    let query = supabase.from('daily_sales').select(select || '*').range(pageFrom, pageFrom + PAGE - 1);
    query = date ? query.eq('sale_date', date) : query.gte('sale_date', from).lte('sale_date', to);
    if (outlet_code) query = query.eq('outlet_code', outlet_code);
    const { data: page, error } = await query;
    if (error) throw error;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

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
});
})
.on('end', resolve)
.on('error', reject);
});

if (rows.length === 0) {
return res.status(400).json({ error: 'No valid rows found in CSV' });
}

// Get the date from first row
const uploadDate = rows[0].sale_date;

// Delete existing data for this date (re-upload replaces)
await supabase.from('daily_sales').delete().eq('sale_date', uploadDate);

// Insert in batches of 500
const batchSize = 500;
let inserted = 0;
for (let i = 0; i < rows.length; i += batchSize) {
const batch = rows.slice(i, i + batchSize);
const { error } = await supabase.from('daily_sales').insert(batch);
if (error) throw error;
inserted += batch.length;
}

// After upload, trigger P&L + audit computation
await computeDailyPnL(uploadDate);
await computeRMAudit(uploadDate);

res.json({
success: true,
date: uploadDate,
rows_inserted: inserted,
outlets: [...new Set(rows.map(r => r.outlet_code))],
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('recipes').update({ status: 'Inactive', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/recipes/:id/ingredients — Add an ingredient to a dish recipe (owner-only)
router.post('/recipes/:id/ingredients', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('recipe_ingredients').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
// 3D. GET /api/audit/:date — Raw Material Audit
// ────────────────────────────────────────────────────────────
router.get('/audit/:date', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
    const { date } = req.params;
    const outlets = await computeRMAudit(date, req.query.outlet);
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

// Theoretical (recipe) consumption vs ACTUAL outlet-level consumption — the same
// Yesterday Closing + Dispatched − Wastage − Today Closing figure P&L and COGS Compare
// already show (via computeStockUsageForDate), not Base Kitchen's internal issuance
// records. Computed per outlet so leakage can be compared outlet-to-outlet, since every
// outlet cooks from the same recipes and dispatches from the same base kitchen.
async function computeRMAudit(date, outletFilter) {
  const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
  const targetOutlets = outletFilter && outletFilter !== 'all' ? [outletFilter] : outletIds;

  const sales = await fetchAllDailySales({ date, select: 'outlet_code, item_name, item_quantity' });
  const { data: recipes } = await supabase.from('recipes')
    .select('id, item_name, recipe_ingredients ( raw_material, qty, unit, qty_kg )').eq('status', 'Active');

  const recipeByNormName = {};
  (recipes || []).forEach(r => { recipeByNormName[normalizeDishName(r.item_name)] = r; });

  const stockUsage = await computeStockUsageForDate(date, outletFilter);
  const actualByOutlet = {};
  stockUsage.outlets.forEach(o => { actualByOutlet[o.outlet_id] = o; });

  const results = [];
  for (const oid of targetOutlets) {
    const salesByDish = {};
    (sales || []).filter(s => s.outlet_code === oid).forEach(s => {
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
        theoretical[key].breakdown.push({ dish: dishName, qty_sold: qty, per_dish: perDish, subtotal: Math.round(perDish * qty * 1000) / 1000 });
      });
    });

    const actualById = {};
    (actualByOutlet[oid]?.items || []).forEach(it => { actualById[it.item_id] = it; });

    const unmappedIngredients = new Set();
    const items = Object.values(theoretical).map(t => {
      const key = normalizeIngredientName(t.raw_material);
      const mappedId = RECIPE_RAW_MATERIAL_MAP[key];
      if (!mappedId) { unmappedIngredients.add(t.raw_material); return null; }
      const actualItem = actualById[mappedId];
      const shouldConsume = t.qty_kg > 0 ? t.qty_kg : t.qty_count;
      const actualQty = actualItem ? actualItem.used : null;
      const variance = actualQty != null ? Math.round((actualQty - shouldConsume) * 1000) / 1000 : null;
      const variancePct = actualQty != null && shouldConsume > 0 ? Math.round((variance / shouldConsume) * 1000) / 10 : null;
      return {
        raw_material: t.raw_material,
        item_id: mappedId,
        unit: t.qty_kg > 0 ? 'Kg' : (actualItem?.unit || t.unit || 'Pcs'),
        should_consume: Math.round(shouldConsume * 1000) / 1000,
        should_consume_breakdown: t.breakdown.sort((a, b) => b.subtotal - a.subtotal),
        actual_consumed: actualQty != null ? Math.round(actualQty * 1000) / 1000 : null,
        actual_breakdown: actualItem ? {
          prev_closing: actualItem.prev_closing, dispatched: actualItem.dispatched,
          wastage: actualItem.wastage, closing: actualItem.closing,
        } : null,
        variance, variance_pct: variancePct,
      };
    }).filter(Boolean).sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0));

    // Dish-TYPE match count (dishes_matched/dishes_sold below) can look fine even when a
    // huge chunk of actual VOLUME sold is unmatched — a handful of high-volume dishes with
    // no recipe understates should_consume far more than the type count suggests, which in
    // turn inflates that outlet's leakage % for reasons that have nothing to do with real
    // over-consumption. Surface coverage by volume too, so a low-coverage outlet's numbers
    // aren't compared like-for-like against a high-coverage one.
    const qtySoldTotal = Object.values(salesByDish).reduce((s, q) => s + q, 0);
    const qtySoldUnmatched = unmatchedDishes.reduce((s, d) => s + d.qty, 0);
    const qtySoldMatched = qtySoldTotal - qtySoldUnmatched;

    results.push({
      outlet_id: oid, date,
      items,
      unmatched_dishes: unmatchedDishes.sort((a, b) => b.qty - a.qty),
      unmapped_ingredients: [...unmappedIngredients],
      dishes_sold: Object.keys(salesByDish).length,
      dishes_matched: Object.keys(salesByDish).length - unmatchedDishes.length,
      sales_qty_total: qtySoldTotal,
      sales_qty_matched: qtySoldMatched,
      sales_coverage_pct: qtySoldTotal > 0 ? Math.round((qtySoldMatched / qtySoldTotal) * 1000) / 10 : null,
    });
  }
  return results;
}

// Raw-material-id → rate-card id, for BK-prepared items' OWN ingredients (Dosa Batter's
// rice/urad dal/etc, not the dish's ingredients). This is a separate, deliberate copy of
// the mapping the live P&L uses internally (salesRoutes.js ~line 2313) rather than a shared
// import — P&L pricing is safety-critical (real money, tied to actual dispatch that day),
// so this dish-costing tool (a "what would this cost right now" browsing calculator,
// decoupled from any day's dispatch) is kept intentionally independent of it.
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
function unitsCompatible(a, b) {
  const ua = (a || '').toLowerCase(), ub = (b || '').toLowerCase();
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
// by many dishes (e.g. Dosa Batter) is only priced once, not once per dish.
function buildBkCostLookup(rateMap, bkRecipes, bkIngredientsByRecipe) {
  const cache = {};
  return (bkId) => {
    if (cache[bkId] !== undefined) return cache[bkId];
    const bk = (bkRecipes || []).find(r => r.id === bkId);
    if (!bk) return (cache[bkId] = null);
    let total = 0;
    (bkIngredientsByRecipe[bkId] || []).forEach(ing => {
      const rmId = ing.raw_material_id;
      const rateId = rateMap[rmId] ? rmId : (BK_INGREDIENT_TO_RATE[rmId] && rateMap[BK_INGREDIENT_TO_RATE[rmId]] ? BK_INGREDIENT_TO_RATE[rmId] : null);
      if (rateId) total += Number(ing.qty || 0) * Number(rateMap[rateId].price);
    });
    const yieldQty = Number(bk.yield_qty) || 1;
    return (cache[bkId] = { perUnit: yieldQty > 0 ? total / yieldQty : 0, unit: bk.yield_unit });
  };
}

// Pure per-recipe costing — no DB calls — so it can run once per dish inside a bulk loop
// without re-fetching rate_card/bk_recipes for every dish.
function costRecipeIngredients(recipeIngredients, rateMap, bkCostPerUnit) {
  const ingredients = (recipeIngredients || []).map(ing => {
    const key = normalizeIngredientName(ing.raw_material);
    const mappedId = RECIPE_RAW_MATERIAL_MAP[key];
    const base = { raw_material: ing.raw_material, qty: ing.qty, unit: ing.unit };

    if (!mappedId) return { ...base, priced: false, reason: 'not linked to any rate card item or BK recipe', cost: null, rate: null };

    if (rateMap[mappedId]) {
      const rate = rateMap[mappedId];
      let qty = Number(ing.qty || 0), unit = ing.unit;
      const u = (unit || '').toLowerCase(), ru = (rate.unit || '').toLowerCase();
      if (u === 'gm' && ru === 'kg') { qty = qty / 1000; unit = 'Kg'; }
      else if (u === 'ml' && (ru === 'ltr' || ru === 'ltr.')) { qty = qty / 1000; unit = 'Ltr'; }
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
  const { data: rates } = await supabase.from('rate_card').select('*').eq('active', true);
  const rateMap = {};
  (rates || []).forEach(r => { rateMap[r.id] = r; });
  const { data: bkRecipes } = await supabase.from('bk_recipes').select('*');
  const { data: bkIngredients } = await supabase.from('bk_recipe_ingredients').select('*');
  const bkIngredientsByRecipe = {};
  (bkIngredients || []).forEach(i => { (bkIngredientsByRecipe[i.recipe_id] = bkIngredientsByRecipe[i.recipe_id] || []).push(i); });
  return { rateMap, bkCostPerUnit: buildBkCostLookup(rateMap, bkRecipes, bkIngredientsByRecipe) };
}

async function computeDishCost(recipeId) {
  const { data: recipe } = await supabase.from('recipes')
    .select('id, item_name, recipe_ingredients ( raw_material, qty, unit, qty_kg )').eq('id', recipeId).single();
  if (!recipe) return null;
  const { rateMap, bkCostPerUnit } = await loadCostingContext();
  const costed = costRecipeIngredients(recipe.recipe_ingredients, rateMap, bkCostPerUnit);
  return { item_name: recipe.item_name, ...costed };
}

// Cost for every active dish at once, keyed by normalized dish name — lets a sales table
// (many item rows) show cost-per-item without one API round trip per row.
async function computeAllDishCosts() {
  const { data: recipes } = await supabase.from('recipes')
    .select('id, item_name, recipe_ingredients ( raw_material, qty, unit, qty_kg )').eq('status', 'Active');
  const { rateMap, bkCostPerUnit } = await loadCostingContext();
  const byNormName = {};
  (recipes || []).forEach(r => {
    const costed = costRecipeIngredients(r.recipe_ingredients, rateMap, bkCostPerUnit);
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
    if (!await requireOwner(req, res)) return;
const { id, section_id, name, unit, sort_order } = req.body;
const { data, error } = await supabase.from('demand_items').upsert({ id, section_id, name, unit, sort_order: sort_order || 99 });
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/master/demand-items/:id — Update demand item
router.patch('/master/demand-items/:id', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
const { error } = await supabase.from('demand_items').update({ active: false }).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/master/raw-materials — Add new raw material
router.post('/master/raw-materials', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { id, name, unit } = req.body;
const { error } = await supabase.from('raw_materials').upsert({ id, name, unit });
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/master/raw-materials/:id — Update raw material
router.patch('/master/raw-materials/:id', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
const { error } = await supabase.from('raw_materials').update({ active: false }).eq('id', req.params.id);
if (error) throw error;
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/master/recipes — Add/update recipe
router.post('/master/recipes', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
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
res.json({ ok: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/master/recipes/:id
router.delete('/master/recipes/:id', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireRole(req, res, 'owner', 'store_mgr')) return;
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
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const { data, error } = await supabase.from('app_users')
      .insert({ name, phone, pin, role: role || 'outlet_mgr', outlet_id: outlet_id || null })
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
    const { data, error } = await supabase.from('app_users').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/demands — Create demand (robust version, handles all types)
router.post('/demands', async (req, res) => {
  try {
    const { outlet_id, type, items, items_units, note, date, demand_slot, submitted_by, status } = req.body;
    if (!outlet_id || !type) return res.status(400).json({ error: "outlet_id and type are required" });

    const record = {
      outlet_id,
      type,
      items: items || {},
      // Per-item unit overrides, only for items where the manager picked something
      // other than the item's default demand unit — e.g. { desi_ghee: 'Kg' }.
      items_units: items_units && Object.keys(items_units).length > 0 ? items_units : null,
      note: note || null,
      date: date || todayIST(),
      demand_slot: demand_slot || null,
      submitted_by: submitted_by || null,
      status: status || 'submitted',
      submitted_at: new Date().toISOString(),
    };
    
    const { data, error } = await supabase.from('demands').insert(record).select('*').single();
    if (error) throw error;
    // Write to Google Sheet (non-blocking)
    if (sheetsHelper && outlet_id !== 'bk') sheetsHelper.writeToSheet(supabase, outlet_id, type, submitted_by, record, items).catch(() => {});
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

// ── PATCH /api/demands/:id/draft — Update draft demand items
router.patch('/demands/:id/draft', async (req, res) => {
  try {
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
    const { date, outlet_id, status, from } = req.query;
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

// ============================================================
// DISPATCH CHALLAN — Save actual dispatched quantities
// ============================================================

// ── PATCH /api/orders/:id/dispatch — Save dispatched items, mark fulfilled
// Supports partial dispatch: checked items get dispatched, unchecked create a new pending order
router.patch('/orders/:id/dispatch', async (req, res) => {
  try {
    const { id } = req.params;
    const { dispatch_items, dispatched_by, remaining_items } = req.body;
    
    // 1. Get the order
    const { data: order, error: orderErr } = await supabase.from('demands')
      .select('*').eq('id', id).single();
    if (orderErr) throw orderErr;

    // 2. Mark order as fulfilled with dispatch items
    const { error: updateErr } = await supabase.from('demands').update({
      status: 'fulfilled',
      dispatch_items: dispatch_items || {},
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
        note: `Remaining from partial dispatch (${Object.keys(dispatch_items).length} items sent)`,
        submitted_by: order.submitted_by,
        submitted_at: order.submitted_at,
      }).select('id').single();
      if (insertErr) console.error('Failed to create remaining order:', insertErr.message);
      else remainingOrderId = newOrder?.id;
    }

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
    if (!await requireRole(req, res, 'owner', 'store_mgr')) return;
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
    if (!await requireRole(req, res, 'owner', 'store_mgr')) return;
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
    if (!await requireOwner(req, res)) return;
    const { date, from, to, outlet } = req.query;
    if (!date && !(from && to)) return res.status(400).json({ error: 'date, or from+to, query param required' });

    const data = await fetchAllDailySales({ date, from, to, outlet_code: (outlet && outlet !== 'all') ? outlet : undefined });

    // Aggregate by item
    const itemMap = {};
    const outletMap = {};
    let totalOrders = new Set();

    (data || []).forEach(row => {
      if (!itemMap[row.item_name]) {
        itemMap[row.item_name] = { item_name: row.item_name, category: row.category_name, qty: 0, revenue: 0 };
      }
      itemMap[row.item_name].qty += row.item_quantity;
      itemMap[row.item_name].revenue += row.item_total;

      if (!outletMap[row.outlet_code]) {
        outletMap[row.outlet_code] = { outlet_code: row.outlet_code, outlet_name: row.outlet, orders: new Set(), revenue: 0, dine_in: 0, delivery: 0, pickup: 0 };
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

    Object.values(orderRevenue).forEach(order => {
      if (outletMap[order.outlet_code]) {
        outletMap[order.outlet_code].revenue += order.total;
        if (order.order_type === 'Dine In') outletMap[order.outlet_code].dine_in++;
        else if (order.order_type?.includes('Delivery')) outletMap[order.outlet_code].delivery++;
        else if (order.order_type === 'Pick Up') outletMap[order.outlet_code].pickup++;
      }
    });

    Object.values(outletMap).forEach(o => { o.orders = o.orders.size; });

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
    if (!await requireOwner(req, res)) return;
    const { data, error } = await supabase.from('rate_card').select('*')
      .eq('active', true).order('category').order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/rate-card — Add/update rate
router.post('/rate-card', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { id, name, category, unit, price } = req.body;
    const { error } = await supabase.from('rate_card').upsert({
      id, name, category, unit, price: price || 0, updated_at: new Date().toISOString()
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/rate-card/:id — Update price
router.patch('/rate-card/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const updates = {};
    if (req.body.price !== undefined) updates.price = req.body.price;
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.unit !== undefined) updates.unit = req.body.unit;
    if (req.body.category !== undefined) updates.category = req.body.category;
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase.from('rate_card').update(updates).eq('id', req.params.id);
    if (error) throw error;
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

// ============================================================
// FIXED COSTS — Monthly recurring costs per outlet
// ============================================================

// ── GET /api/fixed-costs — All active fixed costs
router.get('/fixed-costs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id } = req.query;
    let query = supabase.from('fixed_costs').select('*').eq('active', true).order('outlet_id').order('cost_head');
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/fixed-costs — Add/update fixed cost
router.post('/fixed-costs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, cost_head, label, amount, category } = req.body;
    const { error } = await supabase.from('fixed_costs').upsert({
      outlet_id, cost_head, label, amount: amount || 0, category: category || 'fixed',
      updated_at: new Date().toISOString()
    }, { onConflict: 'outlet_id,cost_head' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/fixed-costs — Soft delete
router.delete('/fixed-costs', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { outlet_id, cost_head } = req.query;
    const { error } = await supabase.from('fixed_costs')
      .update({ active: false }).eq('outlet_id', outlet_id).eq('cost_head', cost_head);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// P&L COMPUTATION — Real-time from dispatched items + rate card
// ============================================================

// ── GET /api/pnl/live/:date — Compute P&L for a date from actual data
router.get('/pnl/live/:date', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { date } = req.params;
    const { outlet } = req.query; // optional outlet filter

    // 1. Get rate card
    const { data: rates } = await supabase.from('rate_card').select('id, name, category, unit, price').eq('active', true);
    const rateMap = {};
    (rates || []).forEach(r => { rateMap[r.id] = r; });

    // 2. Get dispatched orders for this date (fulfilled orders with dispatch_items)
    let orderQuery = supabase.from('demands').select('*').eq('date', date);
    const { data: allOrders } = await orderQuery;
    const orders = (allOrders || []).filter(o => o.status === 'fulfilled' || o.dispatch_items);

    // 2b. Get demand items for unit info
    const { data: demandItemsRaw } = await supabase.from('demand_items').select('id, unit').eq('active', true);
    const demandUnitMap = {};
    (demandItemsRaw || []).forEach(i => { demandUnitMap[i.id] = i.unit; });

    // 2c. Unit conversions (e.g., 1 Batch dosa_batter = 9 Kg)
    const { data: unitConversions } = await supabase.from('unit_conversions').select('*').eq('active', true);
    const convMap = {};
    (unitConversions || []).forEach(c => {
      convMap[c.item_id] = { fromUnit: c.unit_type, qty: Number(c.qty), baseUnit: c.base_unit };
    });

    // 3. Get daily purchases for this date
    const { data: purchases } = await supabase.from('purchases').select('*').eq('date', date);

    // 4. Get outlet sales for this date
    const { data: outletSales } = await supabase.from('daily_outlet_sales').select('*').eq('date', date);

    // 5. Get fixed costs
    const { data: fixedCosts } = await supabase.from('fixed_costs').select('*').eq('active', true);

    // 6. Get days in month for daily fixed cost
    const dateObj = new Date(date);
    const daysInMonth = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0).getDate();

    // 6b. Get BK recipes for food cost calculation
    const { data: bkRecipes } = await supabase.from('bk_recipes').select('*');
    const { data: bkIngredients } = await supabase.from('bk_recipe_ingredients').select('*');
    // Get inventory items for mapping raw_material_id → rate_card id
    const { data: invItemsList } = await supabase.from('inventory_items').select('id, name, demand_item_id');
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

    // Helper: get demand item display name
    const demandItemNameMap = {};
    (demandItemsRaw || []).forEach(i => { demandItemNameMap[i.id] = i.name || i.id; });
    const getDemandItemName = (id) => demandItemNameMap[id] || id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // 7. Compute per-outlet P&L
    const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
    const pnlResults = [];

    for (const oid of (outlet && outlet !== 'all' ? [outlet] : outletIds)) {
      // ── REVENUE ──
      const sales = (outletSales || []).find(s => s.outlet_id === oid);
      const totalSale = Number(sales?.total_sale || 0);
      const cancelledOrders = Number(sales?.cancelled_orders || 0);
      const complimentaryAmt = Number(sales?.complimentary_amount || 0);
      const swiggy = Number(sales?.swiggy_sale || 0);
      const zomato = Number(sales?.zomato_sale || 0);
      const otherDelivery = Number(sales?.other_delivery_sale || 0);
      const deliverySale = swiggy + zomato + otherDelivery;
      // Delivery platforms charge 40% commission — net delivery revenue is 60%
      const deliveryCommission = Math.round((swiggy + zomato) * 0.4);
      const netDeliverySale = Math.round((swiggy + zomato) * 0.6) + otherDelivery;
      const storeSale = Math.max(0, totalSale - deliverySale - cancelledOrders - complimentaryAmt);
      // Effective sale = store sale + 60% of (Swiggy+Zomato) + other delivery - cancelled - complimentary
      const effectiveSale = storeSale + netDeliverySale - cancelledOrders - complimentaryAmt;

      // ── VARIABLE COST (from dispatched items × rate card) ──
      // Unit-aware: if item is dispatched in Gm but rate is per Kg, convert
      const outletOrders = orders.filter(o => o.outlet_id === oid);
      const variableByCategory = {};
      let totalVariableCost = 0;
      const itemBreakdown = [];

      // Helper: get demand item unit
      const getDemandUnit = (itemId) => demandUnitMap[itemId] || null;

      // Unit conversion factor: demand unit → rate card unit
      // Rule: SI units (Gm↔Kg, ml↔Ltr) hardcoded. Everything else from unit_conversions table.
      // unit_conversions may only take the demand unit to an intermediate base unit
      // (e.g. Pkt → Gm) — chain an SI step on top when that base unit still
      // doesn't match the rate card's unit (e.g. Pkt → Gm → Kg).
      const getUnitConv = (demandUnit, rateUnit, itemId) => {
        const du = (demandUnit || '').toLowerCase();
        const ru = (rateUnit || '').toLowerCase();
        if (du === ru) return 1;
        // Check unit_conversions table first
        const conv = convMap[itemId];
        let factor = 1;
        let fromUnit = du;
        if (conv && du === conv.fromUnit.toLowerCase()) {
          factor = conv.qty;
          fromUnit = (conv.baseUnit || '').toLowerCase();
        }
        if (fromUnit === ru) return factor;
        // Standard SI conversions
        if ((fromUnit === 'gm' || fromUnit === 'g' || fromUnit === 'gram' || fromUnit === 'grams') && ru === 'kg') return factor * 0.001;
        if (fromUnit === 'kg' && (ru === 'gm' || ru === 'g' || ru === 'gram' || ru === 'grams')) return factor * 1000;
        if ((fromUnit === 'ml' || fromUnit === 'milliliter') && (ru === 'ltr' || ru === 'l' || ru === 'liter' || ru === 'litre')) return factor * 0.001;
        if ((fromUnit === 'ltr' || fromUnit === 'l') && (ru === 'ml')) return factor * 1000;
        return factor;
      };

      outletOrders.forEach(order => {
        const dispItems = order.dispatch_items || order.items || {};
        Object.entries(dispItems).forEach(([itemId, qty]) => {
          if (!qty || qty <= 0) return;

          // Check if this is a BK prepared item FIRST (before rate card)
          // BUT: if item has a direct rate card entry, use that instead of recipe
          // (e.g., roasted_chana has rate ₹120/Kg — use it, don't explode recipe)
          // Recipe pricing only for items that DON'T have a rate card entry (sambhar, dosa_batter)
          const rate = rateMap[itemId];
          const recipe = bkRecipeMap[itemId];

          if (rate) {
            // Direct rate card item — use rate card price
            const demandUnit = getDemandUnit(itemId);
            const factor = demandUnit ? getUnitConv(demandUnit, rate.unit, itemId) : 1;
            const convertedQty = Number(qty) * factor;
            const cost = convertedQty * Number(rate.price);
            totalVariableCost += cost;
            const cat = rate.category || 'Food';
            variableByCategory[cat] = (variableByCategory[cat] || 0) + cost;
            itemBreakdown.push({
              demand_id: order.id,
              raw_qty: Number(qty),
              raw_unit: demandUnit || rate.unit,
              item_id: itemId,
              name: rate.name,
              category: cat,
              qty: convertedQty,
              unit: rate.unit,
              rate: Number(rate.price),
              cost,
            });
          } else if (recipe && recipe.ingredients) {
            // BK prepared item with NO rate card — price using recipe cost per Kg
            const demandUnit = getDemandUnit(itemId);
            // Reuse the same chained conversion helper as the rate-card branch above
            // (unit_conversions base unit, then an SI step if that base unit isn't Kg)
            // instead of a separate ad-hoc lookup, so this stays consistent if the
            // conversion table ever adds a non-Kg base unit for a Batch/Tin item.
            const conv = convMap[itemId];
            let qtyKg;
            if (conv && demandUnit && demandUnit.toLowerCase() === conv.fromUnit.toLowerCase()) {
              qtyKg = Number(qty) * getUnitConv(demandUnit, 'Kg', itemId);
            } else if (demandUnit && demandUnit.toLowerCase() === 'batch' && recipe.yieldQty) {
              // Fallback to recipe yield if no conversion entry
              qtyKg = Number(qty) * recipe.yieldQty;
            } else {
              qtyKg = Number(qty);
            }
            const batches = recipe.yieldQty > 0 ? qtyKg / recipe.yieldQty : 0;
            let itemCost = 0;
            recipe.ingredients.forEach(ing => {
              const rmId = ing.inv_id || ing.rawId;
              const rateId = findRateId(rmId);
              const ingRate = rateId ? rateMap[rateId] : null;
              if (ingRate) {
                const ingQty = ing.qty * batches;
                const ingFactor = getUnitConv(ing.unit || 'kg', ingRate.unit);
                const ingCost = ingQty * ingFactor * Number(ingRate.price);
                itemCost += ingCost;
              }
            });
            if (itemCost > 0) {
              totalVariableCost += itemCost;
              const cat = 'Food';
              variableByCategory[cat] = (variableByCategory[cat] || 0) + itemCost;
              itemBreakdown.push({
                demand_id: order.id,
                raw_qty: Number(qty),
                raw_unit: demandUnit || 'Kg',
                item_id: itemId,
                name: getDemandItemName(itemId) || itemId,
                category: cat,
                qty: qtyKg,
                unit: 'Kg',
                rate: Math.round(itemCost / qtyKg * 100) / 100,
                cost: itemCost,
              });
            }
          }
        });
      });

      // ── BK SHARE (proportional base kitchen cost) ──
      // BK costs split across outlets based on their food demand proportion
      const bkOrders = orders.filter(o => o.outlet_id === oid);
      let bkCost = 0;
      // BK food items are dispatched via issuances — tracked separately in inventory_movements
      // For now, BK cost is included in variable cost if items have rates

      // ── DAILY PURCHASES ── split by line-item type (vendor_payment vs new_purchase).
      // Existing records predate the type field — treat those as new_purchase.
      const outletPurchases = (purchases || []).filter(p => p.outlet_id === oid);
      const dailyPurchaseTotal = outletPurchases.reduce((sum, p) => sum + Number(p.total_amount || 0), 0);
      let vendorPayments = 0, newPurchases = 0;
      outletPurchases.forEach(p => {
        (p.items || []).forEach(i => {
          const amt = Number(i.amount) || 0;
          if (i.type === 'vendor_payment') vendorPayments += amt; else newPurchases += amt;
        });
      });
      // Purchases recorded before per-item breakdown existed (empty items array) still count
      // toward the total but can't be split — fold them into new_purchase so nothing goes missing.
      const unsplit = dailyPurchaseTotal - (vendorPayments + newPurchases);
      if (unsplit > 0.5) newPurchases += unsplit;

      // ── FIXED COSTS (daily = monthly / days in month) ──
      const outletFixed = (fixedCosts || []).filter(f => f.outlet_id === oid);
      const monthlyFixed = outletFixed.reduce((sum, f) => sum + Number(f.amount || 0), 0);
      const dailyFixedCost = Math.round(monthlyFixed / daysInMonth);
      const fixedBreakdown = outletFixed.map(f => ({
        cost_head: f.cost_head, label: f.label,
        monthly: Number(f.amount), daily: Math.round(Number(f.amount) / daysInMonth)
      }));

      // ── BK FIXED COST SHARE ──
      const bkFixed = (fixedCosts || []).filter(f => f.outlet_id === 'bk');
      const bkMonthlyFixed = bkFixed.reduce((sum, f) => sum + Number(f.amount || 0), 0);
      const bkDailyFixed = Math.round(bkMonthlyFixed / daysInMonth);
      // Split BK fixed cost equally across 4 outlets
      const bkSharePerOutlet = Math.round(bkDailyFixed / outletIds.length);

      // ── TOTALS ──
      const totalExpense = totalVariableCost + dailyFixedCost + bkSharePerOutlet + dailyPurchaseTotal;
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
        // Fixed cost
        daily_fixed_cost: dailyFixedCost,
        bk_share: bkSharePerOutlet,
        fixed_breakdown: fixedBreakdown,
        monthly_fixed: monthlyFixed,
        // Purchases
        daily_purchases: dailyPurchaseTotal,
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

// Extracted so /api/audit/:date (recipe-based leakage audit) can reuse the exact same
// per-outlet consumption numbers P&L and COGS Compare already show, instead of a second,
// possibly-drifting computation. Internal function — no req/res, no auth check (callers
// that expose this over HTTP are responsible for their own requireOwner).
async function computeStockUsageForDate(date, outlet) {
  {
    const prevDate = new Date(date);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = prevDate.toISOString().split('T')[0];

    // 1. Rate card
    const { data: rates } = await supabase.from('rate_card').select('id, name, category, unit, price').eq('active', true);
    const rateMap = {};
    (rates || []).forEach(r => { rateMap[r.id] = r; });

    // 1b. BK Recipes — for pricing BK prep items via recipe cost
    const { data: bkRecipes } = await supabase.from('bk_recipes').select('*');
    const { data: bkIngredients } = await supabase.from('bk_recipe_ingredients').select('*');
    const { data: invItemsList } = await supabase.from('inventory_items').select('id, name, demand_item_id');
    const { data: demandItemsRaw } = await supabase.from('demand_items').select('id, name, unit').eq('active', true);

    // 1c. Unit conversions (e.g., 1 Batch dosa_batter = 9 Kg)
    const { data: unitConversions } = await supabase.from('unit_conversions').select('*').eq('active', true);
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

    // Build BK recipe map with computed cost per Kg
    const bkRecipeMap = {};
    (bkRecipes || []).forEach(r => {
      const ings = (bkIngredients || []).filter(i => i.recipe_id === r.id);
      const yieldQty = Number(r.yield_qty) || 1;
      let batchCost = 0;
      ings.forEach(ing => {
        const rmId = ing.raw_material_id || ing.raw_material;
        const rateId = resolveRateId(rmId);
        const ingRate = rateId ? rateMap[rateId] : null;
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
        }
      });
      const costPerKg = yieldQty > 0 ? batchCost / yieldQty : 0;
      bkRecipeMap[r.id] = { name: r.name || r.id, costPerKg, yieldQty };
    });

    // 2. Previous day closing stock (from closing_stocks table, NOT demands)
    const { data: prevClosing } = await supabase.from('closing_stocks')
      .select('outlet_id, items, items_units').eq('date', prevDateStr);

    // 3. Today closing stock
    const { data: todayClosing } = await supabase.from('closing_stocks')
      .select('outlet_id, items, items_units').eq('date', date);

    // 4. Today wastage
    const { data: todayWastage } = await supabase.from('demands')
      .select('outlet_id, items, items_units').eq('type', 'wastage').eq('date', date);

    // 5. Today dispatched
    const { data: todayOrders } = await supabase.from('demands')
      .select('outlet_id, items, items_units, dispatch_items, status').eq('date', date);
    const dispatched = (todayOrders || []).filter(o => o.status === 'fulfilled' || o.dispatch_items);

    // 6. Compute per outlet
    const outletIds = ['sec23', 'sec31', 'sec56', 'sec14', 'elan', 'gaursid'];
    const results = [];

    // Conversion factor from a specific recorded unit to the item's rate-card unit —
    // chains through unit_conversions then an SI step, same as everywhere else. `rawUnit`
    // is whatever unit that particular entry was recorded in (may differ entry-to-entry
    // now that managers can pick a unit per submission); falls back to the item's default
    // demand unit when the entry predates that feature or didn't override it.
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
      }
      if (resolvedUnit !== ru) {
        if ((resolvedUnit === 'gm' || resolvedUnit === 'g') && ru === 'kg') factor *= 0.001;
        else if (resolvedUnit === 'kg' && (ru === 'gm' || ru === 'g')) factor *= 1000;
        else if (resolvedUnit === 'ml' && (ru === 'ltr' || ru === 'l')) factor *= 0.001;
        else if ((resolvedUnit === 'ltr' || resolvedUnit === 'l') && ru === 'ml') factor *= 1000;
      }
      return factor;
    };

    for (const oid of (outlet && outlet !== 'all' ? [outlet] : outletIds)) {
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

      // All unique item IDs — normalize cs_ prefix to avoid duplicates
      // closing_stocks uses cs_butter, dispatched uses butter — both refer to same item
      const allIdsRaw = [
        ...Object.keys(prevItems), ...Object.keys(todayItems),
        ...Object.keys(wastageEntries), ...Object.keys(dispatchedEntries),
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

        if (rate) {
          unitPrice = Number(rate.price);
          itemName = rate.name;
          itemCategory = rate.category || 'Other';
          itemUnit = rate.unit || '';
        } else if (bkRecipe) {
          unitPrice = bkRecipe.costPerKg;
          itemName = bkRecipe.name;
          itemCategory = 'Food';
          itemUnit = 'Kg';
        } else {
          itemName = demandNameMap[itemId] || itemId.replace(/_/g, ' ');
          itemUnit = demandUnitMap[itemId] || '';
        }

        // Convert each of the four components using its OWN recorded unit (falls back to
        // the item's default demand unit when an entry didn't override it), then combine —
        // this is what lets different days/records legitimately use different units for the
        // same item without corrupting the consumed-material formula.
        const prevQty = rawPrev * convFactorFor(itemId, rawPrevUnit, itemUnit);
        const closingQty = rawClosing * convFactorFor(itemId, rawClosingUnit, itemUnit);
        const wastageQty = (wastageEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);
        const dispatchedQty = (dispatchedEntries[itemId] || []).reduce((s, e) => s + e.qty * convFactorFor(itemId, e.unit, itemUnit), 0);

        // Default demand unit's conversion — used only for display labeling (conv_qty /
        // conv_base_unit below), independent of which unit any specific entry actually used.
        const demandUnit = demandUnitMap[itemId] || itemUnit;
        const du = (demandUnit || '').toLowerCase();
        const ru = (itemUnit || '').toLowerCase();
        const conv = convMap[itemId];
        const defaultFactor = convFactorFor(itemId, demandUnit, itemUnit);

        const openingQty = Math.max(0, prevQty - wastageQty) + dispatchedQty;
        const usedQty = Math.max(0, openingQty - closingQty);
        const usedCost = usedQty * unitPrice;

        // If no conversion was actually needed (demand unit already matches the rate
        // unit), show the item's own unit rather than an unrelated conv-table base unit.
        const displayUnit = du === ru || defaultFactor === 1 ? itemUnit : (conv ? conv.baseUnit : itemUnit);

        if (openingQty > 0 || closingQty > 0 || usedQty > 0 || dispatchedQty > 0) {
          itemDetails.push({
            item_id: itemId, name: itemName, category: itemCategory,
            unit: displayUnit,
            demand_unit: demandUnit,
            prev_closing: Math.round(prevQty * 1000) / 1000, 
            wastage: Math.round(wastageQty * 1000) / 1000,
            dispatched: Math.round(dispatchedQty * 1000) / 1000, 
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
            rate: Math.round(unitPrice * 100) / 100,
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
        total_used_cost: Math.round(totalUsedCost),
        variable_cost_by_category: byCategory,
        items: itemDetails.sort((a, b) => b.used_cost - a.used_cost),
      });
    }

    // ALL summary — same Elan exclusion as /pnl/live, so the consolidated variable-cost
    // figure that overrides P&L's 'all' row stays consistent with it.
    if (!outlet || outlet === 'all') {
      const consolidated = results.filter(r => r.outlet_id !== 'elan');
      const summary = {
        outlet_id: 'all', date,
        has_prev_closing: true,
        has_today_closing: true,
        prev_closing_submitted: consolidated.every(r => r.prev_closing_submitted),
        today_closing_submitted: consolidated.every(r => r.today_closing_submitted),
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

    return { date, outlets: results };
  }
}

router.get('/stock-usage/:date', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const result = await computeStockUsageForDate(req.params.date, req.query.outlet);
    res.json(result);
  } catch (err) {
    console.error('Stock usage error:', err);
    res.status(500).json({ error: err.message });
  }
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
    if (!await requireRole(req, res, 'owner', 'store_mgr')) return;
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
    if (!await requireRole(req, res, 'owner', 'store_mgr')) return;
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
    if (!await requireRole(req, res, 'owner', 'store_mgr')) return;
    const name = req.params.name;
    const { data: collections, error: collErr } = await supabase.from('daily_outlet_sales')
      .select('outlet_id, date, cash_deposited, cash_deposited_at')
      .eq('cash_deposited_by', name).order('date', { ascending: false });
    if (collErr) throw collErr;
    const { data: handovers, error: hoErr } = await supabase.from('cash_handovers')
      .select('*').eq('from_name', name).order('date', { ascending: false });
    if (hoErr) throw hoErr;

    const total_collected = (collections || []).reduce((s, c) => s + (Number(c.cash_deposited) || 0), 0);
    const total_handed_over = (handovers || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);

    res.json({
      name, total_collected, total_handed_over, balance: total_collected - total_handed_over,
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
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
    if (!await requireOwner(req, res)) return;
    const { status, limit } = req.query;
    let query = supabase.from('purchase_orders').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (limit) query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/purchase-orders/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { data, error } = await supabase.from('purchase_orders')
      .select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/purchase-orders', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { items, notes, created_by } = req.body;
    const today = todayIST();
    const { data: existing } = await supabase.from('purchase_orders')
      .select('id').eq('date', today);
    const seq = (existing?.length || 0) + 1;
    const orderNumber = `PO-${today}-${String(seq).padStart(3, '0')}`;
    const totalItems = Object.keys(items || {}).length;
    const { data, error } = await supabase.from('purchase_orders').insert({
      order_number: orderNumber, date: today, status: 'pending',
      items: items || {}, total_items: totalItems, notes, created_by,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/purchase-orders/:id', async (req, res) => {
  try {
    const updates = {};
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.items !== undefined) updates.items = req.body.items;
    if (req.body.received_by !== undefined) {
      updates.received_by = req.body.received_by;
      updates.received_at = new Date().toISOString();
    }
    const { error } = await supabase.from('purchase_orders').update(updates).eq('id', req.params.id);
    if (error) throw error;
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

module.exports = router;
