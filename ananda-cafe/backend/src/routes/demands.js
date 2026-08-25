const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { requireAuth, ensureOutletAccess, filterItemsToRoleScope } = require("./authGuards");
let sheetsHelper = null;
try { sheetsHelper = require("../googleSheets"); } catch (e) { console.log("Google Sheets module not found — sheet sync disabled"); }

// List demands for an outlet (with optional date filter).
// outlet_mgr scoped to own outlet; owner & store_mgr unrestricted.
router.get("/", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { outlet_id, date, limit = 20 } = req.query;
  if (!ensureOutletAccess(user, outlet_id, res)) return;

  let query = supabase.from("demands").select("*, demand_photos(*)").order("submitted_at", { ascending: false }).limit(limit);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  else if (user.role === "outlet_mgr") query = query.eq("outlet_id", user.outlet_id);
  if (date) query = query.eq("date", date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// NOTE: POST /demands is handled by salesRoutes.js (already guarded).
// Photo upload — owner/any logged-in user. Cannot scope by outlet easily since
// the demand already exists; DB relation implicitly limits it.
router.post("/:id/photos", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
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

// Closing stock — outlet_mgr/chef/bainmarry submit for their outlet. Merges the incoming
// items/items_units into whatever's already saved for today rather than overwriting —
// Chef (food/vegetable/masala/grocery) and Bainmarry (packaging) both save into the same
// day's row without erasing each other's contribution. `status` distinguishes a
// still-in-progress save ('draft', from Chef/Bainmarry) from the Outlet Manager's final
// submission ('submitted', also the default so plain single-manager submits behave as
// before this role split existed).
router.post("/closing-stock", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  // bk_manager/avp added — BK now submits its own closing stock the same way outlets
  // do (outlet_id='bk'), per the Stage 5 course-correction: BK isn't a live-tracked
  // ledger location, it works like an outlet (demand -> receive -> periodic count).
  if (!["owner", "store_mgr", "outlet_mgr", "chef", "bainmarry", "bk_manager", "avp"].includes(user.role)) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  let { outlet_id, items, items_units, submitted_by, date, status } = req.body;
  if (!ensureOutletAccess(user, outlet_id, res)) return;
  const effectiveDate = date || todayIST();

  // Server-side backstop matching the frontend's CATEGORY_SCOPE — items are cs_-prefixed
  // here, items_units are not.
  items = await filterItemsToRoleScope(user.role, items, "cs_");
  items_units = await filterItemsToRoleScope(user.role, items_units);

  const { data: existing } = await supabase.from("closing_stocks").select("items, items_units")
    .eq("outlet_id", outlet_id).eq("date", effectiveDate).maybeSingle();
  const mergedItems = { ...(existing?.items || {}), ...(items || {}) };
  const mergedUnits = { ...(existing?.items_units || {}), ...(items_units || {}) };

  const { data, error } = await supabase
    .from("closing_stocks")
    .upsert({
      outlet_id, date: effectiveDate, items: mergedItems,
      items_units: Object.keys(mergedUnits).length > 0 ? mergedUnits : null,
      submitted_by, submitted_at: new Date().toISOString(),
      status: status || "submitted",
    }, { onConflict: "outlet_id,date" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Write to Google Sheet (non-blocking)
  if (sheetsHelper) sheetsHelper.writeToSheet(supabase, outlet_id, "closing", submitted_by, { date: data.date }, mergedItems).catch(() => {});
  res.json(data);
});

router.get("/closing-stock", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { outlet_id, date } = req.query;
  if (!ensureOutletAccess(user, outlet_id, res)) return;

  let query = supabase.from("closing_stocks").select("*").order("date", { ascending: false }).limit(30);
  if (outlet_id) query = query.eq("outlet_id", outlet_id);
  else if (user.role === "outlet_mgr") query = query.eq("outlet_id", user.outlet_id);
  if (date) query = query.eq("date", date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
