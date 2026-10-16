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
const normUnit = (s) => (s || "").toLowerCase().replace(/\.+$/, "").trim();
const sameUnit = (a, b) => normUnit(a) === normUnit(b);

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

// Gm<->Kg price bridge (the one universal SI pair the app uses). Returns the multiplier that
// turns a per-`fromU` price into a per-`toU` price, or null if the pair isn't Gm/Kg. A price
// per Gm is 1000x cheaper than per Kg, so Gm->Kg multiplies by 1000 (and Kg->Gm by 1/1000).
function siPriceFactor(fromU, toU) {
  const f = normUnit(fromU), t = normUnit(toU);
  if (f === t) return 1;
  if (f === "gm" && t === "kg") return 1000;
  if (f === "kg" && t === "gm") return 1 / 1000;
  return null;
}

// Convert a paid price (per `priceUnit`) into a price per the rate_card's own unit, using the
// configured unit_conversions for that rate-card item (NOT a guess — only factors the owner
// has recorded). e.g. paid ₹2300/Tin + conversion "1 Tin = 15 Ltr" -> ₹153.33/Ltr when the
// rate card is per Ltr. Falls through a Gm<->Kg step when the conversion's base_unit and the
// rate_card unit are the same quantity in different SI scale (e.g. "1 Pkt = 200 Gm" priced
// into a per-Kg rate card). Returns null when no configured bridge exists -> caller skips.
function bridgePriceToRcUnit(price, priceUnit, rcUnit, convsForItem) {
  if (sameUnit(priceUnit, rcUnit)) return price;
  const conv = (convsForItem || []).find((c) => sameUnit(c.unit_type, priceUnit));
  if (conv && Number(conv.qty) > 0) {
    const perConvBase = price / Number(conv.qty); // 1 priceUnit = qty * conv.base_unit
    if (sameUnit(conv.base_unit, rcUnit)) return perConvBase;
    const si = siPriceFactor(conv.base_unit, rcUnit);
    if (si != null) return perConvBase * si;
  }
  // Direct SI bridge (no conversion row needed) e.g. paid per Gm, rate card per Kg.
  const siDirect = siPriceFactor(priceUnit, rcUnit);
  if (siDirect != null) return price * siDirect;
  return null;
}

// Record a batch of paid prices. entries: [{ rateCardId, price, priceUnit, label }].
// Skips (never writes) any entry with no rate-card match or a non-positive price. When the paid
// unit differs from the rate_card unit it is CONVERTED via the item's unit_conversions (or a
// Gm/Kg SI step); only a unit with no configured conversion is skipped (unit-honesty preserved:
// converted via owner-recorded factors, never guessed). Returns { written, skipped:[{label,reason}] }.
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
  // unit_conversions is keyed by the rate_card item id (its own base_unit is the conversion target).
  const { data: convRows } = await supabase.from("unit_conversions").select("item_id, unit_type, qty, base_unit").in("item_id", rcIds).eq("active", true);
  const convByItem = {}; (convRows || []).forEach((c) => { (convByItem[c.item_id] = convByItem[c.item_id] || []).push(c); });

  let written = 0;
  for (const e of writable) {
    const rcU = rcUnit[e.rateCardId];
    const priced = bridgePriceToRcUnit(Number(e.price), e.priceUnit, rcU, convByItem[e.rateCardId]);
    if (priced == null) {
      skipped.push({ label: e.label || e.rateCardId, reason: `unit ${e.priceUnit || "?"} != rate card ${rcU || "?"} (no conversion recorded)` });
      continue;
    }
    await appendRateCardPrice({ rateCardId: e.rateCardId, effectiveDate, price: Number(priced.toFixed(4)), source, sourceId, createdBy });
    written++;
  }
  return { written, skipped };
}

// Undoes appendRateCardPrice's write when its source document (a vendor challan, a legacy
// order) gets deleted as a duplicate — removes the ledger row(s) that document created, then
// re-mirrors rate_card.price to whatever is now the latest-effective row per affected item
// (never left stale at the deleted price). If nothing's left for an item (only happens if
// its 'seed' row was somehow also removed, which nothing here does), rate_card.price is left
// untouched rather than zeroed — a missing ledger is not the same as "this item is free".
async function removeRateCardPricesBySource(source, sourceId) {
  const { data: rows, error } = await supabase.from("rate_card_prices")
    .select("id, rate_card_id").eq("source", source).eq("source_id", String(sourceId));
  if (error) throw error;
  if (!rows || !rows.length) return { removed: 0 };
  const rateCardIds = [...new Set(rows.map((r) => r.rate_card_id))];
  const { error: delErr } = await supabase.from("rate_card_prices").delete().eq("source", source).eq("source_id", String(sourceId));
  if (delErr) throw delErr;
  for (const rateCardId of rateCardIds) {
    const { data: latest } = await supabase.from("rate_card_prices")
      .select("price").eq("rate_card_id", rateCardId)
      .order("effective_date", { ascending: false }).order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    if (latest) await supabase.from("rate_card").update({ price: Number(latest.price) }).eq("id", rateCardId);
  }
  return { removed: rows.length };
}

module.exports = { appendRateCardPrice, ingestPrices, resolveByItemIds, resolveByNames, normalizeName, removeRateCardPricesBySource };
