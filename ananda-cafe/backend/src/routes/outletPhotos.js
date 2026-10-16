// Outlet daily photo module — managers capture 4 time-bound photos per operational
// day (opening / clean / briefing / closing); the owner reviews status per outlet.
// Photos are camera-captured on the client, POSTed as base64, stored in the `Photos`
// bucket (path only in the DB), and read back via short-lived signed URLs.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireRole } = require("./authGuards");

const PHOTO_OUTLETS = ["sec23", "sec31", "sec56", "sec14", "gaursid"];
const PHOTO_TYPES = ["opening", "closing", "clean", "briefing"];
// Per-outlet opening + closing deadlines, in MINUTES from the operational day's 00:00.
// Closing runs into the next calendar morning (values > 1440): most outlets 1:30 AM
// (1530), GSID 1:00 AM (1500). Clean 10:00 AM, briefing 5:30 PM for all.
const OPENING_MIN = { sec23: 365, sec31: 425, sec56: 395, sec14: 365, gaursid: 495 }; // 6:05/7:05/6:35/6:05/8:15
const CLOSING_MIN = { gaursid: 1500 }; // GSID 1:00 AM; others 1:30 AM via the fallback below
const typeDeadlineMin = (type, outletId) =>
  type === "opening" ? (OPENING_MIN[outletId] ?? 365)
  : type === "clean" ? 600            // 10:00 AM
  : type === "briefing" ? 1050        // 5:30 PM
  : /* closing */ (CLOSING_MIN[outletId] ?? 1530); // 1:30 AM next day
// Code defaults — the baseline the owner's app_config overrides are merged onto.
const DEFAULT_TIMES = {};
PHOTO_OUTLETS.forEach((oid) => { DEFAULT_TIMES[oid] = Object.fromEntries(PHOTO_TYPES.map((t) => [t, typeDeadlineMin(t, oid)])); });

