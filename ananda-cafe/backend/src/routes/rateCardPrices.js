// Rate-card price ledger writer — shared by every price source (vendor challans, cash/dairy
// purchases, manual rate-card edits). Standalone (only needs supabase) so both salesRoutes
// and vendorChallans can require it without a circular dependency.
//
// Two guarantees are enforced here so no caller has to re-derive them:
//   1. Immutability — a row is stamped with an effective_date; callers here pass the date
//      the price was RECEIVED/paid (never a future date), so a new price can only ever
//      affect that day forward. Historical costing reads the ledger as-of each day, so past
//      numbers never move. (See buildCostingContext's priceAsOf.)
//   2. Unit honesty — a price is only recorded when the unit it was paid in matches the
//      rate_card unit for that item. If they differ (e.g. paid per Tin, rate card is per
//      Kg) the line is SKIPPED and returned in `skipped`, never guessed into a wrong number
//      (the app's "don't invent data" rule). Callers surface/log the skipped list.

const supabase = require("../supabase");

const normalizeName = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
// Trailing "." tolerated ("Ltr." == "Ltr"), same leniency as the costing unit compare.
const sameUnit = (a, b) => (a || "").toLowerCase().replace(/\.+$/, "").trim() === (b || "").toLowerCase().replace(/\.+$/, "").trim();

// items.id -> { rateCardId, baseUnit }. Challan lines carry a store item_id and a price per
// items.base_unit, so this is how the challan path finds the rate-card item + price unit.
async function resolveByItemIds(itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;
  const { data } = await supabase.from("items").select("id, base_unit, rate_card_id").in("id", ids);
  (data || []).forEach((r) => { out[r.id] = { rateCardId: r.rate_card_id || null, baseUnit: r.base_unit || null }; });
  return out;
}

// normalized rate_card name -> id (active only). Dairy/cold-drink purchase lines carry a
// display item_name and no id, so they resolve by name against the same names the rest of
// the costing already trusts (rate_card.name) — not a new fuzzy guess.
async function resolveByNames(names) {
  const wanted = new Set((names || []).map(normalizeName).filter(Boolean));
  const out = {};
  if (!wanted.size) return out;
  const { data } = await supabase.from("rate_card").select("id, name").eq("active", true);
  (data || []).forEach((r) => { const n = normalizeName(r.name); if (wanted.has(n)) out[n] = r.id; });
  return out;
}

// Insert one ledger row and mirror rate_card.price to the current (latest-effective) price.
// rate_card.price stays the "what is it now" value the master screen edits and the live/dish
// costing reads; the ledger is the dated source of truth for every historical calculation.
async function appendRateCardPrice({ rateCardId, effectiveDate, price, source, sourceId, createdBy }) {
  const p = Number(price);
  if (!rateCardId || !effectiveDate || !Number.isFinite(p)) return false;
  const { error } = await supabase.from("rate_card_prices").insert({
    rate_card_id: rateCardId, effective_date: effectiveDate, price: p,
    source, source_id: sourceId != null ? String(sourceId) : null, created_by: createdBy || null,
  });
  if (error) throw error;
  // Mirror rate_card.price to whatever is now the latest-effective row — usually the one we
  // just inserted; the query keeps this correct even if an earlier-dated row already exists.
  const { data: latest } = await supabase.from("rate_card_prices")
    .select("price").eq("rate_card_id", rateCardId)
    .order("effective_date", { ascending: false }).order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (latest) await supabase.from("rate_card").update({ price: Number(latest.price) }).eq("id", rateCardId);
  return true;
}

// Record a batch of paid prices. entries: [{ rateCardId, price, priceUnit, label }].
// Skips (never writes) any entry with no rate-card match, a non-positive price, or a unit
// that doesn't match the item's rate_card unit. Returns { written, skipped:[{label,reason}] }.
async function ingestPrices(entries, { effectiveDate, source, sourceId, createdBy }) {
  const skipped = [];
  const writable = [];
  (entries || []).forEach((e) => {
    if (!e || !e.rateCardId) { skipped.push({ label: e?.label || "?", reason: "no rate-card match" }); return; }
    if (!(Number.isFinite(Number(e.price)) && Number(e.price) > 0)) { skipped.push({ label: e.label || e.rateCardId, reason: "no valid price" }); return; }
    writable.push(e);
  });
  if (!writable.length) return { written: 0, skipped };

  const rcIds = [...new Set(writable.map((e) => e.rateCardId))];
  const { data: rcRows } = await supabase.from("rate_card").select("id, unit").in("id", rcIds);
  const rcUnit = {}; (rcRows || []).forEach((r) => { rcUnit[r.id] = r.unit; });

  let written = 0;
  for (const e of writable) {
    if (!sameUnit(e.priceUnit, rcUnit[e.rateCardId])) {
      skipped.push({ label: e.label || e.rateCardId, reason: `unit ${e.priceUnit || "?"} != rate card ${rcUnit[e.rateCardId] || "?"}` });
      continue;
    }
    await appendRateCardPrice({ rateCardId: e.rateCardId, effectiveDate, price: e.price, source, sourceId, createdBy });
    written++;
  }
  return { written, skipped };
}

module.exports = { appendRateCardPrice, ingestPrices, resolveByItemIds, resolveByNames, normalizeName };
