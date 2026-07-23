const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireAuth, requireOwner } = require("./authGuards");
const { todayIST } = require("../helpers");

// PetPooja API config
const PETPOOJA_API_KEY = process.env.PETPOOJA_API_KEY;
const RESTAURANT_IDS = (process.env.PETPOOJA_RESTAURANT_IDS || "").split(",").filter(Boolean);

// Manual trigger to sync today's sales from PetPooja — owner only
router.post("/sync", async (req, res) => {
  if (!await requireOwner(req, res)) return;
  if (!PETPOOJA_API_KEY) {
    return res.status(400).json({ error: "PetPooja API key not configured. Contact your PetPooja account manager to get API access." });
  }

  const { date } = req.body;
  const targetDate = date || todayIST();

  // TODO: Replace with actual PetPooja API call when you have the keys
  res.json({
    message: "PetPooja sync placeholder — configure API keys to enable",
    date: targetDate,
    status: "pending_configuration",
    instructions: [
      "1. Call PetPooja support and ask for API access",
      "2. They will give you API key and restaurant IDs",
      "3. Add PETPOOJA_API_KEY and PETPOOJA_RESTAURANT_IDS to your .env",
      "4. This endpoint will then auto-fetch daily sales data",
    ],
  });
});

// Get sync status — owner only
router.get("/status", async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const configured = !!PETPOOJA_API_KEY;
  const { data: lastSync } = await supabase
    .from("petpooja_sync")
    .select("*")
    .order("synced_at", { ascending: false })
    .limit(1)
    .single();

  res.json({
    configured,
    restaurant_count: RESTAURANT_IDS.length,
    last_sync: lastSync?.synced_at || null,
  });
});

// ─── Daily Review & Rating Summary (Zomato/Swiggy) ──────────────────────────
// Sourced from PetPooja CRM > Feedback > Ratings & Reviews (per outlet/platform)
// and Reports > Order Report: Sub-Order Wise (total orders per outlet/platform).
// Scraped by the "petpooja-daily-review-summary" scheduled task each morning
// (or backfilled manually), then upserted here. Dashboard's Reviews tab reads
// via GET, keyed off istDateAgo(1) by default.

// GET /api/petpooja/reviews/daily?date=YYYY-MM-DD — any authenticated user
router.get("/reviews/daily", async (req, res) => {
  if (!await requireAuth(req, res)) return;
  const date = req.query.date || todayIST();
  const { data, error } = await supabase
    .from("daily_review_summary")
    .select("*")
    .eq("date", date)
    .order("outlet_id", { ascending: true })
    .order("platform", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ date, rows: data || [] });
});

// POST /api/petpooja/reviews/daily — owner only (also used by the scheduled scrape)
// Body: { date: "YYYY-MM-DD", rows: [{ outlet_id, platform, total_orders, num_reviews, avg_rating, remarks }] }
router.post("/reviews/daily", async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { date, rows } = req.body;
  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "date and non-empty rows[] required" });
  }
  const upsertRows = rows.map((r) => ({
    date,
    outlet_id: r.outlet_id,
    platform: r.platform,
    total_orders: r.total_orders ?? null,
    num_reviews: r.num_reviews ?? 0,
    avg_rating: r.avg_rating ?? null,
    remarks: r.remarks ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { data, error } = await supabase
    .from("daily_review_summary")
    .upsert(upsertRows, { onConflict: "date,outlet_id,platform" })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: `Upserted ${data.length} rows for ${date}`, rows: data });
});

module.exports = router;
