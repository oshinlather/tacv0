const express = require("express");
const router = express.Router();
const supabase = require("../supabase");

router.get("/", async (req, res) => {
  const { date, limit = 30 } = req.query;
  let query = supabase.from("purchases").select("*, purchase_items(*), purchase_photos(*)").order("submitted_at", { ascending: false }).limit(limit);
  if (date) query = query.eq("date", date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/", async (req, res) => {
  const { items, payment_mode, note, submitted_by } = req.body;
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  // Create purchase
  const { data: purchase, error } = await supabase
    .from("purchases")
    .insert({ payment_mode, total_amount: total, note, submitted_by })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Insert line items
  const lineItems = items.filter((i) => i.item_name && i.amount).map((i) => ({
    purchase_id: purchase.id,
    item_name: i.item_name,
    quantity: i.quantity || null,
    unit: i.unit || null,
    amount: Number(i.amount),
    vendor: i.vendor || null,
  }));

  if (lineItems.length > 0) {
    const { error: itemErr } = await supabase.from("purchase_items").insert(lineItems);
    if (itemErr) console.error("Error inserting purchase items:", itemErr);
  }

  // Fetch complete record
  const { data: complete } = await supabase
    .from("purchases")
    .select("*, purchase_items(*), purchase_photos(*)")
    .eq("id", purchase.id)
    .single();

  res.json(complete);
});

router.post("/:id/photos", async (req, res) => {
  const { id } = req.params;
  const { base64, label } = req.body;
  const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const fileName = `purchases/${id}/${label || "bill"}_${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from("photos").upload(fileName, buffer, { contentType: "image/jpeg" });
  if (uploadError) return res.status(500).json({ error: uploadError.message });
  const { data, error } = await supabase.from("purchase_photos").insert({ purchase_id: id, storage_path: fileName }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = await supabase.storage.from("photos").createSignedUrl(fileName, 86400);
  res.json({ ...data, url: urlData?.signedUrl });
});

// Today's purchase total (for dashboard)
router.get("/summary", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("purchases")
    .select("total_amount, payment_mode")
    .eq("date", targetDate);
  if (error) return res.status(500).json({ error: error.message });
  const total = data.reduce((s, p) => s + Number(p.total_amount), 0);
  const byMode = { cash: 0, upi: 0, credit: 0 };
  data.forEach((p) => { byMode[p.payment_mode] = (byMode[p.payment_mode] || 0) + Number(p.total_amount); });
  res.json({ date: targetDate, total, count: data.length, by_payment_mode: byMode });
});

module.exports = router;
