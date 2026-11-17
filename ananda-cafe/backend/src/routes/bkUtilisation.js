// bkUtilisation.js — CEO "BK Utilisation Audit": a monthly check that every raw material
// bought through Vendor Challans is accounted for by Base Kitchen. Per store item:
//
//   Purchased (received vendor challans)  vs  Dispatched raw to the 6 outlets
//                                             + Used in BK recipes
//
// "Used in BK recipes" is theoretical: each of the 15 BK-prepared items (BK_PREPARED_ITEMS,
// owner-confirmed list) dispatched to outlets in the month is broken down into its raw
// ingredients through bk_recipes / bk_recipe_ingredients. Every other item dispatched counts
// as raw material sent to outlets. What an outlet then does with what it received (outlet
// dish recipes, outlet leakage) is deliberately out of scope — this audits BK only.
//
// Deliberately ignores opening/closing stock: the owner confirmed BK/Store holds roughly the
// same raw stock at month start and end, so purchases ≈ consumption over a month.
//
// Keys everything on the Store Inventory Module item master (`items`): challan lines carry
// items.id directly, dispatch keys map via items.demand_item_id, recipe raw ids via
// raw_materials.inventory_item_id (same resolution bkProduction.js uses) with fallbacks.
//
// Access: the raw 'ceo' role only. requireAuth normalizes ceo → owner, so the raw role is
// re-read from app_users here.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireAuth } = require("./authGuards");

const OUTLET_IDS = ["sec23", "sec31", "sec56", "sec14", "elan", "gaursid"];
const TOLERANCE_PCT = 5;

// The only items Base Kitchen prepares; everything else is prepared at the outlets.
// Normalized names, matched against demand item / BK recipe names.
const BK_PREPARED_ITEMS = new Set([
  "sambhar", "red chutney", "dosa batter", "vada batter", "idli batter", "podi masala",
  "pineapple halwa", "rawa mix", "onion masala", "roasted peanuts", "roasted chana",
  "garlic paste", "sona masoori rice", "upma sooji", "rasam",
]);

const norm = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
const PIECE = new Set(["piece", "pieces", "pcs", "pc"]);
const normUnit = (u) => {
  const s = (u || "").toLowerCase().trim().replace(/\.+$/, "");
  if (PIECE.has(s)) return "pcs";
  if (["g", "gms", "gram", "grams"].includes(s)) return "gm";
  if (["l", "litre", "liter", "ltrs"].includes(s)) return "ltr";
  return s;
};
const SI = { gm: ["kg", 0.001], kg: ["gm", 1000], ml: ["ltr", 0.001], ltr: ["ml", 1000] };

async function requireCeo(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const { data } = await supabase.from("app_users").select("role").eq("id", user.id).maybeSingle();
  if (data?.role !== "ceo") { res.status(403).json({ error: "CEO only" }); return null; }
  return user;
}

// Supabase caps a select at 1000 rows.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

