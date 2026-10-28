const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { requireAuth, ensureOutletAccess } = require("./authGuards");

// Outlet-scoped roles only ever see/write their own outlet's bill vault; owner/
// avp/store_mgr etc. may pass any outlet_id (ensureOutletAccess waves them through).
const OUTLET_SCOPED_ROLES = ["outlet_mgr", "chef", "bainmarry"];

// Attach a freshly-signed URL to each bill photo of the given purchases. Paths
// are stored; URLs are short-lived and generated per request (never persisted).
async function withSignedPhotos(purchases) {
  if (!purchases.length) return purchases;
  const ids = purchases.map((p) => p.id);
  const { data: photos } = await supabase
    .from("department_purchase_photos")
    .select("*")
    .in("purchase_id", ids)
    .order("created_at", { ascending: true });
  const byPurchase = {};
  for (const ph of photos || []) {
    const { data: signed } = await supabase.storage.from("Photos").createSignedUrl(ph.storage_path, 86400);
    (byPurchase[ph.purchase_id] ||= []).push({ id: ph.id, url: signed?.signedUrl || null });
  }
  return purchases.map((p) => ({ ...p, photos: byPurchase[p.id] || [] }));
}

// GET / — the bill vault for an outlet. Optional `q` (searches title/vendor/note)
// and `department` filter.
router.get("/", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { outlet_id, q, department } = req.query;
  if (OUTLET_SCOPED_ROLES.includes(user.role) && !outlet_id) {
    return res.status(403).json({ error: "outlet_id is required for this role" });
  }
  if (!ensureOutletAccess(user, outlet_id, res)) return;
  let query = supabase
    .from("department_purchases")
    .select("*")
    .order("purchase_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(500);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  if (department) query = query.eq("department", department);
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query = query.or(`title.ilike.${term},vendor.ilike.${term},note.ilike.${term}`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(await withSignedPhotos(data || []));
});

// POST / — log a purchase. Bill photos are uploaded separately (POST /:id/photos)
// so a purchase can be saved now and have its bill attached later.
router.post("/", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { outlet_id, department, title, amount, vendor, purchase_date, warranty_until, note } = req.body;
  if (!outlet_id) return res.status(400).json({ error: "outlet_id is required" });
  if (!department || !department.trim()) return res.status(400).json({ error: "Department is required" });
  if (!title || !title.trim()) return res.status(400).json({ error: "What was purchased is required" });
  if (!ensureOutletAccess(user, outlet_id, res)) return;
  const { data, error } = await supabase
    .from("department_purchases")
    .insert({
      outlet_id,
      department: department.trim(),
      title: title.trim(),
      amount: amount != null && amount !== "" ? Number(amount) : null,
      vendor: vendor && vendor.trim() ? vendor.trim() : null,
      purchase_date: purchase_date || todayIST(),
      warranty_until: warranty_until || null,
      note: note && note.trim() ? note.trim() : null,
      created_by: user.name || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ...data, photos: [] });
});

// POST /:id/photos — attach a bill photo (base64 JSON, same as challans/outlet photos).
router.post("/:id/photos", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { id } = req.params;
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "base64 is required" });
  const { data: purchase, error: findErr } = await supabase
    .from("department_purchases").select("outlet_id").eq("id", id).single();
  if (findErr || !purchase) return res.status(404).json({ error: "Not found" });
  if (!ensureOutletAccess(user, purchase.outlet_id, res)) return;
  const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const fileName = `department-purchases/${id}/bill_${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from("Photos").upload(fileName, buffer, { contentType: "image/jpeg" });
  if (uploadError) return res.status(500).json({ error: uploadError.message });
  const { data, error } = await supabase
    .from("department_purchase_photos").insert({ purchase_id: id, storage_path: fileName }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { data: signed } = await supabase.storage.from("Photos").createSignedUrl(fileName, 86400);
  res.json({ id: data.id, url: signed?.signedUrl || null });
});

// DELETE /:id — remove a wrongly-logged entry (photos cascade). Same outlet scope.
router.delete("/:id", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { data: purchase, error: findErr } = await supabase
    .from("department_purchases").select("outlet_id").eq("id", req.params.id).single();
  if (findErr || !purchase) return res.status(404).json({ error: "Not found" });
  if (!ensureOutletAccess(user, purchase.outlet_id, res)) return;
  const { error } = await supabase.from("department_purchases").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
