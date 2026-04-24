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
const { requireAuth, requireOwner, ensureOutletAccess, invalidateUser } = require('./authGuards');
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
};

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
res.json(recipes);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ────────────────────────────────────────────────────────────
// 3D. GET /api/audit/:date — Raw Material Audit
// ────────────────────────────────────────────────────────────
router.get('/audit/:date', async (req, res) => {
try {
    if (!await requireOwner(req, res)) return;
const { date } = req.params;

// Get precomputed audit
const { data: audit, error } = await supabase
.from('rm_audit')
.select('*')
.eq('audit_date', date)
.order('should_consume', { ascending: false });

if (error) throw error;

if (audit && audit.length > 0) {
return res.json({ date, items: audit });
}

// If not computed yet, compute on the fly
const result = await computeRMAudit(date);
res.json({ date, items: result });
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
async function computeRMAudit(date) {
const { data: sales } = await supabase
.from('daily_sales')
.select('item_name, item_quantity')
.eq('sale_date', date);

const { data: recipes } = await supabase
.from('recipes')
.select('item_name, recipe_ingredients ( raw_material, qty_kg, unit )');

if (!sales || !recipes) return [];

const recipeMap = {};
recipes.forEach(r => { recipeMap[r.item_name] = r.recipe_ingredients; });

// Aggregate sales
const salesMap = {};
sales.forEach(s => {
salesMap[s.item_name] = (salesMap[s.item_name] || 0) + s.item_quantity;
});

// Calculate theoretical consumption
const rmTotals = {};
Object.entries(salesMap).forEach(([itemName, qty]) => {
const ingredients = recipeMap[itemName];
if (!ingredients) return;

ingredients.forEach(ing => {
if (!ing.qty_kg) return; // skip packaging (Piece items)
const key = ing.raw_material;
if (!rmTotals[key]) {
rmTotals[key] = { raw_material: key, unit: 'Kg', should_consume: 0 };
}
rmTotals[key].should_consume += ing.qty_kg * qty;
});
});

// Get actual issued from inventory_movements (stock_out for this date)
const { data: movements } = await supabase.from('inventory_movements')
  .select('item_id, quantity')
  .eq('type', 'stock_out')
  .gte('created_at', `${date}T00:00:00`)
  .lt('created_at', `${date}T23:59:59`);

// Also get inventory item names for matching
const { data: invItems } = await supabase.from('inventory_items').select('id, name, demand_item_id');

// Build actual issued map by item name (matching RM audit raw_material names)
const actualMap = {};
(movements || []).forEach(m => {
  const invItem = (invItems || []).find(i => i.id === m.item_id);
  if (invItem) {
    const name = invItem.name;
    actualMap[name] = (actualMap[name] || 0) + Math.abs(Number(m.quantity));
  }
});

const auditRows = Object.values(rmTotals).map(rm => {
  const actual = actualMap[rm.raw_material] || null;
  const variance = actual != null ? Math.round((actual - rm.should_consume) * 10000) / 10000 : null;
  const variancePct = actual != null && rm.should_consume > 0 ? Math.round((variance / rm.should_consume) * 1000) / 10 : null;
  return {
    audit_date: date,
    outlet_code: null,
    raw_material: rm.raw_material,
    unit: rm.unit,
    should_consume: Math.round(rm.should_consume * 10000) / 10000,
    actual_issued: actual != null ? Math.round(actual * 10000) / 10000 : null,
    variance: variance,
    variance_pct: variancePct,
  };
});

// Save to DB
await supabase.from('rm_audit').delete().eq('audit_date', date);
if (auditRows.length > 0) {
await supabase.from('rm_audit').insert(auditRows);
}

return auditRows;
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
audit_date: e.date || new Date().toISOString().split('T')[0],
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
    if (!await requireOwner(req, res)) return;
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

// ── GET /api/outlet-sales — Get sales for a date/outlet
router.get('/outlet-sales', async (req, res) => {
  try {
    const _user = await requireAuth(req, res); if (!_user) return;
    const _outlet = req.body?.outlet_id || req.query?.outlet_id || req.params?.outlet_id;
    if (!ensureOutletAccess(_user, _outlet, res)) return;
    const { outlet_id, date } = req.query;
    let query = supabase.from('daily_outlet_sales').select('*');
    if (outlet_id) query = query.eq('outlet_id', outlet_id);
    if (date) query = query.eq('date', date);
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
            cash_deposited, submitted_by, notes } = req.body;
    
    const { data, error } = await supabase.from('daily_outlet_sales').upsert({
      outlet_id, date, total_sale, swiggy_sale, zomato_sale, other_delivery_sale,
      cancelled_orders: cancelled_orders || 0,
      complimentary_amount: complimentary_amount || 0,
      complimentary_reason: complimentary_reason || null,
      zomato_district: zomato_district || 0,
      upi_collected, cash_collected, prev_day_cash, cash_expense, cash_expense_note,
      cash_deposited, submitted_by, notes, submitted_at: new Date().toISOString()
    }, { onConflict: 'outlet_id,date' });
    
    if (error) throw error;
    // Write to Google Sheet (non-blocking)
    if (sheetsHelper) sheetsHelper.writeToSheet(supabase, outlet_id, 'daily_sales', submitted_by, { date }, { total_sale, swiggy_sale, zomato_sale, other_delivery_sale, cancelled_orders, complimentary_amount, complimentary_reason, zomato_district, upi_collected, cash_collected, prev_day_cash, cash_expense, cash_expense_note, cash_deposited, notes }).catch(() => {});
    res.json({ ok: true });
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
    const { outlet_id, type, items, note, date, demand_slot, submitted_by, status } = req.body;
    if (!outlet_id || !type) return res.status(400).json({ error: "outlet_id and type are required" });
    
    const record = {
      outlet_id,
      type,
      items: items || {},
      note: note || null,
      date: date || new Date().toISOString().split('T')[0],
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
      date: date || new Date().toISOString().split('T')[0],
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
    if (sheetsHelper && outlet_id) sheetsHelper.writeToSheet(supabase, outlet_id, 'purchase', submitted_by, { date: date || new Date().toISOString().split('T')[0] }, { items: items || [], total: totalAmount, payment_mode }).catch(() => {});
    
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
      .eq('date', date || new Date().toISOString().split('T')[0])
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
    const d = date || new Date().toISOString().split('T')[0];

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

// ── PATCH /api/orders/:demand_id/item/:item_id — Owner edits dispatched qty for a single item
// Overwrites the qty in demands.dispatch_items (or items) and logs to qty_corrections.
router.patch('/orders/:demand_id/item/:item_id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { demand_id, item_id } = req.params;
    const { new_qty, reason } = req.body;
    if (new_qty === undefined || new_qty === null || isNaN(Number(new_qty))) {
      return res.status(400).json({ error: 'new_qty required and must be a number' });
    }
    if (Number(new_qty) < 0) {
      return res.status(400).json({ error: 'new_qty cannot be negative' });
    }

    // 1. Load the demand row
    const { data: order, error: loadErr } = await supabase.from('demands')
      .select('id, outlet_id, date, items, dispatch_items').eq('id', demand_id).single();
    if (loadErr || !order) return res.status(404).json({ error: 'Order not found' });

    // 2. Figure out which JSON column the item lives in (dispatch_items first, fallback to items)
    const useDispatch = order.dispatch_items && order.dispatch_items[item_id] !== undefined;
    const column = useDispatch ? 'dispatch_items' : 'items';
    const currentMap = { ...(order[column] || {}) };
    const oldVal = currentMap[item_id];
    if (oldVal === undefined) {
      return res.status(404).json({ error: `Item '${item_id}' not found in this order` });
    }
    // Old qty could be a number OR an object like { qty, unit, name } — handle both
    const oldQty = typeof oldVal === 'object' && oldVal !== null ? Number(oldVal.qty) : Number(oldVal);

    // 3. Write the new value preserving shape
    if (typeof oldVal === 'object' && oldVal !== null) {
      currentMap[item_id] = { ...oldVal, qty: Number(new_qty) };
    } else {
      currentMap[item_id] = Number(new_qty);
    }

    // 4. Update the demand row
    const { error: updateErr } = await supabase.from('demands')
      .update({ [column]: currentMap })
      .eq('id', demand_id);
    if (updateErr) throw updateErr;

    // 5. Log correction. req.user is set by requireOwner (fetched from app_users).
    // Fetch user name — requireOwner already populated req via the guard cache.
    const correctorName = req.headers['x-user-name'] ||
      (await supabase.from('app_users').select('name').eq('id', req.headers['x-user-id']).single()).data?.name ||
      'owner';

    const unit = (typeof oldVal === 'object' && oldVal !== null ? oldVal.unit : null) || null;

    await supabase.from('qty_corrections').insert({
      demand_id,
      outlet_id: order.outlet_id,
      date: order.date,
      item_id,
      old_qty: oldQty,
      new_qty: Number(new_qty),
      unit,
      reason: reason || null,
      corrected_by: correctorName,
    });

    res.json({ ok: true, old_qty: oldQty, new_qty: Number(new_qty) });
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
    const { date, outlet } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required' });

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
        date: date || new Date().toISOString().split('T')[0],
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
      date: date || new Date().toISOString().split('T')[0],
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
    
    // Known ID mappings for recipe ingredients → rate card
    const KNOWN_MAPPINGS = {
      'coriander_raw': 'coriander_leaves',
      'urad_daal': 'urad_dal',
      'sona_masoori_raw': 'sona_masoori_rice',
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
    const outletIds = ['sec23', 'sec31', 'sec56', 'elan'];
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
      const getUnitConv = (demandUnit, rateUnit) => {
        const du = (demandUnit || '').toLowerCase();
        const ru = (rateUnit || '').toLowerCase();
        if (du === ru) return 1;
        if ((du === 'gm' || du === 'g' || du === 'gram' || du === 'grams') && ru === 'kg') return 0.001;
        if (du === 'kg' && (ru === 'gm' || ru === 'g' || ru === 'gram' || ru === 'grams')) return 1000;
        if ((du === 'ml' || du === 'milliliter') && (ru === 'ltr' || ru === 'l' || ru === 'liter' || ru === 'litre')) return 0.001;
        if ((du === 'ltr' || du === 'l' || du === 'liter' || du === 'litre') && (du === 'ml' || du === 'milliliter')) return 1000;
        return 1;
      };

      outletOrders.forEach(order => {
        const dispItems = order.dispatch_items || order.items || {};
        Object.entries(dispItems).forEach(([itemId, qty]) => {
          if (!qty || qty <= 0) return;
          const rate = rateMap[itemId];
          if (rate) {
            // Direct rate card item (vegetables, packaging, gas, dairy, etc.)
            const demandUnit = getDemandUnit(itemId);
            const factor = demandUnit ? getUnitConv(demandUnit, rate.unit) : 1;
            const convertedQty = Number(qty) * factor;
            const cost = convertedQty * Number(rate.price);
            totalVariableCost += cost;
            const cat = rate.category || 'Other';
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
          } else {
            // BK prepared item (sambhar, dosa_batter, etc.) — no direct rate
            // Explode into raw materials via BK recipes and price them
            const recipe = bkRecipeMap[itemId];
            if (recipe && recipe.ingredients) {
              // qty is in Kg (or Batch converted to Kg)
              const demandUnit = getDemandUnit(itemId);
              let qtyKg = Number(qty);
              // If demand unit is Batch, convert to Kg using recipe yield
              if (demandUnit && demandUnit.toLowerCase() === 'batch' && recipe.yieldQty) {
                qtyKg = Number(qty) * recipe.yieldQty;
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
                const cat = 'BK Food';
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
          }
        });
      });

      // ── BK SHARE (proportional base kitchen cost) ──
      // BK costs split across outlets based on their food demand proportion
      const bkOrders = orders.filter(o => o.outlet_id === oid);
      let bkCost = 0;
      // BK food items are dispatched via issuances — tracked separately in inventory_movements
      // For now, BK cost is included in variable cost if items have rates

      // ── DAILY PURCHASES ──
      const outletPurchases = (purchases || []).filter(p => p.outlet_id === oid);
      const dailyPurchaseTotal = outletPurchases.reduce((sum, p) => sum + Number(p.total_amount || 0), 0);

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
        // Summary
        total_expense: Math.round(totalExpense),
        net_profit: Math.round(netProfit),
        margin: Math.round(margin * 10) / 10,
        days_in_month: daysInMonth,
      });
    }

    // Add ALL-outlets summary
    if (!outlet || outlet === 'all') {
      const summary = {
        outlet_id: 'all',
        date,
        total_sale: pnlResults.reduce((s, r) => s + r.total_sale, 0),
        delivery_sale: pnlResults.reduce((s, r) => s + r.delivery_sale, 0),
        store_sale: pnlResults.reduce((s, r) => s + r.store_sale, 0),
        cancelled_orders: pnlResults.reduce((s, r) => s + r.cancelled_orders, 0),
        complimentary: pnlResults.reduce((s, r) => s + r.complimentary, 0),
        effective_sale: pnlResults.reduce((s, r) => s + r.effective_sale, 0),
        variable_cost: pnlResults.reduce((s, r) => s + r.variable_cost, 0),
        daily_fixed_cost: pnlResults.reduce((s, r) => s + r.daily_fixed_cost, 0),
        bk_share: pnlResults.reduce((s, r) => s + r.bk_share, 0),
        daily_purchases: pnlResults.reduce((s, r) => s + r.daily_purchases, 0),
        total_expense: pnlResults.reduce((s, r) => s + r.total_expense, 0),
        net_profit: pnlResults.reduce((s, r) => s + r.net_profit, 0),
        days_in_month: pnlResults[0]?.days_in_month || 30,
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

router.get('/stock-usage/:date', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { date } = req.params;
    const { outlet } = req.query;

    const prevDate = new Date(date);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = prevDate.toISOString().split('T')[0];

    // 1. Rate card
    const { data: rates } = await supabase.from('rate_card').select('id, name, category, unit, price').eq('active', true);
    const rateMap = {};
    (rates || []).forEach(r => { rateMap[r.id] = r; });

    // 2. Previous day closing stock
    const { data: prevClosing } = await supabase.from('demands')
      .select('outlet_id, items').eq('type', 'closing').eq('date', prevDateStr);

    // 3. Today closing stock
    const { data: todayClosing } = await supabase.from('demands')
      .select('outlet_id, items').eq('type', 'closing').eq('date', date);

    // 4. Today wastage
    const { data: todayWastage } = await supabase.from('demands')
      .select('outlet_id, items').eq('type', 'wastage').eq('date', date);

    // 5. Today dispatched
    const { data: todayOrders } = await supabase.from('demands')
      .select('outlet_id, items, dispatch_items, status').eq('date', date);
    const dispatched = (todayOrders || []).filter(o => o.status === 'fulfilled' || o.dispatch_items);

    // 6. Compute per outlet
    const outletIds = ['sec23', 'sec31', 'sec56', 'elan'];
    const results = [];

    for (const oid of (outlet && outlet !== 'all' ? [outlet] : outletIds)) {
      const prevCS = (prevClosing || []).find(d => d.outlet_id === oid);
      const prevItems = prevCS?.items || {};
      const todayCS = (todayClosing || []).find(d => d.outlet_id === oid);
      const todayItems = todayCS?.items || {};

      // Aggregate wastage
      const wastageItems = {};
      (todayWastage || []).filter(d => d.outlet_id === oid).forEach(w => {
        Object.entries(w.items || {}).forEach(([id, qty]) => {
          wastageItems[id] = (wastageItems[id] || 0) + Number(qty);
        });
      });

      // Aggregate dispatched
      const dispatchedItems = {};
      dispatched.filter(o => o.outlet_id === oid).forEach(o => {
        const items = o.dispatch_items || o.items || {};
        Object.entries(items).forEach(([id, qty]) => {
          dispatchedItems[id] = (dispatchedItems[id] || 0) + Number(qty);
        });
      });

      // All unique item IDs
      const allIds = new Set([
        ...Object.keys(prevItems), ...Object.keys(todayItems),
        ...Object.keys(wastageItems), ...Object.keys(dispatchedItems),
      ]);

      const itemDetails = [];
      let totalUsedCost = 0;

      allIds.forEach(rawId => {
        const csId = rawId.startsWith('cs_') ? rawId : `cs_${rawId}`;
        const itemId = rawId.startsWith('cs_') ? rawId.replace('cs_', '') : rawId;

        const prevQty = Number(prevItems[csId] || prevItems[rawId] || 0);
        const wastageQty = Number(wastageItems[itemId] || 0);
        const dispatchedQty = Number(dispatchedItems[itemId] || 0);
        const closingQty = Number(todayItems[csId] || todayItems[rawId] || 0);

        const openingQty = Math.max(0, prevQty - wastageQty) + dispatchedQty;
        const usedQty = Math.max(0, openingQty - closingQty);

        const rate = rateMap[itemId];
        const unitPrice = rate ? Number(rate.price) : 0;
        const usedCost = usedQty * unitPrice;

        if (openingQty > 0 || closingQty > 0 || usedQty > 0 || dispatchedQty > 0) {
          itemDetails.push({
            item_id: itemId, name: rate?.name || itemId, category: rate?.category || 'Other',
            unit: rate?.unit || '', prev_closing: prevQty, wastage: wastageQty,
            dispatched: dispatchedQty, opening: openingQty, closing: closingQty,
            used: usedQty, rate: unitPrice, used_cost: Math.round(usedCost * 100) / 100,
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

    // ALL summary
    if (!outlet || outlet === 'all') {
      const summary = {
        outlet_id: 'all', date,
        has_prev_closing: true,
        has_today_closing: true,
        prev_closing_submitted: results.every(r => r.prev_closing_submitted),
        today_closing_submitted: results.every(r => r.today_closing_submitted),
        total_used_cost: results.reduce((s, r) => s + r.total_used_cost, 0),
        variable_cost_by_category: {},
        items: [],
      };
      results.forEach(r => {
        Object.entries(r.variable_cost_by_category).forEach(([cat, cost]) => {
          summary.variable_cost_by_category[cat] = (summary.variable_cost_by_category[cat] || 0) + cost;
        });
      });
      results.unshift(summary);
    }

    res.json({ date, outlets: results });
  } catch (err) {
    console.error('Stock usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// OUTLET RECIPE MANAGEMENT — Full CRUD for menu item recipes
// ============================================================

// ── GET /api/outlet-recipes — All recipes with ingredients and fill status
router.get('/outlet-recipes', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { data: recipes, error } = await supabase.from('recipes')
      .select(`id, item_name, item_type, category, status,
        recipe_ingredients ( id, raw_material, qty, unit, qty_kg )`)
      .eq('status', 'Active')
      .order('category')
      .order('item_name');
    if (error) throw error;
    res.json(recipes || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/outlet-recipes — Add a new menu item (no ingredients yet)
router.post('/outlet-recipes', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { item_name, category, item_type } = req.body;
    if (!item_name) return res.status(400).json({ error: 'item_name required' });
    const { data, error } = await supabase.from('recipes').insert({
      item_name, category: category || 'Other', item_type: item_type || 'veg', status: 'Active'
    }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/outlet-recipes/:id — Update menu item name/category
router.patch('/outlet-recipes/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const updates = {};
    if (req.body.item_name !== undefined) updates.item_name = req.body.item_name;
    if (req.body.category !== undefined) updates.category = req.body.category;
    if (req.body.item_type !== undefined) updates.item_type = req.body.item_type;
    if (req.body.status !== undefined) updates.status = req.body.status;
    const { error } = await supabase.from('recipes').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/outlet-recipes/:id — Soft delete (set status = Inactive)
router.delete('/outlet-recipes/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('recipes')
      .update({ status: 'Inactive' }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/outlet-recipes/:id/ingredients — Save all ingredients for a recipe (replace)
router.post('/outlet-recipes/:id/ingredients', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { id } = req.params;
    const { ingredients } = req.body; // [{ raw_material, qty, unit, qty_kg }]
    if (!ingredients) return res.status(400).json({ error: 'ingredients array required' });

    // Delete existing ingredients
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', id);

    // Insert new
    if (ingredients.length > 0) {
      const rows = ingredients.map(i => ({
        recipe_id: id,
        raw_material: i.raw_material,
        qty: Number(i.qty) || 0,
        unit: i.unit || 'gm',
        qty_kg: Number(i.qty_kg) || (Number(i.qty) / 1000) || 0,
      }));
      const { error } = await supabase.from('recipe_ingredients').insert(rows);
      if (error) throw error;
    }
    res.json({ ok: true, count: ingredients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/outlet-recipes/:recipeId/ingredients/:ingredientId — Remove single ingredient
router.delete('/outlet-recipes/:recipeId/ingredients/:ingredientId', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('recipe_ingredients')
      .delete().eq('id', req.params.ingredientId);
    if (error) throw error;
    res.json({ ok: true });
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
    if (!await requireOwner(req, res)) return;
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

router.post('/cash-handovers', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { date, from_role, from_name, to_role, to_name, outlet_id, amount, note } = req.body;
    if (!date || !amount) return res.status(400).json({ error: "Date and amount required" });
    const { data, error } = await supabase.from('cash_handovers')
      .upsert({ date, from_role, from_name, to_role, to_name, outlet_id: outlet_id || null, amount: Number(amount), note },
        { onConflict: 'date,outlet_id,from_role' })
      .select('*').single();
    if (error) throw error;
    res.json(data);
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
    const today = new Date().toISOString().split('T')[0];
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

module.exports = router;
