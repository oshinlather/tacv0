const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");

// Get all inventory items with current stock + threshold status
router.get("/", async (req, res) => {
  const { category, below_threshold } = req.query;
  let query = supabase.from("inventory_items").select("*, inventory_stock(current_qty, last_updated)").order("category").order("name");
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  let items = (data || []).map((item) => ({
    ...item,
    current_qty: item.inventory_stock?.[0]?.current_qty || item.inventory_stock?.current_qty || 0,
    last_updated: item.inventory_stock?.[0]?.last_updated || item.inventory_stock?.last_updated || null,
    below_threshold: (item.inventory_stock?.[0]?.current_qty || item.inventory_stock?.current_qty || 0) <= item.threshold,
  }));

  if (below_threshold === "true") items = items.filter((i) => i.below_threshold);
  res.json(items);
});

// Stock In (add stock)
router.post("/stock-in", async (req, res) => {
  const { items, reason, submitted_by } = req.body;
  // items = [{ item_id, quantity }, ...]
  try {
    for (const item of items) {
      if (!item.item_id || !item.quantity || item.quantity <= 0) continue;

      // Log movement
      await supabase.from("inventory_movements").insert({
        item_id: item.item_id, type: "stock_in", quantity: item.quantity,
        reason: reason || "purchase", submitted_by,
      });

      // Update current stock
      const { data: current } = await supabase.from("inventory_stock").select("current_qty").eq("item_id", item.item_id).single();
      const newQty = (Number(current?.current_qty) || 0) + Number(item.quantity);
      await supabase.from("inventory_stock").upsert({ item_id: item.item_id, current_qty: newQty, last_updated: new Date().toISOString() }, { onConflict: "item_id" });
    }
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock Out (remove stock)
router.post("/stock-out", async (req, res) => {
  const { items, reason, submitted_by } = req.body;
  try {
    for (const item of items) {
      if (!item.item_id || !item.quantity || item.quantity <= 0) continue;

      await supabase.from("inventory_movements").insert({
        item_id: item.item_id, type: "stock_out", quantity: -item.quantity,
        reason: reason || "issuance", submitted_by,
      });

      const { data: current } = await supabase.from("inventory_stock").select("current_qty").eq("item_id", item.item_id).single();
      const newQty = Math.max(0, (Number(current?.current_qty) || 0) - Number(item.quantity));
      await supabase.from("inventory_stock").upsert({ item_id: item.item_id, current_qty: newQty, last_updated: new Date().toISOString() }, { onConflict: "item_id" });
    }
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Adjustment (set exact quantity)
router.post("/adjust", async (req, res) => {
  const { item_id, new_qty, reason, submitted_by } = req.body;
  try {
    const { data: current } = await supabase.from("inventory_stock").select("current_qty").eq("item_id", item_id).single();
    const diff = Number(new_qty) - (Number(current?.current_qty) || 0);

    await supabase.from("inventory_movements").insert({
      item_id, type: "adjustment", quantity: diff,
      reason: reason || "manual_adjustment", submitted_by,
    });

    await supabase.from("inventory_stock").upsert({ item_id, current_qty: Number(new_qty), last_updated: new Date().toISOString() }, { onConflict: "item_id" });
    res.json({ success: true, item_id, new_qty });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update threshold for an item
router.patch("/threshold/:id", async (req, res) => {
  const { id } = req.params;
  const { threshold } = req.body;
  const { data, error } = await supabase.from("inventory_items").update({ threshold: Number(threshold) }).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Bulk update thresholds
router.post("/thresholds", async (req, res) => {
  const { items } = req.body; // [{ id, threshold }, ...]
  try {
    for (const item of items) {
      await supabase.from("inventory_items").update({ threshold: Number(item.threshold) }).eq("id", item.id);
    }
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get movement history for an item
router.get("/movements/:id", async (req, res) => {
  const { id } = req.params;
  const { limit = 50 } = req.query;
  const { data, error } = await supabase.from("inventory_movements").select("*").eq("item_id", id).order("created_at", { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get all movements for today
router.get("/movements", async (req, res) => {
  const { date, limit = 100 } = req.query;
  const targetDate = date || todayIST();
  const { data, error } = await supabase.from("inventory_movements").select("*").gte("created_at", targetDate + "T00:00:00").lte("created_at", targetDate + "T23:59:59").order("created_at", { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Summary - alerts count, total items, etc.
router.get("/summary", async (req, res) => {
  const { data: items } = await supabase.from("inventory_items").select("*, inventory_stock(current_qty)");
  const total = items?.length || 0;
  const belowThreshold = (items || []).filter((i) => {
    const qty = i.inventory_stock?.[0]?.current_qty || i.inventory_stock?.current_qty || 0;
    return qty <= i.threshold;
  }).length;
  const outOfStock = (items || []).filter((i) => {
    const qty = i.inventory_stock?.[0]?.current_qty || i.inventory_stock?.current_qty || 0;
    return qty === 0;
  }).length;
  res.json({ total, below_threshold: belowThreshold, out_of_stock: outOfStock });
});

module.exports = router;
