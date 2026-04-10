const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");

// List demands for an outlet (with optional date filter)
router.get("/", async (req, res) => {
  const { outlet_id, date, limit = 20 } = req.query;
  let query = supabase.from("demands").select("*, demand_photos(*)").order("submitted_at", { ascending: false }).limit(limit);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  if (date) query = query.eq("date", date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Create demand (manual)
router.post("/", async (req, res) => {
  const { outlet_id, type, items, note, submitted_by } = req.body;
  const { data, error } = await supabase
    .from("demands")
    .insert({ outlet_id, type, items: items || {}, note, submitted_by, date: todayIST() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Upload demand photo (base64)
router.post("/:id/photos", async (req, res) => {
  const { id } = req.params;
  const { section, base64 } = req.body;

  // Decode base64 and upload to Supabase Storage
  const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const fileName = `demands/${id}/${section}_${Date.now()}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from("photos")
    .upload(fileName, buffer, { contentType: "image/jpeg" });
  if (uploadError) return res.status(500).json({ error: uploadError.message });

  // Save reference
  const { data, error } = await supabase
    .from("demand_photos")
    .insert({ demand_id: id, section, storage_path: fileName })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Get signed URL
  const { data: urlData } = await supabase.storage.from("photos").createSignedUrl(fileName, 86400);
  res.json({ ...data, url: urlData?.signedUrl });
});

// Closing stock
router.post("/closing-stock", async (req, res) => {
  const { outlet_id, items, submitted_by } = req.body;
  const { data, error } = await supabase
    .from("closing_stocks")
    .upsert({ outlet_id, date: todayIST(), items, submitted_by }, { onConflict: "outlet_id,date" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/closing-stock", async (req, res) => {
  const { outlet_id, date } = req.query;
  let query = supabase.from("closing_stocks").select("*").order("date", { ascending: false }).limit(30);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  if (date) query = query.eq("date", date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
