// storeLedgerHistory.js — Store Inventory Module Stage 5 course-correction: checks the
// OLD system's own movement log against its own real physical counts, for STORE only
// (BK dropped out entirely — see stockOutHooks.js's header: the old "BK Closing Stock"
// table has only ever been Store's real physical count, mislabeled; there is no old
// data for BK at all).
//
// Methodology, corrected from a first version that tried to reconstruct absolute
// balances from inventory_movements alone starting from zero: that failed immediately
// against real data — several items show a flat, unchanging ledger total across weeks
// while their real physical counts clearly moved (e.g. Dosa Box Big's ledger sum was
// -503 on both 2026-07-16 AND 2026-07-19, while its real count dropped 13750 -> 12899
// in that window) — meaning inventory_movements simply doesn't have a complete history
// for every item back to whenever inventory_stock's numbers first started. There's no
// way to know the true opening balance before movement logging began, so this doesn't
// try to.
//
// Instead: for every CONSECUTIVE pair of real bk_closing_stock counts (Store's real
// physical count, confirmed with the owner despite the table's name), it sums only the
// inventory_movements that happened strictly between them, and checks whether
// PhysicalCount(day 1) + movements(day1->day2) lands on PhysicalCount(day 2). This
// anchors every comparison to a real, known starting point instead of an assumed one,
// and answers the actual question — does the movement log correctly explain what
// happened between two real counts — for every gap where the answer is knowable.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireOwner } = require("./authGuards");

router.get("/store-ledger-history", async (req, res) => {
  if (!await requireOwner(req, res)) return;

  const [{ data: invItems }, { data: allMovements }, { data: closings }] = await Promise.all([
    supabase.from("inventory_items").select("id, name, category, unit"),
    supabase.from("inventory_movements").select("item_id, type, quantity, created_at").order("created_at", { ascending: true }),
    supabase.from("bk_closing_stock").select("date, items").order("date", { ascending: true }),
  ]);

  const itemById = new Map((invItems || []).map((i) => [i.id, i]));
  const movements = allMovements || [];
  const countDates = (closings || []).map((c) => c.date);

  // Sum of signed movements strictly between two IST calendar-day boundaries, per item.
  // quantity is already correctly signed at the source (confirmed against real data):
  // /stock-in inserts positive, /stock-out inserts already-negated, /adjust inserts a
  // signed delta — summed as-is, no re-deriving sign from `type`.
  function movementsBetween(fromDate, toDate) {
    const fromUTC = new Date(`${fromDate}T00:00:00+05:30`);
    fromUTC.setUTCDate(fromUTC.getUTCDate() + 1); // start counting the day AFTER the "from" count was taken
    const toUTC = new Date(`${toDate}T00:00:00+05:30`);
    toUTC.setUTCDate(toUTC.getUTCDate() + 1); // up through the end of the "to" count's day
    const sums = new Map();
    for (const m of movements) {
      const t = new Date(m.created_at);
      if (t >= fromUTC && t < toUTC) sums.set(m.item_id, (sums.get(m.item_id) || 0) + (Number(m.quantity) || 0));
    }
    return sums;
  }

  // One reconciliation entry per consecutive pair of real counts.
  const gaps = [];
  for (let i = 1; i < closings.length; i++) {
    const prev = closings[i - 1];
    const cur = closings[i];
    const moved = movementsBetween(prev.date, cur.date);
    const itemIds = new Set([...Object.keys(prev.items || {}), ...Object.keys(cur.items || {}), ...moved.keys()]);
    const items = [];
    itemIds.forEach((itemId) => {
      const item = itemById.get(itemId);
      if (!item) return;
      const before = Number(prev.items[itemId]) || 0;
      const after = Number(cur.items[itemId]) || 0;
      const movedQty = moved.get(itemId) || 0;
      const expectedAfter = before + movedQty;
      const variance = Math.round((expectedAfter - after) * 1000) / 1000;
      if (before === 0 && after === 0 && movedQty === 0) return;
      items.push({ item_id: itemId, name: item.name, category: item.category, unit: item.unit, before, moved: Math.round(movedQty * 1000) / 1000, expected_after: Math.round(expectedAfter * 1000) / 1000, actual_after: after, variance });
    });
    items.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    gaps.push({ from_date: prev.date, to_date: cur.date, items });
  }

  res.json({ count_dates: countDates, gaps });
});

module.exports = router;
