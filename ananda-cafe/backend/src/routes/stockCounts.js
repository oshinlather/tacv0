// stockCounts.js — Store Inventory Module Stage 4: blind closing count -> audit/
// variance -> owner rollup. Mounted at /api/store alongside store.js/vendorChallans.js.
//
// "Blind": these endpoints never return system_qty or variance while a count is
// status='in_progress' — those columns are simply NULL in the DB until POST
// .../submit computes them, so there's nothing to accidentally leak even on a raw GET.
// The variance view is a separate concern from counting itself, gated the same as the
// rest of this module (owner/store_mgr/avp/bk_manager) — not restricted further, since
// unlike the old Inventory Ledger (deliberately owner-only "per explicit request"),
// nothing in this stage's build prompt asked for that narrower restriction here.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { gate, rebuildStockBalances } = require("./store");

// ── Start / list / cancel a count ──
router.post("/counts", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { location_id, count_date } = req.body;
  if (!location_id || !["store", "bk"].includes(location_id)) return res.status(400).json({ error: "location_id must be 'store' or 'bk'" });
  const date = count_date || todayIST();

  // Reuse an existing in-progress count for the same location+date instead of forking a
  // second one — mirrors the dedup guard POST /demands already uses for the same reason
  // (staff re-opening the screen, or two people starting a count minutes apart).
  const { data: existing } = await supabase.from("stock_counts").select("*").eq("location_id", location_id).eq("count_date", date).eq("status", "in_progress").maybeSingle();
  if (existing) return res.json(existing);

  const { data, error } = await supabase.from("stock_counts").insert({ location_id, count_date: date, created_by: user.name, counted_by: user.name }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/counts", async (req, res) => {
  if (!await gate(req, res)) return;
  const { location, from, status } = req.query;
  let query = supabase.from("stock_counts").select("*").order("count_date", { ascending: false }).order("created_at", { ascending: false }).limit(100);
  if (location) query = query.eq("location_id", location);
  if (from) query = query.gte("count_date", from);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /counts/:id — detail + items. Blind is naturally enforced: system_qty_at_submit/
// variance_qty/variance_value are just NULL in the row until submit, so an in-progress
// count's response has nothing to hide behind extra logic.
router.get("/counts/:id", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: count, error } = await supabase.from("stock_counts").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!count) return res.status(404).json({ error: "Count not found" });
  const { data: items, error: itemsErr } = await supabase.from("stock_count_items").select("*, items(name, category, base_unit)").eq("count_id", req.params.id);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  res.json({ ...count, items: (items || []).map((i) => ({ ...i, item_name: i.items?.name, category: i.items?.category, base_unit: i.items?.base_unit, items: undefined })) });
});

router.post("/counts/:id/cancel", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: existing } = await supabase.from("stock_counts").select("status").eq("id", req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Count not found" });
  if (existing.status !== "in_progress") return res.status(400).json({ error: "Only an in-progress count can be cancelled" });
  const { data, error } = await supabase.from("stock_counts").update({ status: "cancelled" }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /counts/:id/items — save counted quantities (incremental, call as many times as
// needed while walking the shelves). Converts to base unit via item_units — same
// non-guessing rule as Stage 2/3: an unrecognized unit is rejected, not assumed 1:1.
router.patch("/counts/:id/items", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: count } = await supabase.from("stock_counts").select("status, location_id").eq("id", req.params.id).maybeSingle();
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status !== "in_progress") return res.status(400).json({ error: "This count is no longer open for entry" });

  const { items } = req.body; // { item_id: { qty, unit? } }
  if (!items || !Object.keys(items).length) return res.status(400).json({ error: "items is required" });

  const itemIds = Object.keys(items);
  const { data: itemRows, error: itemsErr } = await supabase.from("items").select("id, base_unit").in("id", itemIds);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  const { data: unitRows } = await supabase.from("item_units").select("item_id, unit, factor").in("item_id", itemIds);
  const itemMap = new Map((itemRows || []).map((i) => [i.id, i]));
  const factorMap = new Map((unitRows || []).map((u) => [`${u.item_id}::${u.unit}`, Number(u.factor)]));

  const rows = [];
  for (const [itemId, entry] of Object.entries(items)) {
    const item = itemMap.get(itemId);
    if (!item) return res.status(400).json({ error: `Unknown item: ${itemId}` });
    const unit = entry.unit || item.base_unit;
    const factor = unit === item.base_unit ? 1 : factorMap.get(`${itemId}::${unit}`);
    if (!factor) return res.status(400).json({ error: `No known conversion for ${itemId} in unit "${unit}"` });
    const qty = Number(entry.qty);
    if (!(qty >= 0)) return res.status(400).json({ error: `Invalid quantity for ${itemId}` });
    rows.push({ count_id: Number(req.params.id), item_id: itemId, counted_qty: qty * factor, qty_entered: qty, unit_entered: unit });
  }

  const { error } = await supabase.from("stock_count_items").upsert(rows, { onConflict: "count_id,item_id" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, saved: rows.length });
});

