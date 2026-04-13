// ============================================================
// STEP 3: BACKEND API ROUTES
// Add these to your Express server (tacv0.onrender.com)
// File: server/routes/salesRoutes.js (or wherever your routes live)
// ============================================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const csv = require('csv-parser'); // npm install csv-parser
const { Readable } = require('stream');

const supabase = createClient(
  process.env.SUPABASE_URL,      // https://hikreqarwdrwxrnjxsna.supabase.co
  process.env.SUPABASE_KEY       // your service_role key
);

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
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rows = [];
    const stream = Readable.from(req.file.buffer.toString());

    await new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (row) => {
          // Extract date from first row's date field
          const saleDate = row.date ? row.date.split(' ')[0] : null;
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
// 3E. GET /api/pnl/:date — Daily P&L
// ────────────────────────────────────────────────────────────
router.get('/pnl/:date', async (req, res) => {
  try {
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

  // TODO: Get actual issued from your issuance table
  // const { data: issuances } = await supabase
  //   .from('issuances')
  //   .select('item_name, quantity')
  //   .eq('date', date);
  //
  // Match issuances to rmTotals to calculate variance

  const auditRows = Object.values(rmTotals).map(rm => ({
    audit_date: date,
    outlet_code: null,
    raw_material: rm.raw_material,
    unit: rm.unit,
    should_consume: Math.round(rm.should_consume * 10000) / 10000,
    actual_issued: null,  // Fill from issuance data
    variance: null,
    variance_pct: null,
  }));

  // Save to DB
  await supabase.from('rm_audit').delete().eq('audit_date', date);
  if (auditRows.length > 0) {
    await supabase.from('rm_audit').insert(auditRows);
  }

  return auditRows;
}

module.exports = router;
