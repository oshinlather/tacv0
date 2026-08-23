// stockOutHooks.js — Store Inventory Module Stage 3: auto stock-out, called from the
// EXISTING dispatch action (PATCH /api/orders/:id/dispatch in salesRoutes.js) rather
// than reinventing a parallel dispatch flow. salesRoutes.js only gains one extra
// function call at the end of that route — this file holds all the new logic.
//
// REVISED (Stage 5 course-correction): BK is NOT a tracked location. Originally built
// assuming Store and BK were two separate, independently-stocked places with real
// transfers between them — confirmed directly with the owner that this was wrong on two
// counts: (1) the old "BK Closing Stock" daily count has only ever been Store's real
// physical count, mislabeled — there has never been an independent count of BK at all;
// (2) operationally BK works exactly like an outlet — it creates a demand, receives a
// dispatch, and (like outlets) isn't given a live per-movement ledger. The owner
// explicitly chose "simplify BK to outlet-style" over "keep BK fully tracked" when asked
// directly. So:
//   - type === 'bk_demand' (BK demanding from Store): dispatching this is now a plain
//     DISPATCH out of 'store' only — Store's tracked balance decrements, same shape as
//     dispatching to any real outlet (dest_outlet_id='bk' for the audit trail). No
//     ledger row for BK's side, because BK isn't tracked, same as no outlet ever gets one.
//   - type === 'manual' (BK fulfilling a real outlet's demand): this is BK's OWN
//     dispatch, out of a location this ledger doesn't track. Nothing to decrement here
//     any more than there's something to decrement when an outlet consumes what it was
//     sent — this is now fully out of scope, matching outlets.
//   - Any other type value is left alone, as before.
// The historical stock_movements rows this hook wrote for 'bk' before this change
// (real dispatches, a Stage 1 opening snapshot) are NOT deleted — they're left as
// history, just no longer added to. store_stock_balances for location='bk' should be
// treated as stale/informational only from here on, not a live number.
//
// Item mapping: dispatch_items/items_units keys are demand_item_id values (the same ids
// DEMAND_SECTIONS in App.jsx uses). Stage 1's items.demand_item_id column already
// bridges these to the new items.id — same join key inventory.js's own audit code uses
// for the old system. An item with no items row, or a unit with no recorded conversion
// factor, is skipped (logged, not guessed) rather than blocking the real dispatch.
//
// Every call is wrapped by the caller in its own try/catch and must never throw back
// into the dispatch route — a failure here must not block or roll back a real dispatch
// that already left the building.
const supabase = require("../supabase");
const { rebuildStockBalances } = require("./store");

// Returns a small summary object (reason it no-op'd, or what it wrote) — mainly so the
// caller/logs can tell "nothing to do" apart from "silently failed"; not relied on by
// any real logic.
async function applyDispatchStockOut({ demandId, type, outletId, dispatchItems, itemsUnits, actorName }) {
  if (!dispatchItems || !Object.keys(dispatchItems).length) return { skipped: "no dispatch_items" };
  // 'manual' (BK -> outlet) is no longer tracked at all — neither side is a tracked
  // location. Only 'bk_demand' (Store -> BK) still touches the ledger, and only on
  // Store's side.
  if (type !== "bk_demand") return { skipped: `type "${type}" out of scope` };

  const demandItemIds = Object.keys(dispatchItems).filter((k) => Number(dispatchItems[k]) > 0);
  if (!demandItemIds.length) return { skipped: "no positive-qty items" };

  const { data: items, error: itemsErr } = await supabase.from("items").select("id, base_unit, demand_item_id").in("demand_item_id", demandItemIds);
  if (itemsErr) { console.error("[stockOutHooks] items lookup failed:", itemsErr.message); return { error: itemsErr.message }; }
  const itemByDemandId = new Map((items || []).map((i) => [i.demand_item_id, i]));

  const neededItemIds = (items || []).map((i) => i.id);
  const { data: unitRows } = neededItemIds.length ? await supabase.from("item_units").select("item_id, unit, factor").in("item_id", neededItemIds) : { data: [] };
  const factorMap = new Map((unitRows || []).map((u) => [`${u.item_id}::${u.unit}`, Number(u.factor)]));

  const movements = [];
  const affected = new Set(); // "item_id::location_id"
  const skippedItems = [];

  for (const demandItemId of demandItemIds) {
    const item = itemByDemandId.get(demandItemId);
    if (!item) { skippedItems.push(`${demandItemId}: no items row`); continue; }
    const unit = (itemsUnits && itemsUnits[demandItemId]) || item.base_unit;
    const factor = unit === item.base_unit ? 1 : factorMap.get(`${item.id}::${unit}`);
    if (!factor) { skippedItems.push(`${item.id}: no factor for unit "${unit}"`); continue; }
    const qtyEntered = Number(dispatchItems[demandItemId]);
    const qtyBase = qtyEntered * factor;
    if (!(qtyBase > 0)) continue;

    movements.push({ item_id: item.id, location_id: "store", movement_type: "DISPATCH", qty_delta: -qtyBase, qty_entered: qtyEntered, unit_entered: unit, dest_outlet_id: "bk", source_type: "dispatch", source_id: demandId, idempotency_key: `dispatch:${demandId}:${item.id}`, created_by: actorName || "system" });
    affected.add(`${item.id}::store`);
  }

  if (!movements.length) return { skipped: "no items mapped to the new ledger", skippedItems };
  const { error: mvErr } = await supabase.from("stock_movements").upsert(movements, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (mvErr) { console.error(`[stockOutHooks] demand ${demandId}: failed to write stock_movements:`, mvErr.message); return { error: mvErr.message, movements }; }

  for (const key of affected) {
    const [itemId, locationId] = key.split("::");
    try { await rebuildStockBalances({ itemId, locationId }); } catch (e) { console.error(`[stockOutHooks] demand ${demandId}: balance rebuild failed for ${key}:`, e.message); }
  }
  return { wrote: movements.length, movements, skippedItems };
}

module.exports = { applyDispatchStockOut };
