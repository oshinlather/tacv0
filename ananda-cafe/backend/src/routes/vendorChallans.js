// vendorChallans.js — Store Inventory Module Stage 2: vendor challan (delivery note) ->
// receive -> auto stock-in against the Stage 1 ledger (items/item_units/locations/
// stock_movements/store_stock_balances). Schema: 2026_08_16_store_inventory_stage2.sql.
//
// Mounted at /api/store alongside store.js (same prefix, sibling file — see that
// file's header for why they're split). Does not touch purchase_orders, purchases,
// purchase_items, inventory_movements, or inventory_stock — those keep working exactly
// as before; this is a separate, new receiving lineage against the new item master.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { gate, rebuildStockBalances } = require("./store");

// ── Vendors ──
// No real vendor entity existed anywhere in the app before this — every prior "vendor"
// reference was free text or a hardcoded category bucket. Starts empty; add via the UI.
router.get("/vendors", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data, error } = await supabase.from("vendors").select("*").eq("active", true).order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post("/vendors", async (req, res) => {
  if (!await gate(req, res)) return;
  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Vendor name is required" });
  const { data, error } = await supabase.from("vendors").insert({ name: name.trim(), phone: phone || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Challans ──
router.get("/challans", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date, from, location, status, vendor_id } = req.query;
  let query = supabase.from("vendor_challans").select("*, vendors(name)").order("challan_date", { ascending: false }).order("created_at", { ascending: false });
  if (date) query = query.eq("challan_date", date);
  if (from) query = query.gte("challan_date", from);
  if (location) query = query.eq("location_id", location);
  if (status) query = query.eq("status", status);
  if (vendor_id) query = query.eq("vendor_id", vendor_id);
  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map((c) => ({ ...c, vendor_name: c.vendors?.name || null, vendors: undefined })));
});

// GET /:id — full detail incl. items and a freshly-signed bill photo URL (never store a
// static signed URL — it expires; see store's item-units comment for the same pattern
// employees.js's KYC docs use).
router.get("/challans/:id", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: challan, error } = await supabase.from("vendor_challans").select("*, vendors(name)").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!challan) return res.status(404).json({ error: "Challan not found" });
  const { data: items, error: itemsError } = await supabase.from("vendor_challan_items").select("*, items(name, category, base_unit)").eq("challan_id", req.params.id);
  if (itemsError) return res.status(500).json({ error: itemsError.message });
  let bill_url = null;
  if (challan.bill_photo_path) {
    const { data: signed } = await supabase.storage.from("photos").createSignedUrl(challan.bill_photo_path, 86400);
    bill_url = signed?.signedUrl || null;
  }
  res.json({
    ...challan, vendor_name: challan.vendors?.name || null, vendors: undefined, bill_url,
    items: (items || []).map((i) => ({ ...i, item_name: i.items?.name, category: i.items?.category, base_unit: i.items?.base_unit, items: undefined })),
  });
});