// POST /counts/:id/submit — the reconciling action. For every counted item: snapshot
// the current system balance, compute variance, write it into stock_count_items (this
// is the moment "blind" ends — variance now exists and is visible on the detail view),
// and write an ADJUSTMENT movement that takes the ledger to exactly the counted number.
router.post("/counts/:id/submit", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { data: count } = await supabase.from("stock_counts").select("*").eq("id", req.params.id).maybeSingle();
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status === "submitted") return res.json(count); // idempotent no-op
  if (count.status !== "in_progress") return res.status(400).json({ error: "This count can't be submitted" });

  const { data: countItems, error: ciErr } = await supabase.from("stock_count_items").select("*").eq("count_id", count.id);
  if (ciErr) return res.status(500).json({ error: ciErr.message });
  if (!countItems || !countItems.length) return res.status(400).json({ error: "Count nothing yet — no items were entered" });

  const itemIds = countItems.map((c) => c.item_id);
  const { data: balances } = await supabase.from("store_stock_balances").select("item_id, current_qty").eq("location_id", count.location_id).in("item_id", itemIds);
  const balanceMap = new Map((balances || []).map((b) => [b.item_id, Number(b.current_qty) || 0]));

  const { data: itemRows } = await supabase.from("items").select("id, rate_card_id").in("id", itemIds);
  const rateCardIds = (itemRows || []).map((i) => i.rate_card_id).filter(Boolean);
  const { data: rateRows } = rateCardIds.length ? await supabase.from("rate_card").select("id, price").in("id", rateCardIds) : { data: [] };
  const priceByRateCardId = new Map((rateRows || []).map((r) => [r.id, Number(r.price) || 0]));
  const rateCardIdByItem = new Map((itemRows || []).map((i) => [i.id, i.rate_card_id]));

  const updatedCountItems = [];
  const movements = [];
  for (const ci of countItems) {
    const systemQty = balanceMap.get(ci.item_id) || 0;
    const variance = Number(ci.counted_qty) - systemQty;
    const price = priceByRateCardId.get(rateCardIdByItem.get(ci.item_id)) || null;
    updatedCountItems.push({ id: ci.id, system_qty_at_submit: systemQty, variance_qty: variance, variance_value: price != null ? Number((variance * price).toFixed(2)) : null });
    if (Math.abs(variance) > 1e-9) {
      movements.push({ item_id: ci.item_id, location_id: count.location_id, movement_type: "ADJUSTMENT", qty_delta: variance, qty_entered: ci.qty_entered, unit_entered: ci.unit_entered, source_type: "count", source_id: String(count.id), idempotency_key: `count:${count.id}:${ci.item_id}`, created_by: user.name });
    }
  }

  for (const u of updatedCountItems) {
    const { error } = await supabase.from("stock_count_items").update({ system_qty_at_submit: u.system_qty_at_submit, variance_qty: u.variance_qty, variance_value: u.variance_value }).eq("id", u.id);
    if (error) return res.status(500).json({ error: error.message });
  }

  if (movements.length) {
    const { error: mvErr } = await supabase.from("stock_movements").upsert(movements, { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (mvErr) return res.status(500).json({ error: mvErr.message });
    for (const itemId of new Set(movements.map((m) => m.item_id))) {
      await rebuildStockBalances({ itemId, locationId: count.location_id });
    }
  }

  const { data: updated, error: updErr } = await supabase.from("stock_counts")
    .update({ status: "submitted", submitted_by: user.name, submitted_at: new Date().toISOString() })
    .eq("id", count.id).select().single();
  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json(updated);
});

// GET /variance-rollup — owner-facing summary across submitted counts in a date range.
// Per-item totals (net variance qty + value) plus the list of counts that contributed,
// sorted by |variance_value| descending so the biggest discrepancies surface first — no
// hardcoded "acceptable" tolerance (see migration header for why).
router.get("/variance-rollup", async (req, res) => {
  if (!await gate(req, res)) return;
  const { from, to, location } = req.query;
  let countsQuery = supabase.from("stock_counts").select("id, location_id, count_date").eq("status", "submitted");
  if (from) countsQuery = countsQuery.gte("count_date", from);
  if (to) countsQuery = countsQuery.lte("count_date", to);
  if (location) countsQuery = countsQuery.eq("location_id", location);
  const { data: counts, error: countsErr } = await countsQuery;
  if (countsErr) return res.status(500).json({ error: countsErr.message });
  if (!counts.length) return res.json({ counts: [], items: [] });

  const countIds = counts.map((c) => c.id);
  const countById = new Map(counts.map((c) => [c.id, c]));
  const { data: countItems, error: ciErr } = await supabase.from("stock_count_items").select("*, items(name, category, base_unit)").in("count_id", countIds).not("variance_qty", "is", null);
  if (ciErr) return res.status(500).json({ error: ciErr.message });

  const byItem = new Map(); // item_id -> { name, category, base_unit, variance_qty, variance_value, occurrences }
  (countItems || []).forEach((ci) => {
    const key = ci.item_id;
    const cur = byItem.get(key) || { item_id: key, item_name: ci.items?.name, category: ci.items?.category, base_unit: ci.items?.base_unit, variance_qty: 0, variance_value: 0, occurrences: 0 };
    cur.variance_qty += Number(ci.variance_qty) || 0;
    cur.variance_value += Number(ci.variance_value) || 0;
    cur.occurrences += 1;
    byItem.set(key, cur);
  });

  const items = Array.from(byItem.values()).sort((a, b) => Math.abs(b.variance_value) - Math.abs(a.variance_value));
  res.json({ counts: counts.map((c) => ({ ...c })), items });
});

module.exports = router;
