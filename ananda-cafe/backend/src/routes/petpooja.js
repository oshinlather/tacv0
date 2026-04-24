const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireOwner } = require("./authGuards");

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
  const targetDate = date || new Date().toISOString().split("T")[0];

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

module.exports = router;
