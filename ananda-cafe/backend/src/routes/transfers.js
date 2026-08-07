// Inter-outlet stock transfers — an outlet manager sends stock directly to another
// outlet when short (bypassing Base Kitchen), the receiving outlet confirms what
// actually arrived. Two-step, mirroring demands' dispatch/receive flow. Only a
// 'confirmed' transfer (received_items set) counts toward either outlet's
// consumed-material math — see computeStockUsageForDate in salesRoutes.js, which reads
// this table directly.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireAuth, ensureOutletAccess } = require("./authGuards");

const OWN_OUTLET_IDS = new Set(["sec23", "sec31", "sec56", "sec14"]);

// GET /?outlet=&date=&status= — list transfers touching an outlet (either direction),
// for the Send/Incoming screens and any history view.
router.get("/", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { outlet, date, status } = req.query;
  if (!ensureOutletAccess(user, outlet, res)) return;
  let query = supabase.from("outlet_transfers").select("*").order("sent_at", { ascending: false });
  if (outlet) query = query.or(`from_outlet_id.eq.${outlet},to_outlet_id.eq.${outlet}`);
  if (date) query = query.eq("date", date);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST / — sender logs a transfer (status starts 'pending', doesn't affect any audit
// numbers until the receiver confirms).
router.post("/", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { from_outlet_id, to_outlet_id, date, items, items_units, note } = req.body;
  if (!from_outlet_id || !to_outlet_id || !date || !items || Object.keys(items).length === 0) {
    return res.status(400).json({ error: "from_outlet_id, to_outlet_id, date, and items are required" });
  }
  if (from_outlet_id === to_outlet_id) return res.status(400).json({ error: "Cannot transfer to the same outlet" });
  if (!OWN_OUTLET_IDS.has(from_outlet_id) || !OWN_OUTLET_IDS.has(to_outlet_id)) {
    return res.status(400).json({ error: "Transfers are only between company-owned outlets" });
  }
  if (!ensureOutletAccess(user, from_outlet_id, res)) return;
  const { data, error } = await supabase.from("outlet_transfers").insert({
    from_outlet_id, to_outlet_id, date, sent_items: items, sent_items_units: items_units || {},
    note: note || null, sent_by: user.name, status: "pending",
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /:id/confirm — receiver confirms actual qty received (defaults to the sender's
// claim if the frontend just echoes sent_items back unmodified). This is what flips the
// transfer into counting toward both outlets' consumed-material formula.
router.patch("/:id/confirm", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { data: transfer, error: findErr } = await supabase.from("outlet_transfers").select("to_outlet_id, status").eq("id", req.params.id).single();
  if (findErr || !transfer) return res.status(404).json({ error: "Not found" });
  if (!ensureOutletAccess(user, transfer.to_outlet_id, res)) return;
  if (transfer.status !== "pending") return res.status(400).json({ error: `Transfer already ${transfer.status}` });
  const { received_items } = req.body;
  if (!received_items || Object.keys(received_items).length === 0) return res.status(400).json({ error: "received_items required" });
  const { data, error } = await supabase.from("outlet_transfers").update({
    received_items, status: "confirmed", confirmed_by: user.name, confirmed_at: new Date().toISOString(),
  }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /:id/cancel — sender can withdraw a still-pending transfer (typo/duplicate).
router.patch("/:id/cancel", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { data: transfer, error: findErr } = await supabase.from("outlet_transfers").select("from_outlet_id, status").eq("id", req.params.id).single();
  if (findErr || !transfer) return res.status(404).json({ error: "Not found" });
  if (!ensureOutletAccess(user, transfer.from_outlet_id, res)) return;
  if (transfer.status !== "pending") return res.status(400).json({ error: `Transfer already ${transfer.status}` });
  const { error } = await supabase.from("outlet_transfers").update({ status: "cancelled" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
