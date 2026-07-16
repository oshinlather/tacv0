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

module.exports = { creditStockIn };
