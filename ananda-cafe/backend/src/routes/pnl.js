const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");

// Get P&L for date range
router.get("/", async (req, res) => {
  const { outlet_id, start_date, end_date, date } = req.query;
  let query = supabase.from("daily_pnl").select("*").order("date", { ascending: false });
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  if (date) query = query.eq("date", date);
  if (start_date) query = query.gte("date", start_date);
  if (end_date) query = query.lte("date", end_date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Upsert daily P&L entry
router.post("/", async (req, res) => {
  const { outlet_id, date, ...fields } = req.body;
  const { data, error } = await supabase
    .from("daily_pnl")
    .upsert({ outlet_id, date, ...fields }, { onConflict: "outlet_id,date" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Summary across all outlets for a date
router.get("/summary", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || todayIST();
  const { data, error } = await supabase
    .from("daily_pnl")
    .select("*")
    .eq("date", targetDate);
  if (error) return res.status(500).json({ error: error.message });

  // Aggregate
  const totals = {};
  const fields = [
    "total_sale", "delivery_sale", "online_commission", "effective_sale",
    "rent", "salary", "raw_material", "vegetable", "dairy", "disposal",
    "gas", "electricity", "water_tanker", "transport", "staff_room_rent",
    "staff_room_elec", "staff_welfare", "mala", "other_expense",
    "maintenance", "new_purchase", "vendor_payments", "zomato_ads",
    "swiggy_ads", "gst", "profit_tax",
  ];
  fields.forEach((f) => { totals[f] = data.reduce((s, row) => s + (Number(row[f]) || 0), 0); });

  const totalExpense = fields.slice(4).reduce((s, f) => s + totals[f], 0);
  const netPnl = totals.effective_sale - totalExpense;

  res.json({
    date: targetDate,
    outlets: data,
    totals,
    net_expense: totalExpense,
    net_pnl: netPnl,
    pnl_pct: totals.effective_sale > 0 ? (netPnl / totals.effective_sale * 100) : 0,
  });
});

module.exports = router;