// POST / — create a draft challan with its line items. Converts each entered qty to
// base units via item_units (the item's own known factors only — never guessed here;
// see store.js's POST /item-units for how a new factor gets added). Rejects a line
// whose unit has no recorded factor for that item instead of assuming 1:1.
router.post("/challans", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { vendor_id, vendor_name, location_id, challan_number, challan_date, notes, items, idempotency_key } = req.body;
  if (!location_id || !["store", "bk"].includes(location_id)) return res.status(400).json({ error: "location_id must be 'store' or 'bk'" });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "At least one item line is required" });

  if (idempotency_key) {
    const { data: existing } = await supabase.from("vendor_challans").select("*").eq("idempotency_key", idempotency_key).maybeSingle();
    if (existing) return res.json(existing);
  }

  // Inline "new vendor" support — the UI can send vendor_name instead of vendor_id.
  let resolvedVendorId = vendor_id || null;
  if (!resolvedVendorId && vendor_name && vendor_name.trim()) {
    const { data: v, error: vErr } = await supabase.from("vendors").insert({ name: vendor_name.trim() }).select().single();
    if (vErr) return res.status(500).json({ error: vErr.message });
    resolvedVendorId = v.id;
  }

  const itemIds = items.map((l) => l.item_id);
  const { data: itemRows, error: itemsErr } = await supabase.from("items").select("id, base_unit").in("id", itemIds);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  const { data: unitRows, error: unitsErr } = await supabase.from("item_units").select("item_id, unit, factor").in("item_id", itemIds);
  if (unitsErr) return res.status(500).json({ error: unitsErr.message });
  const itemMap = new Map((itemRows || []).map((i) => [i.id, i]));
  const unitMap = new Map((unitRows || []).map((u) => [`${u.item_id}::${u.unit}`, Number(u.factor)]));

  const lines = [];
  let total = 0;
  for (const line of items) {
    const item = itemMap.get(line.item_id);
    if (!item) return res.status(400).json({ error: `Unknown item: ${line.item_id}` });
    const unit = line.unit_entered || item.base_unit;
    const factor = unit === item.base_unit ? 1 : unitMap.get(`${line.item_id}::${unit}`);
    if (!factor) return res.status(400).json({ error: `No known conversion for ${line.item_id} in unit "${unit}" — add it via Item Units first.` });
    const qtyEntered = Number(line.qty_entered);
    if (!(qtyEntered > 0)) return res.status(400).json({ error: `Invalid quantity for ${line.item_id}` });
    const qtyBase = qtyEntered * factor;
    const unitPrice = line.unit_price != null ? Number(line.unit_price) : null;
    const lineTotal = unitPrice != null ? Number((qtyBase * unitPrice).toFixed(2)) : null;
    if (lineTotal != null) total += lineTotal;
    lines.push({ item_id: line.item_id, qty_entered: qtyEntered, unit_entered: unit, qty_base: qtyBase, unit_price: unitPrice, line_total: lineTotal });
  }

  const { data: challan, error: chErr } = await supabase.from("vendor_challans").insert({
    vendor_id: resolvedVendorId, location_id, challan_number: challan_number || null,
    challan_date: challan_date || todayIST(), notes: notes || null,
    total_amount: total || null, created_by: user.name, idempotency_key: idempotency_key || null,
  }).select().single();
  if (chErr) return res.status(500).json({ error: chErr.message });

  const { error: liErr } = await supabase.from("vendor_challan_items").insert(lines.map((l) => ({ ...l, challan_id: challan.id })));
  if (liErr) return res.status(500).json({ error: liErr.message });

  res.json(challan);
});

