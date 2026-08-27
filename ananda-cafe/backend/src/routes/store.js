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
    // Rounded to 6dp — plain JS float addition/subtraction across many movements drifts
    // (0.1 + 0.2 style noise), and left unrounded it was visibly leaking into the UI as
    // e.g. "0.1000000000000863" (found by clicking through the real Order screen, not
    // guessed) — 6dp is far finer than any real Kg/Ltr/Pcs quantity needs, so nothing
    // real gets truncated, only the float noise beyond it.
    const qty = Math.round(v.qty * 1e6) / 1e6;
    return { item_id, location_id, current_qty: qty, last_movement_id: v.lastMovementId, updated_at: new Date().toISOString() };
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
  const { location, category, below_threshold } = req.query;

  // reorder_threshold: Stage 6 — carried over from the old Inventory screen's
  // per-item threshold (see 2026_08_27_store_reorder_threshold.sql) so the low-stock
  // alert this screen's predecessor had isn't lost on cutover. NULL means "no threshold
  // set" (never below it), same semantics as item_units having no row for an unentered
  // conversion — absence isn't guessed as zero.
  let itemQuery = supabase.from("items").select("id, name, category, base_unit, active, demand_item_id, raw_material_id, rate_card_id, reorder_threshold").eq("active", true).order("category").order("name");
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

  let result = items.map((it) => {
    const byLoc = balMap.get(it.id) || {};
    const threshold = it.reorder_threshold != null ? Number(it.reorder_threshold) : null;
    if (location) {
      const loc = byLoc[location] || { current_qty: 0, updated_at: null };
      return { ...it, current_qty: loc.current_qty, updated_at: loc.updated_at, below_threshold: threshold != null && loc.current_qty <= threshold };
    }
    const store = byLoc.store || { current_qty: 0, updated_at: null };
    const bk = byLoc.bk || { current_qty: 0, updated_at: null };
    const total = store.current_qty + bk.current_qty;
    return { ...it, store_qty: store.current_qty, bk_qty: bk.current_qty, current_qty: total, updated_at: store.updated_at || bk.updated_at, below_threshold: threshold != null && total <= threshold };
  });

  if (below_threshold === "true") result = result.filter((r) => r.below_threshold);
  res.json(result);
});

// POST /api/store/thresholds — batch set/update reorder thresholds. Same {id, threshold}
// shape the old /api/inventory/thresholds used, so nothing new to learn on the frontend
// side of this specific piece.
router.post("/thresholds", async (req, res) => {
  if (!await gate(req, res)) return;
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items is required" });
  try {
    for (const { id, threshold } of items) {
      if (!id) continue;
      await supabase.from("items").update({ reorder_threshold: threshold === "" || threshold == null ? null : Number(threshold) }).eq("id", id);
    }
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// GET /api/store/rm-order-suggest — Stage 5 migration: same "10-day usage" reorder
// hint the old Order Challan screen showed, ported to read from the new ledger instead
// of the old inventory_movements table. Sums every NEGATIVE movement at 'store' (not
// filtered to one movement_type) — Store's only outbound leg today is a TRANSFER to BK
// (dispatch straight from Store to an outlet isn't a real flow BK/outlet demand uses),
// so hardcoding 'DISPATCH' here would silently return zero for everything. Any future
// movement type that reduces Store's balance (a direct dispatch, an adjustment) is
// picked up the same way without needing another change here.
router.get("/rm-order-suggest", async (req, res) => {
  if (!await gate(req, res)) return;
  const tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
  const { data: movements, error } = await supabase.from("stock_movements")
    .select("item_id, qty_delta")
    .eq("location_id", "store")
    .lt("qty_delta", 0)
    .gte("created_at", tenDaysAgo.toISOString());
  if (error) return res.status(500).json({ error: error.message });
  const usage = {};
  (movements || []).forEach((m) => { usage[m.item_id] = (usage[m.item_id] || 0) + Math.abs(Number(m.qty_delta) || 0); });
  res.json(usage);
});

// POST /api/store/adjust — Stage 5, Step 3: the old manual "Stock Out" screen's one
// real remaining use case once Dispatch (Stage 3) auto-covers everything bound for an
// outlet and Closing Count (Stage 4) covers periodic reconciliation — an ad-hoc
// write-off (breakage, spoilage, expiry) that isn't tied to either of those. A reason
// is required (unlike a closing count's variance, this ISN'T a blind physical
// recount — it's a direct, deliberate correction, so it's logged as such).
router.post("/adjust", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { item_id, location_id, qty, reason } = req.body;
  if (!item_id) return res.status(400).json({ error: "item_id is required" });
  if (!location_id || !["store", "bk"].includes(location_id)) return res.status(400).json({ error: "location_id must be 'store' or 'bk'" });
  const qtyDelta = Number(qty);
  if (!qtyDelta || isNaN(qtyDelta)) return res.status(400).json({ error: "qty must be a non-zero number (negative for a write-off, positive for a found-stock correction)" });
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required for a manual adjustment" });

  const { data: movement, error } = await supabase.from("stock_movements").insert({
    item_id, location_id, movement_type: "ADJUSTMENT", qty_delta: qtyDelta,
    source_type: "manual_adjustment", reason: reason.trim(), created_by: user.name,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await rebuildStockBalances({ itemId: item_id, locationId: location_id });
  res.json(movement);
});

// POST /api/store/adjust-batch — Stage 6: the batched sibling of /adjust above, for the
// same "Smart Issue" use case the old Stock Out screen covered that a single-item call
// is too slow for — issuing/writing off several items in one go under real time
// pressure (the old screen's own comment: "runs under real morning time pressure").
// Same semantics as /adjust (signed qty per item, one shared reason, no floor check —
// an item going negative is surfaced back rather than blocked, so a real count problem
// gets caught same-day instead of silently accumulating), just batched.
router.post("/adjust-batch", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { location_id, reason, items } = req.body;
  if (!location_id || !["store", "bk"].includes(location_id)) return res.status(400).json({ error: "location_id must be 'store' or 'bk'" });
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required for a manual adjustment" });
  const validItems = (items || []).filter((i) => i.item_id && Number(i.qty) && !isNaN(Number(i.qty)));
  if (!validItems.length) return res.status(400).json({ error: "At least one item with a non-zero qty is required" });

  const rows = validItems.map((i) => ({
    item_id: i.item_id, location_id, movement_type: "ADJUSTMENT", qty_delta: Number(i.qty),
    source_type: "manual_adjustment", reason: reason.trim(), created_by: user.name,
  }));
  const { data: movements, error } = await supabase.from("stock_movements").insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });

  const uniqueItemIds = [...new Set(validItems.map((i) => i.item_id))];
  for (const itemId of uniqueItemIds) await rebuildStockBalances({ itemId, locationId: location_id });

  // Surface anything that went negative — same courtesy the old batched Stock Out gave,
  // so a physical-count problem gets caught same-day rather than drifting silently.
  const { data: balances } = await supabase.from("store_stock_balances").select("item_id, current_qty").eq("location_id", location_id).in("item_id", uniqueItemIds);
  const went_negative = (balances || []).filter((b) => Number(b.current_qty) < 0).map((b) => ({ item_id: b.item_id, current_qty: Number(b.current_qty) }));

  res.json({ success: true, count: movements.length, went_negative });
});

module.exports = router;
module.exports.rebuildStockBalances = rebuildStockBalances;
module.exports.gate = gate;
