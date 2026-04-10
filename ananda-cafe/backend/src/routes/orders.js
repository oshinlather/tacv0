const express = require("express");
const router = express.Router();
const supabase = require("../supabase");

// Get all orders (with optional filters)
router.get("/", async (req, res) => {
  const { outlet_id, date, status, limit = 50 } = req.query;
  let query = supabase.from("demands").select("*").order("submitted_at", { ascending: false }).limit(limit);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  if (date) query = query.eq("date", date);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get today's consolidated view (all outlets combined)
router.get("/consolidated", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("demands")
    .select("*")
    .eq("date", targetDate)
    .eq("type", "manual");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ date: targetDate, orders: data });
});

// Update order status (for dispatch)
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { data, error } = await supabase
    .from("demands")
    .update({ status })
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Dashboard summary - all activity for a date
router.get("/dashboard-summary", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split("T")[0];

  // Fetch all data in parallel
  const [demands, closingStocks, issuances, purchases] = await Promise.all([
    supabase.from("demands").select("*, demand_photos(*)").eq("date", targetDate),
    supabase.from("closing_stocks").select("*").eq("date", targetDate),
    supabase.from("issuances").select("*, issuance_photos(*)").eq("date", targetDate),
    supabase.from("purchases").select("*, purchase_items(*), purchase_photos(*)").eq("date", targetDate),
  ]);

  res.json({
    date: targetDate,
    demands: demands.data || [],
    closing_stocks: closingStocks.data || [],
    issuances: issuances.data || [],
    purchases: purchases.data || [],
    summary: {
      total_demands: (demands.data || []).length,
      outlets_ordered: [...new Set((demands.data || []).map(d => d.outlet_id))].length,
      pending_dispatch: (demands.data || []).filter(d => d.status === "submitted" || d.status === "received").length,
      dispatched: (demands.data || []).filter(d => d.status === "fulfilled").length,
      total_issuances: (issuances.data || []).length,
      total_purchases: (purchases.data || []).length,
      purchase_amount: (purchases.data || []).reduce((s, p) => s + Number(p.total_amount || 0), 0),
      closing_stock_submitted: (closingStocks.data || []).length,
    }
  });
});

module.exports = router;
