// pnlMigrationCompare.js — Stage 5 migration tool, NOT a permanent feature. Computes
// BK's "material used" for a date TWO ways, side by side, and does nothing else — no
// writes, no effect on the real P&L. This exists purely so the old formula
// (computeStockUsageForDate's BK branch in salesRoutes.js, reading bk_closing_stock +
// inventory_movements) and the new ledger's own number can be watched converging before
// anyone flips which one the live P&L actually uses. Delete this whole file once that
// cutover happens — it has no reason to exist afterward.
//
// OLD (unchanged, exactly what salesRoutes.js's computeStockUsageForDate does today):
//   Opening = PrevDay's bk_closing_stock count + today's inventory_movements stock_in
//   Used    = max(0, Opening − TodayClosing count)
// This requires BK to physically count every single day, and "Used" is only ever an
// implied leftover, never a directly observed number.
//
// NEW (the new ledger's own answer to the same question): Used = sum of |DISPATCH
// qty_delta| at location='bk' on that date — this is not an approximation, it's the
// literal record of what left BK that day (see stockOutHooks.js — every real dispatch
// already writes this). No closing count is needed to know it. The trade-off exposed by
// running both side by side is the inbound leg: the new ledger's BK balance has only
// ever been getting real DISPATCH decrements (live since Stage 3) — nobody has used
// Vendor Challans for real receiving yet, and BK's replenishment-from-Store transfers
// aren't necessarily happening for real yet either — so the new ledger's own current
// balance is very likely stale/under-counted right now. That's expected, not a bug in
// this comparison; it's exactly what Step 1 (a real physical re-baseline count) fixes.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireOwner } = require("./authGuards");

router.get("/pnl-compare/:date", async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { date } = req.params;
  const prevDate = new Date(`${date}T00:00:00Z`);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10);
  const dayStartUTC = new Date(`${date}T00:00:00+05:30`).toISOString();
  const dayEndUTC = new Date(new Date(dayStartUTC).getTime() + 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: invItems },
    { data: rates },
    { data: prevBkClosing },
    { data: todayBkClosing },
    { data: oldStockIn },
    { data: newMovements },
    { data: newBalances },
  ] = await Promise.all([
    supabase.from("inventory_items").select("id, name, category, unit, demand_item_id"),
    supabase.from("rate_card").select("id, price").eq("active", true),
    supabase.from("bk_closing_stock").select("items").eq("date", prevDateStr).maybeSingle(),
    supabase.from("bk_closing_stock").select("items").eq("date", date).maybeSingle(),
    supabase.from("inventory_movements").select("item_id, quantity").eq("type", "stock_in").gte("created_at", dayStartUTC).lt("created_at", dayEndUTC),
    supabase.from("stock_movements").select("item_id, movement_type, qty_delta").eq("location_id", "bk").gte("created_at", dayStartUTC).lt("created_at", dayEndUTC),
    supabase.from("store_stock_balances").select("item_id, current_qty").eq("location_id", "bk"),
  ]);

  const priceByRateCardId = new Map((rates || []).map((r) => [r.id, Number(r.price) || 0]));
  const oldStockInByItem = {};
  (oldStockIn || []).forEach((m) => { oldStockInByItem[m.item_id] = (oldStockInByItem[m.item_id] || 0) + (Number(m.quantity) || 0); });
  const newDispatchedByItem = {};
  const newReceivedByItem = {};
  (newMovements || []).forEach((m) => {
    const qty = Number(m.qty_delta) || 0;
    if (qty < 0) newDispatchedByItem[m.item_id] = (newDispatchedByItem[m.item_id] || 0) + Math.abs(qty);
    else newReceivedByItem[m.item_id] = (newReceivedByItem[m.item_id] || 0) + qty;
  });
  const newBalanceByItem = new Map((newBalances || []).map((b) => [b.item_id, Number(b.current_qty) || 0]));

  const prevItems = prevBkClosing?.items || {};
  const todayItems = todayBkClosing?.items || {};

  const rows = [];
  (invItems || []).forEach((item) => {
    // Old formula is in the OLD item's own unit (item.unit) at rate_card price per that
    // same unit — no cross-unit conversion needed here since we're not mixing with the
    // new ledger's numbers on the same row, just placing them side by side.
    const price = priceByRateCardId.get(item.demand_item_id) || 0;
    const prevQty = Number(prevItems[item.id]) || 0;
    const stockInQty = oldStockInByItem[item.id] || 0;
    const closingQty = Number(todayItems[item.id]) || 0;
    const oldOpening = prevQty + stockInQty;
    const oldUsed = Math.max(0, oldOpening - closingQty);

    const newDispatched = newDispatchedByItem[item.id] || 0;
    const newReceived = newReceivedByItem[item.id] || 0;
    const newCurrentBalance = newBalanceByItem.get(item.id) || 0;

    if (oldUsed === 0 && newDispatched === 0 && newReceived === 0 && !prevQty && !closingQty) return; // nothing happened, skip

    rows.push({
      item_id: item.id, name: item.name, category: item.category, unit: item.unit,
      old_prev_closing: prevQty, old_stock_in: stockInQty, old_today_closing: closingQty, old_used: Math.round(oldUsed * 1000) / 1000, old_used_value: Math.round(oldUsed * price),
      new_dispatched: Math.round(newDispatched * 1000) / 1000, new_received: Math.round(newReceived * 1000) / 1000, new_current_balance: newCurrentBalance,
      diff_used_qty: Math.round((oldUsed - newDispatched) * 1000) / 1000,
    });
  });

  rows.sort((a, b) => Math.abs(b.diff_used_qty) - Math.abs(a.diff_used_qty));
  const oldTotalValue = rows.reduce((s, r) => s + r.old_used_value, 0);
  res.json({ date, item_count: rows.length, old_total_used_value: oldTotalValue, rows });
});

module.exports = router;
