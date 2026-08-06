const supabase = require("./supabase");

// Shared by /api/inventory/stock-in and any other route that needs to credit the
// inventory ledger (e.g. a cash Purchase line linked to an inventory item) — batched
// movement-insert + inventory_stock upsert, identical to inventory.js's own /stock-in
// so every crediting path keeps inventory_stock and inventory_movements in lockstep.
async function creditStockIn(items, reason, submitted_by) {
  const validItems = (items || []).filter(i => i.item_id && i.quantity && i.quantity > 0);
  if (validItems.length === 0) return { count: 0 };

  const movements = validItems.map(item => ({
    item_id: item.item_id, type: "stock_in", quantity: item.quantity,
    reason: reason || "purchase", submitted_by,
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

  return { count: validItems.length };
}

// IST calendar day for a timestamp — same +5:30 shift convention used throughout this
// codebase (todayIST, the /movements route's date filtering).
const istDate = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() + 330); return d.toISOString().slice(0, 10); };

// Per item, per IST day: how much moved in vs out. Positive adjustments (from the
// Closing Stock "Adjust" action, or any manual correction) count as stock_in and
// negative ones as stock_out, so the running balance stays true even across a
// correction. Not date-filtered here — callers that only need one date/range still get
// every movement through today, since the backward walk below needs the full history.
function bucketMovementsByItemAndDay(movements) {
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
  return deltasByItem;
}

// Walk backward from TODAY — whose closing balance is the live, always-correct
// inventory_stock.current_qty — down through `dateList`. inventory_movements is an
// append-only log that can drift from the live balance in practice (e.g. a correction
// made directly in the database rather than through this app's own Adjust action), so
// forward-replaying from an assumed start would silently misreport every day. Anchoring
// to today and subtracting each day's net delta as we step backward means any such
// drift gets absorbed into the earliest date's Opening instead of propagating a wrong
// number through the whole reported range. Shared by /ledger (a date range) and the BK
// Audit route (a single date) so both agree on the exact same balances.
//
// Returns { [item_id]: { [date]: { opening, closing, stock_in, stock_out } } } for every
// date in dateList (dateList must be sorted ascending, and its last entry must be <=
// today — the walk starts from today's live balance regardless of where dateList ends).
function walkBackwardBalances(items, currentQtyByItem, deltasByItem, dateList) {
  const byItem = {};
  (items || []).forEach((item) => {
    let closingRunning = currentQtyByItem[item.id] || 0;
    const byDate = {};
    for (let i = dateList.length - 1; i >= 0; i--) {
      const date = dateList[i];
      const bucket = (deltasByItem[item.id] || {})[date] || { in: 0, out: 0 };
      const closing = closingRunning;
      const opening = closing - bucket.in + bucket.out;
      closingRunning = opening;
      byDate[date] = { opening, closing, stock_in: bucket.in, stock_out: bucket.out };
    }
    byItem[item.id] = byDate;
  });
  return byItem;
}

module.exports = { creditStockIn, istDate, bucketMovementsByItemAndDay, walkBackwardBalances };
