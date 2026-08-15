// stockOutHooks.js — Store Inventory Module Stage 3: auto stock-out, called from the
// EXISTING dispatch action (PATCH /api/orders/:id/dispatch in salesRoutes.js) rather
// than reinventing a parallel dispatch flow. salesRoutes.js only gains one extra
// function call at the end of that route — this file holds all the new logic.
//
// Scope, deliberately: only the DISPATCH action is hooked up here. Wastage
// (demands.type === 'wastage') is NOT — real wastage rows can be created/edited through
// several different existing routes (POST /demands, PATCH /demands/:id,
// PATCH /demands/:id/finalize, the /qty-edit wastage branch), and only the rare
// outlet_id==='bk' case would even have a tracked location to decrement. Wiring all of
// those consistently (including edits-after-submission changing a qty already applied
// to the ledger) is a real, separate piece of work, not something to bolt on here as an
// afterthought — 'WASTAGE' is already a valid stock_movements.movement_type (added in
// Stage 1) for whenever that's built.
//
// Direction logic, from the already-confirmed demands table shape:
//   - type === 'bk_demand' (BK demanding from the central Store, via BKDemandForm):
//     dispatching this fulfils Store -> BK. Both sides are tracked locations, so this is
//     a TRANSFER: a decrement at 'store' and an increment at 'bk', two ledger rows.
//   - type === 'manual' (a real outlet's regular demand on BK): dispatching this is
//     BK -> outlet. The outlet is NOT a tracked location (decided back in Stage 1's
//     planning), so this is a plain DISPATCH: decrement at 'bk' only, with
//     dest_outlet_id recorded for reporting/audit, no ledger row for the outlet itself.
//   - Any other type value (e.g. 'photo') is left alone — not enough was confirmed about
//     what those represent to assume they mean a real stock movement.
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
  if (type !== "manual" && type !== "bk_demand") return { skipped: `type "${type}" out of scope` };

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
    const qtyBase = Number(dispatchItems[demandItemId]) * factor;
    if (!(qtyBase > 0)) continue;

    if (type === "bk_demand") {
      movements.push({ item_id: item.id, location_id: "store", movement_type: "TRANSFER", qty_delta: -qtyBase, dest_location_id: "bk", source_type: "dispatch", source_id: demandId, idempotency_key: `dispatch:${demandId}:${item.id}:out`, created_by: actorName || "system" });
      movements.push({ item_id: item.id, location_id: "bk", movement_type: "TRANSFER", qty_delta: qtyBase, source_type: "dispatch", source_id: demandId, idempotency_key: `dispatch:${demandId}:${item.id}:in`, created_by: actorName || "system" });
      affected.add(`${item.id}::store`); affected.add(`${item.id}::bk`);
    } else {
      movements.push({ item_id: item.id, location_id: "bk", movement_type: "DISPATCH", qty_delta: -qtyBase, dest_outlet_id: outletId, source_type: "dispatch", source_id: demandId, idempotency_key: `dispatch:${demandId}:${item.id}`, created_by: actorName || "system" });
      affected.add(`${item.id}::bk`);
    }
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
