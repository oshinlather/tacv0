const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { requireRole, requireOwner } = require("./authGuards");
const { istDate, bucketMovementsByItemAndDay, walkBackwardBalances } = require("../inventoryLedger");

// All inventory operations are BK/store operations — restricted to owner + store_mgr
// (+ avp, bk_manager — both run BK day-to-day and need the same stock in/out/adjust/
// count screens store_mgr already has). Tiny helper to keep each route terse.
async function gate(req, res) {
  return await requireRole(req, res, "owner", "store_mgr", "avp", "bk_manager");
}

const shiftDay = (dateStr, n) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const prevDay = (dateStr) => shiftDay(dateStr, -1);
const nextDay = (dateStr) => shiftDay(dateStr, 1);

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

// Stock In (add stock) — BATCHED. Optional po_id: when a vendor Purchase Order is being
// received, "receiving" IS this call — there's no separate status-flip action. Quantities
// here are whatever actually arrived (edited from the PO's ordered qty if it differs), and
// on success the PO is flipped to 'received' with those actual quantities recorded on it.
router.post("/stock-in", async (req, res) => {
  if (!await gate(req, res)) return;
  const { items, reason, submitted_by, po_id } = req.body;
  try {
    const validItems = (items || []).filter(i => i.item_id && i.quantity && i.quantity > 0);
    if (validItems.length === 0) return res.json({ success: true, count: 0 });

    // po_id is stamped onto the movement rows for traceability — pass it through
    // rather than reusing creditStockIn's plain (items, reason, submitted_by) signature.
    const buildMovements = (withPrices) => validItems.map(item => ({
      item_id: item.item_id, type: "stock_in", quantity: item.quantity,
      reason: reason || "purchase", submitted_by, po_id: po_id || null,
      ...(withPrices ? { total_price: item.total_price || null, unit_price: item.unit_price || null } : {}),
    }));
    // inventory_movements doesn't actually have unit_price/total_price columns yet (schema
    // gap — this insert was silently failing on every stock-in for months, since the
    // Supabase error was never checked, so PO receiving flipped a purchase order to
    // 'received' while its stock-in movement quietly never got recorded at all). Try with
    // prices first (works once the migration below is run); on that specific schema error,
    // fall back to recording the movement without them rather than losing it entirely.
    let { error: movErr } = await supabase.from("inventory_movements").insert(buildMovements(true));
    if (movErr && movErr.code === "PGRST204") {
      ({ error: movErr } = await supabase.from("inventory_movements").insert(buildMovements(false)));
    }
    if (movErr) throw movErr;

    const itemIds = validItems.map(i => i.item_id);
    const { data: currentStocks } = await supabase.from("inventory_stock")
      .select("item_id, current_qty").in("item_id", itemIds);
    const stockMap = {};
    (currentStocks || []).forEach(s => { stockMap[s.item_id] = Number(s.current_qty) || 0; });

    const upserts = validItems.map(item => ({
      item_id: item.item_id,
      current_qty: (stockMap[item.item_id] || 0) + Number(item.quantity),
      last_updated: new Date().toISOString(),
    }));
    const { error: stockErr } = await supabase.from("inventory_stock").upsert(upserts, { onConflict: "item_id" });
    if (stockErr) throw stockErr;

    // Close the loop on the source PO, if this stock-in is a receiving action —
    // record what actually arrived (may differ from what was ordered) rather than
    // silently assuming the order was fulfilled exactly as placed.
    if (po_id) {
      const { data: po } = await supabase.from("purchase_orders").select("items").eq("id", po_id).single();
      if (po) {
        const updatedItems = { ...po.items };
        validItems.forEach(item => {
          if (updatedItems[item.item_id]) updatedItems[item.item_id] = { ...updatedItems[item.item_id], received_qty: item.quantity };
        });
        await supabase.from("purchase_orders").update({
          items: updatedItems, status: "received", received_by: submitted_by, received_at: new Date().toISOString(),
        }).eq("id", po_id);
      }
    }

    res.json({ success: true, count: validItems.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock Out (remove stock) — BATCHED. No floor check: Smart Issue runs under real morning
// time pressure and blocking it would just move the problem, not fix it. Instead, any item
// that goes negative is surfaced back in the response so the caller can flag it immediately
// — a physical-count problem is much easier to fix same-day than after months of silent drift.
router.post("/stock-out", async (req, res) => {
  if (!await gate(req, res)) return;
  const { items, reason, submitted_by } = req.body;
  try {
    const validItems = items.filter(i => i.item_id && i.quantity && i.quantity > 0);
    if (validItems.length === 0) return res.json({ success: true, count: 0, went_negative: [] });

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

    const negativeIds = upserts.filter(u => u.current_qty < 0).map(u => u.item_id);
    let went_negative = [];
    if (negativeIds.length > 0) {
      const { data: negativeItems } = await supabase.from("inventory_items").select("id, name").in("id", negativeIds);
      went_negative = upserts.filter(u => u.current_qty < 0).map(u => ({
        item_id: u.item_id, name: (negativeItems || []).find(i => i.id === u.item_id)?.name || u.item_id, current_qty: u.current_qty,
      }));
    }

    res.json({ success: true, count: validItems.length, went_negative });
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

// ── Base Kitchen Daily Closing Stock — the audit leg outlets already have (closing_stocks
// + RM Audit) that BK never did. inventory_stock.current_qty is already a live running
// balance kept in lockstep by stock-in/stock-out/adjust, so "expected" for any moment is
// just that column — no need to replay movements to derive it.
router.get("/closing-stock/:date", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data, error } = await supabase.from("bk_closing_stock").select("*").eq("date", req.params.date).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

router.post("/closing-stock", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date, items, submitted_by } = req.body;
  if (!date || !items) return res.status(400).json({ error: "date and items are required" });
  // A physical count can never be negative — a prior submission (2026-07-28) got -16/-2/-3
  // punched in for a few Cleaning items (likely a stray minus-sign typo), which then
  // silently poisoned Store Audit's "Prior Closing" for every day since since nothing
  // newer has been submitted to anchor off instead. Reject at submit time instead of
  // letting it happen again.
  const negative = Object.entries(items).filter(([, qty]) => Number(qty) < 0);
  if (negative.length > 0) {
    return res.status(400).json({ error: `Closing count can't be negative: ${negative.map(([id, qty]) => `${id} (${qty})`).join(", ")}` });
  }
  const { data, error } = await supabase.from("bk_closing_stock")
    .upsert({ date, items, submitted_by, submitted_at: new Date().toISOString() }, { onConflict: "date" })
    .select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/inventory/closing-stock — BK closing stock history (month-wise), mirrors
// GET /api/closing-stocks for outlets. Powers the owner's Closing Stock grid's BK tab.
router.get("/closing-stock", async (req, res) => {
  if (!await gate(req, res)) return;
  const { from } = req.query;
  let query = supabase.from("bk_closing_stock").select("*");
  if (from) query = query.gte("date", from);
  query = query.order("date", { ascending: false });
  if (from) query = query.limit(500);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET /api/inventory/ledger — Owner-only. Date-wise Opening + Stock In − Stock Out =
// Expected Closing, compared against the store manager's actual submitted closing count
// (bk_closing_stock), for every date in [from, to] that has a submission. Unlike
// /audit/:date (which always compares against TODAY's live running balance, so it only
// makes sense for today), this replays each item's full inventory_movements history so a
// past date gets that date's own true opening/closing rather than today's number reused
// for every day — needed for a real 7-day / monthly ledger, not just a single-day snapshot.
router.get("/ledger", async (req, res) => {
  if (!await requireOwner(req, res)) return; // owner-only per explicit request — store managers submit counts but don't see the tally
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });
  try {
    const { data: items } = await supabase.from("inventory_items").select("id, name, category, unit");
    const { data: stocks } = await supabase.from("inventory_stock").select("item_id, current_qty");
    const { data: movements } = await supabase.from("inventory_movements").select("item_id, type, quantity, created_at").order("created_at", { ascending: true });
    const { data: closings } = await supabase.from("bk_closing_stock").select("date, items").gte("date", from).lte("date", to);

    const todayStr = istDate(new Date().toISOString());
    const currentQtyByItem = {};
    (stocks || []).forEach((s) => { currentQtyByItem[s.item_id] = Number(s.current_qty) || 0; });
    const deltasByItem = bucketMovementsByItemAndDay(movements);

    const closingByDate = {};
    (closings || []).forEach((c) => { closingByDate[c.date] = c.items || {}; });

    const dateList = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= todayStr; d.setUTCDate(d.getUTCDate() + 1)) {
      dateList.push(d.toISOString().slice(0, 10));
    }

    const balances = walkBackwardBalances(items, currentQtyByItem, deltasByItem, dateList);

    const resultsByDate = {};
    (items || []).forEach((item) => {
      dateList.forEach((date) => {
        if (date < from) return;
        const { opening, closing, stock_in, stock_out } = balances[item.id][date];

        const closingMap = closingByDate[date];
        if (!closingMap || closingMap[item.id] === undefined) return;
        const actual = Number(closingMap[item.id]);
        const variance = Math.round((actual - closing) * 1000) / 1000;
        if (variance === 0) return;

        if (!resultsByDate[date]) resultsByDate[date] = [];
        resultsByDate[date].push({
          item_id: item.id, name: item.name, category: item.category, unit: item.unit,
          opening: Math.round(opening * 1000) / 1000, stock_in: Math.round(stock_in * 1000) / 1000,
          stock_out: Math.round(stock_out * 1000) / 1000, expected_closing: Math.round(closing * 1000) / 1000,
          actual_closing: actual, variance,
        });
      });
    });

    const days = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const dayItems = (resultsByDate[date] || []).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
      days.push({ date, submitted: !!closingByDate[date], mismatched_count: dayItems.length, items: dayItems });
    }
    days.sort((a, b) => (a.date < b.date ? 1 : -1));

    res.json({ from, to, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compares each item's physical count for the date against the system's running balance —
// same "theoretical vs actual" idea as the outlet RM Audit, but simplified since the
// system side is already a maintained balance rather than something to be recomputed.
router.get("/audit/:date", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date } = req.params;
  const { data: itemRows, error: itemErr } = await supabase.from("inventory_items")
    .select("id, name, category, unit, inventory_stock(current_qty)").order("category").order("name");
  if (itemErr) return res.status(500).json({ error: itemErr.message });

  const { data: closing, error: closingErr } = await supabase.from("bk_closing_stock").select("*").eq("date", date).maybeSingle();
  if (closingErr) return res.status(500).json({ error: closingErr.message });
  const counted = closing?.items || {};

  const byCategory = {};
  (itemRows || []).forEach((item) => {
    const system = item.inventory_stock?.[0]?.current_qty ?? item.inventory_stock?.current_qty ?? 0;
    const hasCount = counted[item.id] !== undefined;
    const countedQty = hasCount ? Number(counted[item.id]) : null;
    const variance = hasCount ? Math.round((countedQty - Number(system)) * 1000) / 1000 : null;
    const cat = item.category || "Other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ item_id: item.id, name: item.name, unit: item.unit, system: Number(system), counted: countedQty, variance });
  });

  const categories = Object.entries(byCategory).map(([category, catItems]) => ({
    category,
    items: catItems.sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0)),
  }));

  res.json({
    date, submitted: !!closing, submitted_by: closing?.submitted_by || null, submitted_at: closing?.submitted_at || null,
    categories,
  });
});

// ── GET /api/inventory/audit-full/:date — "Base Kitchen Audit": two independent
// reconciliation checks for a single day, both keyed off inventory_items (only items
// with a demand_item_id link participate in the demand/dispatch check — the ~11 raw
// ingredients that are only ever consumed inside a BK recipe, never demanded directly,
// have no "demanded" figure and are simply omitted from that half).
//
// (1) Demand vs Stock-Out: the demand→dispatch pipeline (Outlet Manager/BK "demand" a
// qty, Store "dispatch"es it) and the Inventory stock-out screen (Store manually types
// what physically left the shelf) are two completely disconnected systems today — dispatch
// never touches inventory_movements. This sums both sides for the day and surfaces the
// gap, so a mismatch between "what Store said it sent" and "what Store said it removed
// from stock" doesn't sit invisible.
// (2) Inventory roll-forward: reuses the exact same drift-safe backward-walk balance
// math as /ledger (previous day's closing + today's stock-in − today's stock-out =
// expected current), compared against today's actual bk_closing_stock count (or, if
// today hasn't been counted yet, the live running balance, clearly labeled as such).
router.get("/audit-full/:date", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date } = req.params;
  try {
    const { data: items } = await supabase.from("inventory_items").select("id, name, category, unit, demand_item_id");

    // ── Part 2: roll-forward balance — Stage 6 re-anchor onto the new ledger
    // (stock_movements, location='store') instead of inventory_movements, and Closing
    // Counts (stock_counts) instead of bk_closing_stock for "actual" — same reasoning as
    // store-audit's header comment. Unlike store-audit, this doesn't NEED a physical
    // anchor to compute "expected" — stock_movements carries its own OPENING baseline
    // (Stage 1 backfill), so opening/closing for any date is a direct sum, not a
    // backward-walk from a cache. Only "logged_current" (the comparison point) needs an
    // actual count, and gracefully stays null when one isn't available for that date —
    // same degrade-to-null behavior this endpoint already had, not a new gap.
    const { data: allMovements } = await supabase.from("stock_movements").select("item_id, movement_type, qty_delta, created_at").eq("location_id", "store");
    const todayStr = istDate(new Date().toISOString());
    const isToday = date === todayStr;
    const dateStart = new Date(`${date}T00:00:00Z`);
    const dateEnd = new Date(`${nextDay(date)}T00:00:00Z`);
    const openingByItem = {}, stockInByItem = {}, stockOutByItem = {};
    (allMovements || []).forEach((m) => {
      const delta = Number(m.qty_delta) || 0;
      const ts = new Date(m.created_at);
      if (ts < dateStart) {
        openingByItem[m.item_id] = (openingByItem[m.item_id] || 0) + delta;
      } else if (ts < dateEnd) {
        if (delta > 0) stockInByItem[m.item_id] = (stockInByItem[m.item_id] || 0) + delta;
        else if (delta < 0) stockOutByItem[m.item_id] = (stockOutByItem[m.item_id] || 0) - delta;
      }
    });

    const { data: countRow } = await supabase.from("stock_counts")
      .select("id").eq("location_id", "store").eq("status", "submitted").eq("count_date", date)
      .order("submitted_at", { ascending: false }).limit(1).maybeSingle();
    let loggedToday = null;
    if (countRow) {
      const { data: rows } = await supabase.from("stock_count_items").select("item_id, counted_qty").eq("count_id", countRow.id);
      loggedToday = {}; (rows || []).forEach((r) => { loggedToday[r.item_id] = Number(r.counted_qty); });
    }
    let liveQtyByItem = {};
    if (isToday && !loggedToday) {
      const { data: balances } = await supabase.from("store_stock_balances").select("item_id, current_qty").eq("location_id", "store");
      (balances || []).forEach((b) => { liveQtyByItem[b.item_id] = Number(b.current_qty) || 0; });
    }

    // ── Part 1: demand vs dispatch vs stock-out, for the same calendar day ──
    // "Demanded from Base Kitchen and outlets" = the 6 real outlets' regular demand
    // (type='manual') plus Base Kitchen's own demand from Store (type='bk_demand',
    // outlet_id='bk') — both share the same demands table/dispatch route (see
    // BaseKitchen/Dispatch components), and both draw down Store's physical stock once
    // dispatched. Bucketed by the day they were actually DISPATCHED (not the demand's
    // requested delivery date), to line up with stock-out movements on that same day.
    const { data: demandRows } = await supabase.from("demands")
      .select("outlet_id, type, items, dispatch_items, status, dispatched_at")
      .in("type", ["manual", "bk_demand"]).eq("status", "fulfilled")
      .gte("dispatched_at", `${date}T00:00:00Z`).lt("dispatched_at", `${nextDay(date)}T00:00:00Z`);

    const demandItemIdToInvId = {};
    (items || []).forEach((i) => { if (i.demand_item_id) demandItemIdToInvId[i.demand_item_id] = i.id; });

    const demandedByInvId = {};
    const dispatchedByInvId = {};
    (demandRows || []).forEach((row) => {
      Object.entries(row.items || {}).forEach(([id, qty]) => {
        const invId = demandItemIdToInvId[id];
        if (!invId || !(Number(qty) > 0)) return;
        demandedByInvId[invId] = (demandedByInvId[invId] || 0) + Number(qty);
      });
      Object.entries(row.dispatch_items || {}).forEach(([id, qty]) => {
        const invId = demandItemIdToInvId[id];
        if (!invId || !(Number(qty) > 0)) return;
        dispatchedByInvId[invId] = (dispatchedByInvId[invId] || 0) + Number(qty);
      });
    });

    const round = (n) => Math.round(n * 1000) / 1000;
    const byCategory = {};
    (items || []).forEach((item) => {
      const opening = openingByItem[item.id] || 0;
      const stockIn = stockInByItem[item.id] || 0;
      const stockOut = stockOutByItem[item.id] || 0;
      const closing = opening + stockIn - stockOut;

      const loggedCurrent = loggedToday && loggedToday[item.id] !== undefined ? loggedToday[item.id]
        : (isToday ? (liveQtyByItem[item.id] || 0) : null);
      const loggedIsLive = isToday && !(loggedToday && loggedToday[item.id] !== undefined);
      const balanceVariance = loggedCurrent != null ? round(loggedCurrent - closing) : null;

      const demanded = item.demand_item_id ? (demandedByInvId[item.id] || 0) : null;
      const dispatched = item.demand_item_id ? (dispatchedByInvId[item.id] || 0) : null;
      // Under the new ledger, a DISPATCH movement and its demands.dispatch_items entry
      // are written by the same action (stockOutHooks.js) — so this should always be
      // ~0 by construction now, unlike the old system where Stock-Out was a manual,
      // separate action that could genuinely drift from what demand said. Kept (not
      // removed) since a non-zero value here would mean a real software bug, not
      // operational drift — still worth surfacing, just a different kind of signal now.
      const dispatchVariance = item.demand_item_id ? round(stockOut - dispatched) : null;

      // Skip items with nothing to say: no demand/dispatch activity, no stock movement, no variance.
      const hasDemandActivity = (demanded || 0) > 0 || (dispatched || 0) > 0;
      const hasStockMovement = stockIn > 0 || stockOut > 0;
      const hasVariance = !!balanceVariance;
      if (!hasDemandActivity && !hasStockMovement && !hasVariance) return;

      const cat = item.category || "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({
        item_id: item.id, name: item.name, unit: item.unit,
        demanded, dispatched, stock_out: round(stockOut), dispatch_variance: dispatchVariance,
        opening: round(opening), stock_in: round(stockIn),
        expected_current: round(closing), logged_current: loggedCurrent != null ? round(loggedCurrent) : null,
        logged_is_live: loggedIsLive, balance_variance: balanceVariance,
      });
    });

    const categories = Object.entries(byCategory).map(([category, catItems]) => ({
      category,
      items: catItems.sort((a, b) => Math.abs(b.dispatch_variance || 0) + Math.abs(b.balance_variance || 0) - Math.abs(a.dispatch_variance || 0) - Math.abs(a.balance_variance || 0)),
    }));

    res.json({ date, is_today: isToday, closing_submitted: !!(loggedToday && Object.keys(loggedToday).length), categories });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/inventory/store-audit/:date — "BK Store Audit", first-principles version:
// Store is the single source both Base Kitchen (raw materials, to cook) and outlets
// (everything except food prepared in BK, which they get from BK not Store) draw from.
// So, per item:
//   Should-Be Closing = Prior Actual Closing + Purchases − BK Demand − Outlet Demand
// (Outlet Demand excludes anything filed under the "food" DEMAND_SECTIONS category,
// since outlets don't draw those directly from Store.) Compared against what was
// actually logged for the target date. Deliberately demand-driven rather than reading
// the separate Inventory "Stock Out" log the way audit-full's dispatch check does —
// that log is essentially never used for BK-prepared items (see audit-full's Food
// category rows), which would make a stock-out-based "should be" wrong for exactly the
// items that matter most here.
//
// Stage 6 re-anchor: "Prior Actual Closing" used to be strictly yesterday's submitted
// bk_closing_stock count, with the gap (when missing) surfaced via Missing Punches. Both
// legs of that are now gone — bk_closing_stock stopped getting submissions once the old
// Inventory screen was retired from Store/bk_manager's nav, AND the Missing Punches
// check that used to flag exactly this was removed in the same pass (a miss — its own
// header comment said the anchor-gap was "surfaced via Missing Punches instead of
// quietly papered over here", and removing that check without replacing it is exactly
// the quiet papering-over it was built to prevent). Re-anchored onto the new system
// instead of trying to keep the old one fed:
//   - "Prior Actual Closing" = the most recent SUBMITTED Closing Count (stock_counts,
//     location='store') on or before date-1 — not required to be exactly yesterday,
//     since counts are periodic under the new design, not a daily requirement. The
//     actual anchor date used is always returned (prev_date) so the UI can show it
//     plainly ("anchored to Aug 20") instead of implying a same-day count that isn't
//     required to exist.
//   - Purchases now also includes received Vendor Challans (vendor_challans /
//     vendor_challan_items, location='store') — real purchases moved onto this table
//     once the old ordering flow was retired; the old inventory_movements/purchase_orders
//     sources are kept too since either can still carry real history.
//   - "Actual" for `date` itself: a submitted Closing Count dated exactly `date` if one
//     exists, else (only for today) the LIVE store_stock_balances figure — not the old
//     inventory_stock column, which is frozen at whatever it was on cutover day and will
//     never move again.
//   - no_recent_count: true when the anchor is more than 1 day stale (or missing
//     entirely) — the explicit, visible version of what Missing Punches used to imply.
router.get("/store-audit/:date", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date } = req.params;
  try {
    const yesterday = prevDay(date);
    const { data: items } = await supabase.from("inventory_items").select("id, name, category, unit, demand_item_id");
    const { data: demandItems } = await supabase.from("demand_items").select("id, section_id");

    const foodDemandIds = new Set((demandItems || []).filter((d) => d.section_id === "food").map((d) => d.id));
    const isFoodItem = (item) => item.demand_item_id && foodDemandIds.has(item.demand_item_id);

    const todayStr = istDate(new Date().toISOString());
    const isToday = date === todayStr;

    // ── Anchor + today's actual, from Closing Counts (stock_counts/stock_count_items),
    // not bk_closing_stock — see header comment. Anchor = most recent SUBMITTED count
    // for 'store' on or before yesterday; not required to land exactly on yesterday
    // since counts are periodic now, not a daily requirement.
    const { data: anchorCountRow } = await supabase.from("stock_counts")
      .select("id, count_date").eq("location_id", "store").eq("status", "submitted")
      .lte("count_date", yesterday).order("count_date", { ascending: false }).limit(1).maybeSingle();
    const prevDate = anchorCountRow?.count_date || null;
    let prevClosing = null;
    if (anchorCountRow) {
      const { data: rows } = await supabase.from("stock_count_items").select("item_id, counted_qty").eq("count_id", anchorCountRow.id);
      prevClosing = {}; (rows || []).forEach((r) => { prevClosing[r.item_id] = Number(r.counted_qty); });
    }
    // Flags when the anchor is more than a day stale (or missing) — the explicit,
    // visible replacement for what Missing Punches used to imply about this gap.
    const no_recent_count = !prevDate || prevDate < prevDay(yesterday);

    const { data: todayCountRow } = await supabase.from("stock_counts")
      .select("id").eq("location_id", "store").eq("status", "submitted").eq("count_date", date)
      .order("submitted_at", { ascending: false }).limit(1).maybeSingle();
    let todayClosing = null;
    if (todayCountRow) {
      const { data: rows } = await supabase.from("stock_count_items").select("item_id, counted_qty").eq("count_id", todayCountRow.id);
      todayClosing = {}; (rows || []).forEach((r) => { todayClosing[r.item_id] = Number(r.counted_qty); });
    }
    // Live fallback for "today, no fresh count yet" — store_stock_balances (always
    // current, derived from stock_movements), NOT inventory_stock (frozen since the old
    // Inventory screen was retired — it will never move again).
    let liveQtyByItem = {};
    if (isToday && !todayClosing) {
      const { data: balances } = await supabase.from("store_stock_balances").select("item_id, current_qty").eq("location_id", "store");
      (balances || []).forEach((b) => { liveQtyByItem[b.item_id] = Number(b.current_qty) || 0; });
    }

    const actualClosingByItem = {};
    (items || []).forEach((item) => {
      if (todayClosing && todayClosing[item.id] !== undefined) actualClosingByItem[item.id] = { qty: todayClosing[item.id], isLive: false };
      else if (isToday) actualClosingByItem[item.id] = { qty: liveQtyByItem[item.id] || 0, isLive: true };
    });

    let purchasesByItem = {}, bkDemandByItem = {}, outletDemandByItem = {}, outletBreakdownByItem = {};
    if (prevDate) {
      // Window is exactly `date` (00:00Z through next day's 00:00Z) — purchases/demand
      // that happened since the prior closing snapshot through end of `date`. Was
      // previously anchored at prevDate's start instead of date's start, making this a
      // 2-calendar-day window that always double-counted the entire prior day into both
      // it and the next day's query — e.g. date=08-23 and date=08-24 both fully included
      // 08-23's purchases, making "+ Purchases" look identical across adjacent dates.
      const rangeStart = `${date}T00:00:00Z`; // exclusive
      const rangeEnd = `${nextDay(date)}T00:00:00Z`; // exclusive upper bound (through end of `date`)

      // Real purchases are confirmed to come in through the Order Challan flow
      // (purchase_orders, received via the driver/Stock-In-with-po_id path). Two real
      // sources can both be populated for the exact same physical receiving event —
      // /stock-in (inventory.js) writes an inventory_movements row stamped with po_id
      // AND updates purchase_orders.items[itemId].received_qty together, in one call —
      // so this has to dedupe by (po_id, item_id), not sum both blindly. Verified against
      // real data: 2026-08-21's PO-...-002 has both a movement (qty 900, po_id matching
      // the PO's own id) and received_qty:900 for the same item; summing both without
      // deduping doubled it to 1800 in an earlier version of this fix, caught by checking
      // the actual number against the source records before trusting it.
      const { data: movements } = await supabase.from("inventory_movements")
        .select("item_id, quantity, po_id, created_at").eq("type", "stock_in")
        .gt("created_at", rangeStart).lt("created_at", rangeEnd);
      const movementPoItemPairs = new Set();
      (movements || []).forEach((m) => {
        purchasesByItem[m.item_id] = (purchasesByItem[m.item_id] || 0) + (Number(m.quantity) || 0);
        if (m.po_id) movementPoItemPairs.add(`${m.po_id}::${m.item_id}`);
      });

      const { data: receivedPOs } = await supabase.from("purchase_orders")
        .select("id, items, received_at").eq("status", "received")
        .gt("received_at", rangeStart).lt("received_at", rangeEnd);
      (receivedPOs || []).forEach((po) => {
        Object.entries(po.items || {}).forEach(([itemId, item]) => {
          if (movementPoItemPairs.has(`${po.id}::${itemId}`)) return; // already counted via the movement above
          const qty = Number(item?.received_qty) || 0;
          if (qty > 0) purchasesByItem[itemId] = (purchasesByItem[itemId] || 0) + qty;
        });
      });

      // Real purchases moved onto Vendor Challans once the old ordering flow was
      // retired — a genuinely separate table from the two above (no dedup risk),
      // additive with them so any transition-period history in the old sources still
      // counts too.
      const { data: receivedChallans } = await supabase.from("vendor_challans")
        .select("id").eq("location_id", "store").eq("status", "received")
        .gt("received_at", rangeStart).lt("received_at", rangeEnd);
      if (receivedChallans?.length) {
        const { data: challanItems } = await supabase.from("vendor_challan_items")
          .select("item_id, qty_base").in("challan_id", receivedChallans.map((c) => c.id));
        (challanItems || []).forEach((l) => {
          const qty = Number(l.qty_base) || 0;
          if (qty > 0) purchasesByItem[l.item_id] = (purchasesByItem[l.item_id] || 0) + qty;
        });
      }

      const { data: demandRows } = await supabase.from("demands")
        .select("outlet_id, dispatch_items").in("type", ["manual", "bk_demand"]).eq("status", "fulfilled")
        .gt("dispatched_at", rangeStart).lt("dispatched_at", rangeEnd);

      const demandItemIdToInvId = {};
      (items || []).forEach((i) => { if (i.demand_item_id) demandItemIdToInvId[i.demand_item_id] = i.id; });
      const invById = {}; (items || []).forEach((i) => { invById[i.id] = i; });

      (demandRows || []).forEach((row) => {
        Object.entries(row.dispatch_items || {}).forEach(([demandId, qty]) => {
          const invId = demandItemIdToInvId[demandId];
          const q = Number(qty) || 0;
          if (!invId || q <= 0) return;
          if (row.outlet_id === "bk") {
            bkDemandByItem[invId] = (bkDemandByItem[invId] || 0) + q;
          } else if (!isFoodItem(invById[invId])) {
            outletDemandByItem[invId] = (outletDemandByItem[invId] || 0) + q;
            (outletBreakdownByItem[invId] = outletBreakdownByItem[invId] || {});
            outletBreakdownByItem[invId][row.outlet_id] = (outletBreakdownByItem[invId][row.outlet_id] || 0) + q;
          }
        });
      });
    }

    const round = (n) => Math.round(n * 1000) / 1000;
    const byCategory = {};
    (items || []).forEach((item) => {
      if (!prevDate || prevClosing[item.id] === undefined) return; // no prior anchor to audit from
      const prevQty = Number(prevClosing[item.id]);
      const purchases = purchasesByItem[item.id] || 0;
      const bkDemand = bkDemandByItem[item.id] || 0;
      const outletDemand = outletDemandByItem[item.id] || 0;
      const shouldBe = prevQty + purchases - bkDemand - outletDemand;
      const actual = actualClosingByItem[item.id];

      const hasActivity = purchases > 0 || bkDemand > 0 || outletDemand > 0;
      const variance = actual ? round(actual.qty - shouldBe) : null;
      if (!hasActivity && (variance === null || variance === 0)) return;

      const cat = item.category || "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({
        item_id: item.id, name: item.name, unit: item.unit,
        prev_closing: round(prevQty), purchases: round(purchases), bk_demand: round(bkDemand), outlet_demand: round(outletDemand),
        outlet_breakdown: outletBreakdownByItem[item.id] ? Object.fromEntries(Object.entries(outletBreakdownByItem[item.id]).map(([k, v]) => [k, round(v)])) : null,
        should_be_closing: round(shouldBe),
        actual_closing: actual ? round(actual.qty) : null, actual_is_live: actual ? actual.isLive : false,
        variance,
      });
    });

    const categories = Object.entries(byCategory).map(([category, catItems]) => ({
      category, items: catItems.sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0)),
    }));

    res.json({ date, prev_date: prevDate, is_today: isToday, actual_submitted: !!(todayClosing && Object.keys(todayClosing).length), no_recent_count, categories });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
