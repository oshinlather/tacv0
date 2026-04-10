const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");

router.get("/", async (req, res) => {
  const { date, issue_to, limit = 20 } = req.query;
  let query = supabase.from("issuances").select("*, issuance_photos(*)").order("submitted_at", { ascending: false }).limit(limit);
  if (date) query = query.eq("date", date);
  if (issue_to) query = query.eq("issue_to", issue_to);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/", async (req, res) => {
  const { issue_to, note, submitted_by } = req.body;
  const { data, error } = await supabase
    .from("issuances")
    .insert({ issue_to, note, submitted_by, date: todayIST() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/:id/photos", async (req, res) => {
  const { id } = req.params;
  const { section, base64 } = req.body;
  const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const fileName = `issuances/${id}/${section}_${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from("photos").upload(fileName, buffer, { contentType: "image/jpeg" });
  if (uploadError) return res.status(500).json({ error: uploadError.message });
  const { data, error } = await supabase.from("issuance_photos").insert({ issuance_id: id, section, storage_path: fileName }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = await supabase.storage.from("photos").createSignedUrl(fileName, 86400);
  res.json({ ...data, url: urlData?.signedUrl });
});

module.exports = router;
