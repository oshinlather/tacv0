const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { requireRole } = require("./authGuards");

// All inventory operations are BK/store operations — restricted to owner + store_mgr.
// Tiny helper to keep each route terse.
async function gate(req, res) {
  return await requireRole(req, res, "owner", "store_mgr");
}

// Get all inventory items with current stock + threshold status
router.get("/", async (req, res) => {
  if (!await gate(req, res)) return;
  const { category, below_threshold } = req.query;
  let query = supabase.from("inventory_items").select("*, inventory_stock(current_qty, last_updated)").order("category").order("name");
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Fetch latest purchase price for each item
  const { data: latestPrices } = await supabase.from("inventory_movements")
    .select("item_id, unit_price, total_price, quantity, created_at")
    .eq("type", "stock_in")
    .not("unit_price", "is", null)
    .order("created_at", { ascending: false });
  
  const priceMap = {};
  (latestPrices || []).forEach(m => {
    if (!priceMap[m.item_id]) {
      priceMap[m.item_id] = {
        unit_price: Number(m.unit_price) || 0,
        last_purchase_qty: Number(m.quantity) || 0,
        last_purchase_total: Number(m.total_price) || 0,
      };
    }
  });

  let items = (data || []).map((item) => ({
    ...item,
    current_qty: item.inventory_stock?.[0]?.current_qty || item.inventory_stock?.current_qty || 0,
    last_updated: item.inventory_stock?.[0]?.last_updated || item.inventory_stock?.last_updated || null,
    below_threshold: (item.inventory_stock?.[0]?.current_qty || item.inventory_stock?.current_qty || 0) <= item.threshold,
    last_unit_price: priceMap[item.id]?.unit_price || null,
    last_purchase_qty: priceMap[item.id]?.last_purchase_qty || null,
    last_purchase_total: priceMap[item.id]?.last_purchase_total || null,
  }));

  if (below_threshold === "true") items = items.filter((i) => i.below_threshold);
  res.json(items);
});

// Stock In (add stock) — BATCHED
router.post("/stock-in", async (req, res) => {
  if (!await gate(req, res)) return;
  const { items, reason, submitted_by } = req.body;
  try {
    const validItems = items.filter(i => i.item_id && i.quantity && i.quantity > 0);
    if (validItems.length === 0) return res.json({ success: true, count: 0 });

    // 1. Batch insert all movements at once (with price data)
    const movements = validItems.map(item => ({
      item_id: item.item_id, type: "stock_in", quantity: item.quantity,
      reason: reason || "purchase", submitted_by,
      total_price: item.total_price || null,
      unit_price: item.unit_price || null,
    }));
    await supabase.from("inventory_movements").insert(movements);

    // 2. Get all current stock in one query
    const itemIds = validItems.map(i => i.item_id);
    const { data: currentStocks } = await supabase.from("inventory_stock")
      .select("item_id, current_qty").in("item_id", itemIds);
    const stockMap = {};
    (currentStocks || []).forEach(s => { stockMap[s.item_id] = Number(s.current_qty) || 0; });

    // 3. Batch upsert all stock updates
    const upserts = validItems.map(item => ({
      item_id: item.item_id,
      current_qty: (stockMap[item.item_id] || 0) + Number(item.quantity),
      last_updated: new Date().toISOString(),
    }));
    await supabase.from("inventory_stock").upsert(upserts, { onConflict: "item_id" });

    res.json({ success: true, count: validItems.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock Out (remove stock) — BATCHED
router.post("/stock-out", async (req, res) => {
  if (!await gate(req, res)) return;
  const { items, reason, submitted_by } = req.body;
  try {
    const validItems = items.filter(i => i.item_id && i.quantity && i.quantity > 0);
    if (validItems.length === 0) return res.json({ success: true, count: 0 });

    // 1. Batch insert all movements at once
    const movements = validItems.map(item => ({
      item_id: item.item_id, type: "stock_out", quantity: -item.quantity,
      reason: reason || "issuance", submitted_by,
    }));
    await supabase.from("inventory_movements").insert(movements);

    // 2. Get all current stock in one query
    const itemIds = validItems.map(i => i.item_id);
    const { data: currentStocks } = await supabase.from("inventory_stock")
      .select("item_id, current_qty").in("item_id", itemIds);
    const stockMap = {};
    (currentStocks || []).forEach(s => { stockMap[s.item_id] = Number(s.current_qty) || 0; });

    // 3. Batch upsert all stock updates
    const upserts = validItems.map(item => ({
      item_id: item.item_id,
      current_qty: (stockMap[item.item_id] || 0) - Number(item.quantity),
      last_updated: new Date().toISOString(),
    }));
    await supabase.from("inventory_stock").upsert(upserts, { onConflict: "item_id" });

    res.json({ success: true, count: validItems.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/adjust", async (req, res) => {
  if (!await gate(req, res)) return;
  const { item_id, new_qty, reason } = req.body;
  const { data: current } = await supabase.from("inventory_stock").select("current_qty").eq("item_id", item_id).single();
  const oldQty = Number(current?.current_qty) || 0;
  const delta = Number(new_qty) - oldQty;

  await supabase.from("inventory_movements").insert({ item_id, type: "adjust", quantity: delta, reason: reason || "manual adjustment" });
  await supabase.from("inventory_stock").upsert({ item_id, current_qty: new_qty, last_updated: new Date().toISOString() }, { onConflict: "item_id" });
  res.json({ success: true, old_qty: oldQty, new_qty, delta });
});

router.patch("/threshold/:id", async (req, res) => {
  if (!await gate(req, res)) return;
  const { id } = req.params;
  const { threshold } = req.body;
  const { data, error } = await supabase.from("inventory_items").update({ threshold }).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/thresholds", async (req, res) => {
  if (!await gate(req, res)) return;
  const { items } = req.body;
  try {
    for (const { id, threshold } of items) {
      await supabase.from("inventory_items").update({ threshold }).eq("id", id);
    }
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/movements/:id", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data, error } = await supabase.from("inventory_movements").select("*").eq("item_id", req.params.id).order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/movements", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date } = req.query;
  let query = supabase.from("inventory_movements").select("*, inventory_items(name, unit)").order("created_at", { ascending: false }).limit(500);
  if (date) {
    const start = `${date}T00:00:00+05:30`;
    const end = `${date}T23:59:59+05:30`;
    query = query.gte("created_at", start).lte("created_at", end);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Summary — owner only (financial data across entire store)
router.get("/summary", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data, error } = await supabase.from("inventory_items").select("*, inventory_stock(current_qty)");
  if (error) return res.status(500).json({ error: error.message });
  const summary = { total_items: data.length, below_threshold: 0, out_of_stock: 0 };
  data.forEach((i) => {
    const qty = i.inventory_stock?.[0]?.current_qty || i.inventory_stock?.current_qty || 0;
    if (qty === 0) summary.out_of_stock++;
    else if (qty <= i.threshold) summary.below_threshold++;
  });
  res.json(summary);
});

module.exports = router;
