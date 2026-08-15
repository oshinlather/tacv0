// store.js — New Store Inventory Module (item master + stock_movements ledger).
// Read-only stock view + item-units admin, backed by the append-only ledger created in
// 2026_08_15_store_inventory_stage1.sql. Stage 2's write flow (vendor challans ->
// receive -> stock-in) lives in vendorChallans.js, mounted at the same /api/store
// prefix — split out because it's a genuinely separate concern, not because this file
// got too big. Stage 3 (dispatch) will add another sibling file the same way.
//
// This is a NEW, separate system from the existing /api/inventory routes
// (inventory_items/inventory_stock/inventory_movements) — that module is untouched and
// keeps working exactly as before. Nothing here reads from or writes to it.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireRole } = require("./authGuards");

// Same role gate as the existing /api/inventory routes (owner + store_mgr run the
// store; avp/bk_manager run BK day-to-day).
async function gate(req, res) {
  return await requireRole(req, res, "owner", "store_mgr", "avp", "bk_manager");
}

// Recomputes store_stock_balances for one or all (item_id, location_id) pairs by
// summing stock_movements.qty_delta from scratch. This is the "provably consistent"
// rebuild path — the cache can always be thrown away and regenerated from the ledger,
// which is the source of truth. Pass { itemId, locationId } to limit the rebuild to one
// row (used after a single new movement); call with no args to rebuild everything (used
// for an admin/repair pass).
async function rebuildStockBalances({ itemId, locationId } = {}) {
  let query = supabase.from("stock_movements").select("item_id, location_id, qty_delta, id, created_at");
  if (itemId) query = query.eq("item_id", itemId);
  if (locationId) query = query.eq("location_id", locationId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const totals = new Map(); // "item_id::location_id" -> { qty, lastMovementId, lastCreatedAt }
  (data || []).forEach((m) => {
    const key = `${m.item_id}::${m.location_id}`;
    const cur = totals.get(key) || { qty: 0, lastMovementId: null, lastCreatedAt: null };
    cur.qty += Number(m.qty_delta) || 0;
    if (!cur.lastCreatedAt || new Date(m.created_at) >= new Date(cur.lastCreatedAt)) {
      cur.lastMovementId = m.id;
      cur.lastCreatedAt = m.created_at;
    }
    totals.set(key, cur);
  });

  const rows = Array.from(totals.entries()).map(([key, v]) => {
    const [item_id, location_id] = key.split("::");
    return { item_id, location_id, current_qty: v.qty, last_movement_id: v.lastMovementId, updated_at: new Date().toISOString() };
  });
  if (!rows.length) return 0;
  const { error: upsertError } = await supabase.from("store_stock_balances").upsert(rows, { onConflict: "item_id,location_id" });
  if (upsertError) throw new Error(upsertError.message);
  return rows.length;
}

// GET /api/store/stock — read-only current balances, joined with item master.
// Query params: location ('store' | 'bk'), category, below_threshold not supported yet
// (items table has no threshold column — that's an inventory_items-only concept today).
router.get("/stock", async (req, res) => {
  if (!await gate(req, res)) return;
  const { location, category } = req.query;

  let itemQuery = supabase.from("items").select("id, name, category, base_unit, active, demand_item_id, raw_material_id, rate_card_id").eq("active", true).order("category").order("name");
  if (category) itemQuery = itemQuery.eq("category", category);
  const { data: items, error: itemsError } = await itemQuery;
  if (itemsError) return res.status(500).json({ error: itemsError.message });

  let balQuery = supabase.from("store_stock_balances").select("item_id, location_id, current_qty, updated_at");
  if (location) balQuery = balQuery.eq("location_id", location);
  const { data: balances, error: balError } = await balQuery;
  if (balError) return res.status(500).json({ error: balError.message });

  const balMap = new Map(); // item_id -> { store, bk } or single location's qty
  (balances || []).forEach((b) => {
    if (!balMap.has(b.item_id)) balMap.set(b.item_id, {});
    balMap.get(b.item_id)[b.location_id] = { current_qty: Number(b.current_qty) || 0, updated_at: b.updated_at };
  });

  const result = items.map((it) => {
    const byLoc = balMap.get(it.id) || {};
    if (location) {
      const loc = byLoc[location] || { current_qty: 0, updated_at: null };
      return { ...it, current_qty: loc.current_qty, updated_at: loc.updated_at };
    }
    const store = byLoc.store || { current_qty: 0, updated_at: null };
    const bk = byLoc.bk || { current_qty: 0, updated_at: null };
    return { ...it, store_qty: store.current_qty, bk_qty: bk.current_qty, current_qty: store.current_qty + bk.current_qty, updated_at: store.updated_at || bk.updated_at };
  });

  res.json(result);
});

// GET /api/store/stock/:itemId/movements — ledger history for one item, for the audit
// trail / "why is this number what it is" drill-down. Newest first.
router.get("/stock/:itemId/movements", async (req, res) => {
  if (!await gate(req, res)) return;
  const { itemId } = req.params;
  const { location } = req.query;
  let query = supabase.from("stock_movements").select("*").eq("item_id", itemId).order("created_at", { ascending: false }).limit(200);
  if (location) query = query.eq("location_id", location);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/store/items — plain item-master list (for pickers in the challan/receiving
// UI). Includes item_units so the frontend can offer only units that already have a
// known conversion factor for that item.
router.get("/items", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: items, error } = await supabase.from("items").select("id, name, category, base_unit, active").eq("active", true).order("category").order("name");
  if (error) return res.status(500).json({ error: error.message });
  const { data: units, error: unitsError } = await supabase.from("item_units").select("item_id, unit, factor, is_purchase_unit, is_issue_unit");
  if (unitsError) return res.status(500).json({ error: unitsError.message });
  const unitsByItem = new Map();
  (units || []).forEach((u) => { if (!unitsByItem.has(u.item_id)) unitsByItem.set(u.item_id, []); unitsByItem.get(u.item_id).push(u); });
  res.json(items.map((it) => ({ ...it, units: unitsByItem.get(it.id) || [{ unit: it.base_unit, factor: 1 }] })));
});

// POST /api/store/item-units — add or update a purchase-unit conversion factor for an
// item (e.g. "1 Tin = 15 Kg"). Stage 1 deliberately left this empty rather than guess —
// this is how an owner/store_mgr fills it in themselves, with a real number they know,
// the first time they need to receive something in a unit other than its base unit.
router.post("/item-units", async (req, res) => {
  if (!await gate(req, res)) return;
  const { item_id, unit, factor, is_purchase_unit = true, is_issue_unit = true } = req.body;
  if (!item_id || !unit || !(Number(factor) > 0)) return res.status(400).json({ error: "item_id, unit, and a positive factor are required" });
  const { data, error } = await supabase.from("item_units")
    .upsert({ item_id, unit, factor: Number(factor), is_purchase_unit, is_issue_unit }, { onConflict: "item_id,unit" })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
module.exports.rebuildStockBalances = rebuildStockBalances;
module.exports.gate = gate;