// PATCH /:id — edit a draft (vendor, notes, challan_number, no_bill_reason).
router.patch("/challans/:id", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: existing } = await supabase.from("vendor_challans").select("status").eq("id", req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Challan not found" });
  if (existing.status !== "draft") return res.status(400).json({ error: "Only a draft challan can be edited" });
  const { vendor_id, challan_number, notes, no_bill_reason } = req.body;
  const patch = {};
  if (vendor_id !== undefined) patch.vendor_id = vendor_id;
  if (challan_number !== undefined) patch.challan_number = challan_number;
  if (notes !== undefined) patch.notes = notes;
  if (no_bill_reason !== undefined) patch.no_bill_reason = no_bill_reason;
  const { data, error } = await supabase.from("vendor_challans").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /:id/items — Stage 5 migration: update qty_entered/unit_price on a draft's
// existing lines. Needed because ordering and pricing happen at different times, same
// as the old Order Challan flow (you place the order not knowing the exact price; the
// vendor/driver fills in what was actually bought and for how much once goods arrive,
// before Receive is pressed) — {item_id: {qty_entered?, unit_price?}}. Recomputes
// total_amount from all lines afterward. Not a general item-add/remove — that's still
// "cancel this draft, start a fresh one" (source of the note in the comment above), to
// keep the mapping from a challan to what it always claimed to represent unambiguous.
router.patch("/challans/:id/items", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: existing } = await supabase.from("vendor_challans").select("status").eq("id", req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Challan not found" });
  if (existing.status !== "draft") return res.status(400).json({ error: "Only a draft challan can be edited" });
  const { items } = req.body; // { item_id: { qty_entered?, unit_price? } }
  if (!items || !Object.keys(items).length) return res.status(400).json({ error: "items is required" });

  for (const [itemId, patch] of Object.entries(items)) {
    const linePatch = {};
    if (patch.qty_entered != null) linePatch.qty_entered = Number(patch.qty_entered);
    if (patch.unit_price != null) linePatch.unit_price = Number(patch.unit_price);
    if (!Object.keys(linePatch).length) continue;
    const { data: line } = await supabase.from("vendor_challan_items").select("qty_entered, qty_base, unit_entered").eq("challan_id", req.params.id).eq("item_id", itemId).maybeSingle();
    if (!line) continue;
    if (linePatch.qty_entered != null) {
      const factor = line.qty_entered ? Number(line.qty_base) / Number(line.qty_entered) : 1;
      linePatch.qty_base = linePatch.qty_entered * factor;
    }
    if (linePatch.unit_price != null || linePatch.qty_base != null) {
      const qtyBase = linePatch.qty_base != null ? linePatch.qty_base : line.qty_base;
      const price = linePatch.unit_price != null ? linePatch.unit_price : null;
      if (price != null) linePatch.line_total = Number((qtyBase * price).toFixed(2));
    }
    await supabase.from("vendor_challan_items").update(linePatch).eq("challan_id", req.params.id).eq("item_id", itemId);
  }

  const { data: allLines } = await supabase.from("vendor_challan_items").select("line_total").eq("challan_id", req.params.id);
  const total = (allLines || []).reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const { data, error } = await supabase.from("vendor_challans").update({ total_amount: total || null }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /:id/bill — bill photo upload, same base64-in-JSON-body + 'photos' bucket +
// storage-path-not-URL pattern purchases.js and employees.js already use.
router.post("/challans/:id/bill", async (req, res) => {
  if (!await gate(req, res)) return;
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "base64 is required" });
  const { data: existing } = await supabase.from("vendor_challans").select("status").eq("id", req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Challan not found" });
  const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const fileName = `challans/${req.params.id}/bill_${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from("photos").upload(fileName, buffer, { contentType: "image/jpeg" });
  if (uploadError) return res.status(500).json({ error: uploadError.message });
  const { data, error } = await supabase.from("vendor_challans").update({ bill_photo_path: fileName }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { data: signed } = await supabase.storage.from("photos").createSignedUrl(fileName, 86400);
  res.json({ ...data, bill_url: signed?.signedUrl || null });
});

// POST /:id/receive — the core action. Idempotent: calling it again on an already-
// received challan just returns the current state without re-applying stock movements
// (each movement's idempotency_key is unique per challan+item, so even a raw retry at
// the DB layer can't double-count).
router.post("/challans/:id/receive", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { data: challan, error } = await supabase.from("vendor_challans").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!challan) return res.status(404).json({ error: "Challan not found" });
  if (challan.status === "received") return res.json(challan); // idempotent no-op
  if (challan.status === "cancelled") return res.status(400).json({ error: "This challan was cancelled" });
  if (!challan.bill_photo_path && !challan.no_bill_reason) {
    return res.status(400).json({ error: "Upload the bill photo, or record a reason there isn't one, before receiving." });
  }

  const { data: lines, error: linesErr } = await supabase.from("vendor_challan_items").select("*").eq("challan_id", challan.id);
  if (linesErr) return res.status(500).json({ error: linesErr.message });

  const movements = lines.map((l) => ({
    item_id: l.item_id, location_id: challan.location_id, movement_type: "RECEIPT",
    qty_delta: l.qty_base, qty_entered: l.qty_entered, unit_entered: l.unit_entered,
    rate: l.unit_price, source_type: "receipt", source_id: challan.id,
    idempotency_key: `receipt:${challan.id}:${l.item_id}`, created_by: user.name,
  }));
  const { error: mvErr } = await supabase.from("stock_movements").upsert(movements, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (mvErr) return res.status(500).json({ error: mvErr.message });

  for (const itemId of new Set(lines.map((l) => l.item_id))) {
    await rebuildStockBalances({ itemId, locationId: challan.location_id });
  }

  const { data: updated, error: updErr } = await supabase.from("vendor_challans")
    .update({ status: "received", received_by: user.name, received_at: new Date().toISOString() })
    .eq("id", challan.id).select().single();
  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json(updated);
});

// POST /:id/cancel — draft only. Once received, undoing means a manual ADJUSTMENT
// movement (Stage 4 territory) — not building a reversal flow here, that's a real
// decision (does it also reverse a payment already recorded elsewhere?) this stage
// isn't scoped to make.
router.post("/challans/:id/cancel", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: existing } = await supabase.from("vendor_challans").select("status").eq("id", req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Challan not found" });
  if (existing.status !== "draft") return res.status(400).json({ error: "Only a draft challan can be cancelled" });
  const { data, error } = await supabase.from("vendor_challans").update({ status: "cancelled" }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /items/:itemId/price-history — vendor_challan_items IS the price history, no
// separate table. Last N receipts for this item across all vendors, newest first.
router.get("/items/:itemId/price-history", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data, error } = await supabase.from("vendor_challan_items")
    .select("qty_entered, unit_entered, unit_price, line_total, vendor_challans(challan_date, status, vendors(name))")
    .eq("item_id", req.params.itemId)
    .not("unit_price", "is", null)
    .order("id", { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || [])
    .filter((r) => r.vendor_challans?.status === "received")
    .map((r) => ({ date: r.vendor_challans?.challan_date, vendor_name: r.vendor_challans?.vendors?.name || null, qty_entered: r.qty_entered, unit_entered: r.unit_entered, unit_price: r.unit_price, line_total: r.line_total })));
});

module.exports = router;