router.get("/", async (req, res) => {
  try {
    if (!await requireCeo(req, res)) return;
    // Required lazily: salesRoutes is a large module loaded by server.js first; this avoids a load-order dependency.
    const { BK_INGREDIENT_TO_RATE = {} } = require("./salesRoutes");
    const month = String(req.query.month || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) is required" });
    const [yy, mm] = month.split("-").map(Number);
    const nextMonth = mm === 12 ? `${yy + 1}-01` : `${yy}-${String(mm + 1).padStart(2, "0")}`;
    const monthStart = `${month}-01`, nextMonthStart = `${nextMonth}-01`;
    // IST boundaries for dispatched_at (a timestamp); challan_date is already an IST date.
    const tsStart = `${monthStart}T00:00:00+05:30`, tsEnd = `${nextMonthStart}T00:00:00+05:30`;

    const [items, itemUnits, rawMaterials, demandItems, rates, unitConversions, bkRecipes, bkIngredients, challans, demandRows] = await Promise.all([
      fetchAll(() => supabase.from("items").select("id, name, category, base_unit, demand_item_id, raw_material_id, rate_card_id").order("id")),
      fetchAll(() => supabase.from("item_units").select("item_id, unit, factor").order("item_id")),
      fetchAll(() => supabase.from("raw_materials").select("id, name, inventory_item_id").order("id")),
      fetchAll(() => supabase.from("demand_items").select("id, name, unit").order("id")),
      fetchAll(() => supabase.from("rate_card").select("id, price, unit").eq("active", true).order("id")),
      fetchAll(() => supabase.from("unit_conversions").select("item_id, unit_type, qty, base_unit").order("item_id")),
      fetchAll(() => supabase.from("bk_recipes").select("*").order("id")),
      fetchAll(() => supabase.from("bk_recipe_ingredients").select("recipe_id, raw_material_id, qty").order("recipe_id")),
      fetchAll(() => supabase.from("vendor_challans").select("id, challan_date").eq("status", "received")
        .gte("challan_date", monthStart).lt("challan_date", nextMonthStart).order("id")),
      fetchAll(() => supabase.from("demands").select("outlet_id, items, items_units, dispatch_items")
        .eq("type", "manual").eq("status", "fulfilled").in("outlet_id", OUTLET_IDS)
        .gte("dispatched_at", tsStart).lt("dispatched_at", tsEnd).order("dispatched_at")),
    ]);
    const challanIds = challans.map((c) => c.id);
    const lines = [];
    for (const ids of chunk(challanIds, 200)) {
      lines.push(...await fetchAll(() => supabase.from("vendor_challan_items").select("challan_id, item_id, qty_base, line_total, unit_price").in("challan_id", ids).order("id")));
    }

    // ── Lookups ──
    const itemById = new Map(items.map((i) => [i.id, i]));
    const itemByDemandId = new Map(items.filter((i) => i.demand_item_id).map((i) => [i.demand_item_id, i]));
    const itemByRawId = new Map(items.filter((i) => i.raw_material_id).map((i) => [i.raw_material_id, i]));
    const itemByRateId = new Map(items.filter((i) => i.rate_card_id).map((i) => [i.rate_card_id, i]));
    const itemByName = new Map(items.map((i) => [norm(i.name), i]));
    const rawById = new Map(rawMaterials.map((r) => [r.id, r]));
    const demandById = new Map(demandItems.map((d) => [d.id, d]));
    const rateById = new Map(rates.map((r) => [r.id, r]));
    const factorMap = new Map(itemUnits.map((u) => [`${u.item_id}::${normUnit(u.unit)}`, Number(u.factor)]));
    const convByItem = new Map(unitConversions.map((c) => [c.item_id, c]));
    const recipeById = new Map(bkRecipes.map((r) => [r.id, r]));
    const recipeByName = new Map(bkRecipes.filter((r) => r.active !== false).map((r) => [norm(r.name), r]));
    const ingByRecipe = new Map();
    bkIngredients.forEach((i) => { if (!ingByRecipe.has(i.recipe_id)) ingByRecipe.set(i.recipe_id, []); ingByRecipe.get(i.recipe_id).push(i); });

    // qty in `unit` → item's base unit, or null if no conversion is known (reported, not guessed).
    const toBase = (item, unit) => {
      const f = normUnit(unit), b = normUnit(item.base_unit);
      if (!f || f === b) return 1;
      const fac = factorMap.get(`${item.id}::${f}`);
      if (fac) return fac;
      if (SI[f] && SI[f][0] === b) return SI[f][1];
      return null;
    };
    // qty of a BK item dispatched in `unit` → its recipe's yield unit.
    const toYield = (demandId, recipe, unit) => {
      const f = normUnit(unit), y = normUnit(recipe.yield_unit || "Kg");
      if (!f || f === y) return 1;
      for (const key of [demandId, recipe.id]) {
        const c = convByItem.get(key);
        if (c && normUnit(c.unit_type) === f && normUnit(c.base_unit) === y) return Number(c.qty) || null;
      }
      const outItem = itemById.get(`food_${recipe.id}`) || itemByDemandId.get(demandId);
      if (outItem && normUnit(outItem.base_unit) === y) { const fac = factorMap.get(`${outItem.id}::${f}`); if (fac) return fac; }
      if (SI[f] && SI[f][0] === y) return SI[f][1];
      return null;
    };
    // Recipe raw_material_id → items row.
    const itemForRaw = (rawId) => {
      const raw = rawById.get(rawId);
      if (raw?.inventory_item_id && itemById.has(raw.inventory_item_id)) return itemById.get(raw.inventory_item_id);
      if (itemById.has(rawId)) return itemById.get(rawId);
      if (itemByRawId.has(rawId)) return itemByRawId.get(rawId);
      const mappedRate = BK_INGREDIENT_TO_RATE[rawId];
      if (mappedRate && (itemByRateId.has(mappedRate) || itemByDemandId.has(mappedRate))) return itemByRateId.get(mappedRate) || itemByDemandId.get(mappedRate);
      const stripped = rawId.replace(/_raw$/, "");
      const hit = itemById.get(stripped) || itemByRateId.get(stripped) || itemByDemandId.get(stripped);
      if (hit) return hit;
      return itemByName.get(norm(raw?.name || "")) || itemByName.get(norm(stripped.replace(/_/g, " "))) || null;
    };

    const rows = new Map();
    const row = (item) => {
      if (!rows.has(item.id)) rows.set(item.id, { item, purchased: 0, spend: 0, priced_qty: 0, dispatched: 0, recipe_use: 0, outlet_breakdown: {}, recipe_breakdown: {}, unit_issues: new Set() });
      return rows.get(item.id);
    };

    // 1. Purchased — received vendor challan lines, qty already in base unit.
    lines.forEach((l) => {
      const item = itemById.get(l.item_id);
      const q = Number(l.qty_base) || 0;
      if (!item || q <= 0) return;
      const r = row(item);
      r.purchased += q;
      const total = l.line_total != null ? Number(l.line_total) : (l.unit_price != null ? Number(l.unit_price) * q : null);
      if (total != null && total > 0) { r.spend += total; r.priced_qty += q; }
    });

    // 2 + 3. Dispatched to the 6 outlets: BK-prepared items become production; the rest is raw dispatch.
    const production = new Map(); // recipe id → { recipe, qty, by_outlet, unit_issue }
    const bkWithoutRecipe = new Map();
    const notTracked = new Map();
    demandRows.forEach((d) => {
      const entries = d.dispatch_items || d.items || {};
      Object.entries(entries).forEach(([demandId, rawQty]) => {
        const q = Number(rawQty) || 0;
        if (q <= 0) return;
        const demand = demandById.get(demandId);
        const unit = (d.items_units || {})[demandId] || demand?.unit;
        const name = norm(demand?.name || recipeById.get(demandId)?.name || "");
        if (BK_PREPARED_ITEMS.has(name)) {
          const recipe = recipeByName.get(name) || recipeById.get(demandId);
          if (recipe) {
            const p = production.get(recipe.id) || { recipe, qty: 0, by_outlet: {}, unit_issue: null };
            production.set(recipe.id, p);
            const f = toYield(demandId, recipe, unit);
            if (f == null) { p.unit_issue = `${unit} → ${recipe.yield_unit || "Kg"}`; return; }
            p.qty += q * f;
            p.by_outlet[d.outlet_id] = (p.by_outlet[d.outlet_id] || 0) + q * f;
            return;
          }
          // BK item with no recipe: if Store tracks it as an item, count it 1:1 as raw dispatch.
          bkWithoutRecipe.set(demandId, { id: demandId, name: demand?.name || demandId, counted_as_raw: itemByDemandId.has(demandId) });
        }
        const item = itemByDemandId.get(demandId);
        if (!item) { if (!BK_PREPARED_ITEMS.has(name)) notTracked.set(demandId, demand?.name || demandId); return; }
        const r = row(item);
        const f = toBase(item, unit);
        if (f == null) { r.unit_issues.add(`${unit} → ${item.base_unit}`); return; }
        r.dispatched += q * f;
        r.outlet_breakdown[d.outlet_id] = (r.outlet_breakdown[d.outlet_id] || 0) + q * f;
      });
    });

    // Explode production into raw ingredients. Ingredient qty is per batch, in the
    // ingredient item's base unit (bk_recipe_ingredients has no unit column). A recipe
    // ingredient that is itself another BK recipe is exploded recursively.
    const unmapped = new Map();
    const explode = (recipe, qty, topName, visited) => {
      const yieldQty = Number(recipe.yield_qty) || 0;
      if (yieldQty <= 0 || visited.has(recipe.id)) return;
      const next = new Set(visited); next.add(recipe.id);
      const batches = qty / yieldQty;
      (ingByRecipe.get(recipe.id) || []).forEach((ing) => {
        const ingQty = (Number(ing.qty) || 0) * batches;
        if (ingQty <= 0) return;
        const item = itemForRaw(ing.raw_material_id);
        if (!item) {
          const nested = recipeById.get(ing.raw_material_id);
          if (nested && nested.id !== recipe.id) { explode(nested, ingQty, topName, next); return; }
          if (!unmapped.has(ing.raw_material_id)) unmapped.set(ing.raw_material_id, new Set());
          unmapped.get(ing.raw_material_id).add(recipe.name || recipe.id);
          return;
        }
        const r = row(item);
        r.recipe_use += ingQty;
        r.recipe_breakdown[topName] = (r.recipe_breakdown[topName] || 0) + ingQty;
      });
    };
    production.forEach((p) => explode(p.recipe, p.qty, p.recipe.name || p.recipe.id, new Set()));

    // ── Result ──
    const round = (n) => Math.round(n * 1000) / 1000;
    const roundMap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]).sort((a, b) => b[1] - a[1]));
    const out = [...rows.values()].map((r) => {
      const { item } = r;
      const used = r.dispatched + r.recipe_use;
      const gap = r.purchased - used;
      const base = Math.max(r.purchased, used);
      const gapPct = base > 0 ? (gap / base) * 100 : 0;
      // Price per base unit: this month's average challan price, else the rate card when its unit matches.
      const rc = item.rate_card_id ? rateById.get(item.rate_card_id) : null;
      const rate = r.priced_qty > 0 ? r.spend / r.priced_qty
        : (rc && normUnit(rc.unit) === normUnit(item.base_unit) ? Number(rc.price) : null);
      let status = "ok";
      if (r.purchased <= 0 && used > 0) status = "not_purchased";
      else if (r.purchased > 0 && used <= 0) status = "not_used";
      else if (gapPct > TOLERANCE_PCT) status = "excess";
      else if (gapPct < -TOLERANCE_PCT) status = "short";
      return {
        item_id: item.id, name: item.name, category: item.category || "Other", unit: item.base_unit,
        purchased: round(r.purchased), dispatched: round(r.dispatched), recipe_use: round(r.recipe_use), used: round(used),
        gap: round(gap), gap_pct: Math.round(gapPct * 10) / 10, status,
        rate: rate != null ? Math.round(rate * 100) / 100 : null,
        purchased_value: r.spend > 0 ? Math.round(r.spend) : (rate != null ? Math.round(r.purchased * rate) : null),
        used_value: rate != null ? Math.round(used * rate) : null,
        gap_value: rate != null ? Math.round(gap * rate) : null,
        outlet_breakdown: roundMap(r.outlet_breakdown), recipe_breakdown: roundMap(r.recipe_breakdown),
        unit_issues: [...r.unit_issues],
      };
    }).filter((i) => i.purchased > 0 || i.used > 0 || i.unit_issues.length)
      .sort((a, b) => Math.abs(b.gap_value ?? 0) - Math.abs(a.gap_value ?? 0) || Math.abs(b.gap_pct) - Math.abs(a.gap_pct));

    const sum = (f) => out.reduce((s, i) => s + (i[f] || 0), 0);
    res.json({
      month, tolerance_pct: TOLERANCE_PCT,
      totals: {
        items: out.length, flagged: out.filter((i) => i.status !== "ok").length,
        purchased_value: sum("purchased_value"), used_value: sum("used_value"),
        excess_value: out.filter((i) => (i.gap_value || 0) > 0).reduce((s, i) => s + i.gap_value, 0),
        short_value: out.filter((i) => (i.gap_value || 0) < 0).reduce((s, i) => s + i.gap_value, 0),
        unpriced: out.filter((i) => i.rate == null).length,
        challans: challans.length, dispatches: demandRows.length,
      },
      items: out,
      production: [...production.values()].map((p) => ({
        recipe_id: p.recipe.id, name: p.recipe.name || p.recipe.id, unit: p.recipe.yield_unit || "Kg",
        qty: round(p.qty), batches: round(p.qty / (Number(p.recipe.yield_qty) || 1)),
        by_outlet: roundMap(p.by_outlet), has_ingredients: (ingByRecipe.get(p.recipe.id) || []).length > 0, unit_issue: p.unit_issue,
      })).sort((a, b) => b.qty - a.qty),
      unmapped_ingredients: [...unmapped.entries()].map(([id, set]) => ({ id, recipes: [...set] })),
      bk_items_without_recipe: [...bkWithoutRecipe.values()],
      not_tracked_dispatch: [...notTracked.entries()].map(([id, name]) => ({ id, name })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
