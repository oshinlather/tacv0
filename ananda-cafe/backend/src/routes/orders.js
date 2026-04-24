const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireRole } = require("./authGuards");

// Order management is BK/store responsibility. Owner + store_mgr.
// NOTE: Most of these routes are shadowed by salesRoutes.js (which also has guards),
// but we guard here too as defense-in-depth in case route mounting order changes.
async function gate(req, res) {
  return await requireRole(req, res, "owner", "store_mgr");
}

router.get("/", async (req, res) => {
  if (!await gate(req, res)) return;
  const { outlet_id, status, date, limit = 50 } = req.query;
  let query = supabase.from("orders").select("*, outlets(name)").order("created_at", { ascending: false }).limit(limit);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  if (status) query = query.eq("status", status);
  if (date) query = query.eq("date", date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/consolidated", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date } = req.query;
  const { data, error } = await supabase.from("orders").select("*, outlets(name)").eq("date", date).in("status", ["pending", "dispatched"]);
  if (error) return res.status(500).json({ error: error.message });
  const consolidated = {};
  (data || []).forEach((order) => {
    Object.entries(order.items || {}).forEach(([id, item]) => {
      if (!consolidated[id]) consolidated[id] = { ...item, total: 0, outlets: [] };
      consolidated[id].total += Number(item.qty) || 0;
      consolidated[id].outlets.push({ outlet: order.outlets?.name, qty: item.qty });
    });
  });
  res.json({ date, items: Object.values(consolidated) });
});

router.patch("/:id/status", async (req, res) => {
  if (!await gate(req, res)) return;
  const { id } = req.params;
  const { status, dispatch_notes } = req.body;
  const { data, error } = await supabase.from("orders").update({ status, dispatch_notes, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/dashboard-summary", async (req, res) => {
  if (!await gate(req, res)) return;
  const { date } = req.query;
  const { data, error } = await supabase.from("orders").select("status").eq("date", date);
  if (error) return res.status(500).json({ error: error.message });
  const counts = { pending: 0, dispatched: 0, received: 0 };
  (data || []).forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
  res.json({ date, counts, total: data.length });
});

module.exports = router;
