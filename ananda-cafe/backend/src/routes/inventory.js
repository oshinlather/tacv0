const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { requireRole, requireOwner } = require("./authGuards");

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
    const movements = validItems.map(item => ({
      item_id: item.item_id, type: "stock_in", quantity: item.quantity,
      reason: reason || "purchase", submitted_by, po_id: po_id || null,
      total_price: item.total_price || null,
      unit_price: item.unit_price || null,
    }));
    await supabase.from("inventory_movements").insert(movements);

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
    await supabase.from("inventory_stock").upsert(upserts, { onConflict: "item_id" });

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

    // IST calendar day for a timestamp — same +5:30 shift convention used elsewhere in
    // this codebase (todayIST, the /movements route's date filtering).
    const istDate = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() + 330); return d.toISOString().slice(0, 10); };
    const todayStr = istDate(new Date().toISOString());

    const currentQtyByItem = {};
    (stocks || []).forEach((s) => { currentQtyByItem[s.item_id] = Number(s.current_qty) || 0; });

    // Per item, per IST day: how much moved in vs out. Positive adjustments (from the
    // Closing Stock "Adjust" action, or any manual correction) count as stock_in and
    // negative ones as stock_out, so the running balance stays true even across a
    // correction — not filtered by date range, since anchoring below needs every
    // movement through today, not just the ones inside [from, to].
    const deltasByItem = {};
    (movements || []).forEach((m) => {
      const date = istDate(m.created_at);
      const perDate = (deltasByItem[m.item_id] = deltasByItem[m.item_id] || {});
      const day = (perDate[date] = perDate[date] || { in: 0, out: 0 });
      const qty = Number(m.quantity) || 0;
      if (m.type === "stock_out") day.out += Math.abs(qty);
      else if (qty >= 0) day.in += qty;
      else day.out += Math.abs(qty);
    });

    const closingByDate = {};
    (closings || []).forEach((c) => { closingByDate[c.date] = c.items || {}; });

    const dateList = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= todayStr; d.setUTCDate(d.getUTCDate() + 1)) {
      dateList.push(d.toISOString().slice(0, 10));
    }

    // Walk backward from TODAY — whose closing balance is the live, always-correct
    // inventory_stock.current_qty — down to `from`. inventory_movements is an append-only
    // log that can drift from the live balance in practice (e.g. a correction made
    // directly in the database rather than through this app's own Adjust action), so
    // forward-replaying from an assumed zero start would silently misreport every day.
    // Anchoring to today and subtracting each day's net delta as we step backward means
    // any such drift gets absorbed into the earliest date's Opening instead of
    // propagating a wrong number through the whole reported range.
    const resultsByDate = {};
    (items || []).forEach((item) => {
      let closingRunning = currentQtyByItem[item.id] || 0;
      for (let i = dateList.length - 1; i >= 0; i--) {
        const date = dateList[i];
        const bucket = (deltasByItem[item.id] || {})[date] || { in: 0, out: 0 };
        const closing = closingRunning;
        const opening = closing - bucket.in + bucket.out;
        closingRunning = opening;
        if (date < from) continue;

        const closingMap = closingByDate[date];
        if (!closingMap || closingMap[item.id] === undefined) continue;
        const actual = Number(closingMap[item.id]);
        const variance = Math.round((actual - closing) * 1000) / 1000;
        if (variance === 0) continue;

        if (!resultsByDate[date]) resultsByDate[date] = [];
        resultsByDate[date].push({
          item_id: item.id, name: item.name, category: item.category, unit: item.unit,
          opening: Math.round(opening * 1000) / 1000, stock_in: Math.round(bucket.in * 1000) / 1000,
          stock_out: Math.round(bucket.out * 1000) / 1000, expected_closing: Math.round(closing * 1000) / 1000,
          actual_closing: actual, variance,
        });
      }
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