const OP_ROLL_MIN = 300; // operational day rolls at 5:00 AM (after all closings, before openings)
const istNow = () => new Date(Date.now() + 330 * 60000);
const istMinOfDay = () => { const d = istNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istToday = () => istNow().toISOString().slice(0, 10);
const shiftDay = (dateStr, n) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Current operational date — before 1:30 AM it's still the previous calendar day.
const currentOpDate = () => (istMinOfDay() < OP_ROLL_MIN ? shiftDay(istToday(), -1) : istToday());
// Minutes elapsed since the current operational day's 00:00 (spans past midnight).
const elapsedMinInOpDate = () => (istMinOfDay() < OP_ROLL_MIN ? istMinOfDay() + 1440 : istMinOfDay());

const signPath = async (path) => {
  if (!path) return null;
  const { data } = await supabase.storage.from("Photos").createSignedUrl(path, 86400);
  return data?.signedUrl || null;
};

// Owner-configurable per-outlet deadlines, stored as one JSON blob in app_config
// (key 'outlet_photo_times'). Any slot the owner hasn't overridden falls back to the
// code default, so the module works before — and regardless of — any saved config.
const getTimesConfig = async () => {
  const { data } = await supabase.from("app_config").select("value").eq("key", "outlet_photo_times").maybeSingle();
  let stored = {};
  try { stored = data?.value ? JSON.parse(data.value) : {}; } catch (e) { stored = {}; }
  const merged = {};
  PHOTO_OUTLETS.forEach((oid) => { merged[oid] = { ...DEFAULT_TIMES[oid], ...(stored[oid] || {}) }; });
  return merged;
};

// ── POST /api/outlet-photos — capture one photo (camera only, on the client).
// Body: { outlet_id, photo_type, base64, date? }. Enforces: own-outlet only (non-owner),
// current operational day only, and not past the type's deadline (hard lock).
router.post("/", async (req, res) => {
  const user = await requireRole(req, res, "owner", "outlet_mgr");
  if (!user) return;
  try {
    const { outlet_id, photo_type, base64 } = req.body;
    if (!outlet_id || !photo_type || !base64) return res.status(400).json({ error: "outlet_id, photo_type and base64 are required" });
    if (!PHOTO_TYPES.includes(photo_type)) return res.status(400).json({ error: "invalid photo_type" });
    if (!PHOTO_OUTLETS.includes(outlet_id)) return res.status(400).json({ error: "unknown outlet" });
    // A manager can only capture for their own outlet.
    if (user.role !== "owner" && user.outlet_id !== outlet_id) return res.status(403).json({ error: "You can only capture photos for your own outlet." });

    const opDate = currentOpDate();
    if (req.body.date && req.body.date !== opDate) return res.status(409).json({ error: "This photo window is for a different day." });
    const cfg = await getTimesConfig();
    const deadline = cfg[outlet_id]?.[photo_type] ?? typeDeadlineMin(photo_type, outlet_id);
    if (elapsedMinInOpDate() > deadline) return res.status(403).json({ error: "This photo window has expired for today." });

    const buffer = Buffer.from(String(base64).replace(/^data:image\/\w+;base64,/, ""), "base64");
    const fileName = `outlet-photos/${outlet_id}/${opDate}/${photo_type}_${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage.from("Photos").upload(fileName, buffer, { contentType: "image/jpeg" });
    if (upErr) return res.status(500).json({ error: upErr.message });

    // Replace any earlier capture for this slot (best-effort delete of the old object).
    const { data: prev } = await supabase.from("outlet_photos")
      .select("storage_path").eq("outlet_id", outlet_id).eq("date", opDate).eq("photo_type", photo_type).maybeSingle();
    if (prev?.storage_path && prev.storage_path !== fileName) {
      await supabase.storage.from("Photos").remove([prev.storage_path]).catch(() => {});
    }

    const { error } = await supabase.from("outlet_photos").upsert({
      outlet_id, date: opDate, photo_type, storage_path: fileName,
      captured_by: user.name || user.id, captured_at: new Date().toISOString(),
    }, { onConflict: "outlet_id,date,photo_type" });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, url: await signPath(fileName), captured_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/outlet-photos?date=&outlet_id= — captured photos for an operational
// date (defaults to the current one). Owner sees all company outlets; a manager is
// scoped to their own. Returns captured rows with signed URLs; the client derives
// per-slot done/expired/pending from the deadlines + current time.
router.get("/", async (req, res) => {
  const user = await requireRole(req, res, "owner", "outlet_mgr", "avp", "head_chef");
  if (!user) return;
  try {
    const date = req.query.date || currentOpDate();
    let outletFilter = req.query.outlet_id || null;
    if (user.role === "outlet_mgr") outletFilter = user.outlet_id; // force own outlet
    let q = supabase.from("outlet_photos").select("outlet_id, photo_type, storage_path, captured_by, captured_at").eq("date", date);
    if (outletFilter) q = q.eq("outlet_id", outletFilter);
    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const photos = await Promise.all((rows || []).map(async (r) => ({
      outlet_id: r.outlet_id, photo_type: r.photo_type,
      captured_by: r.captured_by, captured_at: r.captured_at,
      url: await signPath(r.storage_path),
    })));
    res.json({ date, op_date: currentOpDate(), photos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/outlet-photos/config — per-outlet deadlines (minutes from the op-day's
// 00:00; closing values exceed 1440 = next calendar morning). Any authed role can read.
router.get("/config", async (req, res) => {
  const user = await requireRole(req, res, "owner", "outlet_mgr", "avp", "head_chef");
  if (!user) return;
  try { res.json({ outlets: PHOTO_OUTLETS, types: PHOTO_TYPES, roll_min: OP_ROLL_MIN, times: await getTimesConfig() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/outlet-photos/config — owner edits deadlines. Body: { times: { outletId:
// { type: minutes } } }. Merged into the stored blob; unspecified slots keep their value.
router.patch("/config", async (req, res) => {
  const user = await requireRole(req, res, "owner");
  if (!user) return;
  try {
    const times = req.body && req.body.times;
    if (!times || typeof times !== "object") return res.status(400).json({ error: "times object is required" });
    const clean = {};
    for (const oid of PHOTO_OUTLETS) {
      if (!times[oid] || typeof times[oid] !== "object") continue;
      for (const type of PHOTO_TYPES) {
        const v = times[oid][type];
        if (v == null) continue;
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < 0 || n > 2000) return res.status(400).json({ error: `invalid deadline for ${oid}/${type}` });
        (clean[oid] = clean[oid] || {})[type] = n;
      }
    }
    const { data } = await supabase.from("app_config").select("value").eq("key", "outlet_photo_times").maybeSingle();
    let stored = {}; try { stored = data?.value ? JSON.parse(data.value) : {}; } catch (e) { stored = {}; }
    const merged = { ...stored };
    Object.keys(clean).forEach((oid) => { merged[oid] = { ...(stored[oid] || {}), ...clean[oid] }; });
    const { error } = await supabase.from("app_config").upsert({ key: "outlet_photo_times", value: JSON.stringify(merged) }, { onConflict: "key" });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, times: await getTimesConfig() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
