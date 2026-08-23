// bkProduction.js — Store Inventory Module Stage 5: BK production stock-in. Records
// "BK cooked a batch of X" as a real ledger event — negative PRODUCTION movements for
// every raw material consumed, one positive PRODUCTION movement for the output, all at
// location='bk'. Fixes the gap found by the migration-comparison tool: BK-prepared
// items (sambhar, batters, chutneys, masalas) had no stock-in path at all before this —
// only Vendor Challans (external purchases) existed, so real dispatches drove every
// recipe output steadily negative with nothing ever putting stock back.
//
// Reads the EXISTING bk_recipes/bk_recipe_ingredients tables (untouched, same data the
// old recipe-costing screens already use) — does not duplicate recipe data into the new
// item master. Recipe id -> output item id is resolved via "food_" + recipe.id (verified
// against real data: matches 17 of 19 recipes directly and by name; the other 2 have no
// items row at all yet and are simply not offered as producible). Ingredient
// raw_material_id -> item id is resolved via raw_materials.inventory_item_id (the
// forward direction — going through items.raw_material_id instead would be lossy: two
// different raw_materials rows can point at the same item, e.g. "Peanuts (Raw)" and
// "Roasted Peanuts" both ended up mapped to one inventory_items row historically, so
// items.raw_material_id can only remember one of them). A handful of raw_materials rows
// have a stale/wrong inventory_item_id (found: roasted_chana_raw, sona_masoori_raw) —
// those ingredients are reported as unresolved rather than guessed at or silently
// dropped, which would understate what was actually consumed.
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { todayIST } = require("../helpers");
const { gate } = require("./store");

// Resolves a recipe's output item id and each ingredient's item id. Returns
// { outputItemId, ingredients: [{raw_material_id, item_id, qty_per_batch}], unresolved: [...] }.
// unresolved lists raw_material_ids that couldn't be mapped — the caller decides whether
// that's fatal (POST /production) or just informational (GET /production/recipes).
async function resolveRecipe(recipe) {
  const outputCandidateId = `food_${recipe.id}`;
  const { data: outputItem } = await supabase.from("items").select("id").eq("id", outputCandidateId).maybeSingle();

  const rawIds = (recipe.ingredients || []).map((i) => i.rawId);
  const { data: rawMaterials } = rawIds.length ? await supabase.from("raw_materials").select("id, inventory_item_id").in("id", rawIds) : { data: [] };
  const invIdByRawId = new Map((rawMaterials || []).map((r) => [r.id, r.inventory_item_id]));

  // Candidate item ids to check in one query: each raw material's mapped inventory_item_id,
  // plus the raw_material_id itself as a fallback (covers the one known case — 'potato' —
  // where the raw_materials row's inventory_item_id was never set but an items row with
  // that exact id already exists).
  const candidateIds = Array.from(new Set([...invIdByRawId.values(), ...rawIds].filter(Boolean)));
  const { data: candidateItems } = candidateIds.length ? await supabase.from("items").select("id").in("id", candidateIds) : { data: [] };
  const validItemIds = new Set((candidateItems || []).map((i) => i.id));

  const ingredients = [];
  const unresolved = [];
  (recipe.ingredients || []).forEach((ing) => {
    const mapped = invIdByRawId.get(ing.rawId);
    const itemId = mapped && validItemIds.has(mapped) ? mapped : (validItemIds.has(ing.rawId) ? ing.rawId : null);
    if (itemId) ingredients.push({ raw_material_id: ing.rawId, item_id: itemId, qty_per_batch: Number(ing.qty) });
    else unresolved.push(ing.rawId);
  });

  return { outputItemId: outputItem ? outputItem.id : null, ingredients, unresolved };
}

// GET /production/recipes — every recipe that has a matching item to produce into,
// with resolved ingredients and a fully_resolved flag so the UI can show exactly which
// recipes are ready to use and which need a raw_materials data fix first.
router.get("/production/recipes", async (req, res) => {
  if (!await gate(req, res)) return;
  const { data: recipesRaw, error } = await supabase.from("bk_recipes").select("*").eq("active", true);
  if (error) return res.status(500).json({ error: error.message });
  const { data: allIngredients } = await supabase.from("bk_recipe_ingredients").select("*");

  const results = [];
  for (const r of recipesRaw || []) {
    const recipe = { id: r.id, name: r.name, yieldQty: Number(r.yield_qty), yieldUnit: r.yield_unit, ingredients: (allIngredients || []).filter((i) => i.recipe_id === r.id).map((i) => ({ rawId: i.raw_material_id, qty: Number(i.qty) })) };
    const resolved = await resolveRecipe(recipe);
    if (!resolved.outputItemId) continue; // no items row to produce into — not offered at all
    results.push({
      recipe_id: r.id, name: r.name, yield_qty: recipe.yieldQty, yield_unit: recipe.yieldUnit,
      output_item_id: resolved.outputItemId, ingredients: resolved.ingredients, unresolved: resolved.unresolved,
      fully_resolved: resolved.unresolved.length === 0,
    });
  }
  res.json(results);
});

// POST /production — record a real production run. batches scales both the ingredient
// consumption and the yield proportionally (same ratio) unless yield_qty is given
// directly (e.g. the batch didn't come out to an exact multiple) — ingredients still
// scale with batches either way, since that's the number that reflects what was actually
// started, not adjusted after the fact for how much came out.
router.post("/production", async (req, res) => {
  const user = await gate(req, res);
  if (!user) return;
  const { recipe_id, batches, yield_qty, produced_date, notes } = req.body;
  if (!recipe_id) return res.status(400).json({ error: "recipe_id is required" });
  const batchCount = Number(batches);
  if (!(batchCount > 0)) return res.status(400).json({ error: "batches must be a positive number" });

  const { data: r, error: rErr } = await supabase.from("bk_recipes").select("*").eq("id", recipe_id).maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!r) return res.status(404).json({ error: "Recipe not found" });
  const { data: ingredientsRaw } = await supabase.from("bk_recipe_ingredients").select("*").eq("recipe_id", recipe_id);
  const recipe = { id: r.id, ingredients: (ingredientsRaw || []).map((i) => ({ rawId: i.raw_material_id, qty: Number(i.qty) })) };

  const { outputItemId, ingredients, unresolved } = await resolveRecipe(recipe);
  if (!outputItemId) return res.status(400).json({ error: `No item exists to produce "${r.name}" into — add it to the item master first.` });
  if (unresolved.length) return res.status(400).json({ error: `Can't record this yet — these ingredients have no known item mapping (fix raw_materials.inventory_item_id first): ${unresolved.join(", ")}` });

  const actualYield = yield_qty != null && Number(yield_qty) > 0 ? Number(yield_qty) : Number(r.yield_qty) * batchCount;
  const producedDate = produced_date || todayIST();

  const { data: run, error: runErr } = await supabase.from("bk_production_runs").insert({
    recipe_id, output_item_id: outputItemId, batches: batchCount, yield_qty: actualYield, yield_unit: r.yield_unit,
    produced_date: producedDate, produced_by: user.name, notes: notes || null,
  }).select().single();
  if (runErr) return res.status(500).json({ error: runErr.message });

  const ingredientRows = ingredients.map((ing) => ({ run_id: run.id, raw_material_id: ing.raw_material_id, item_id: ing.item_id, qty_consumed: ing.qty_per_batch * batchCount }));
  if (ingredientRows.length) {
    const { error: riErr } = await supabase.from("bk_production_run_ingredients").insert(ingredientRows);
    if (riErr) return res.status(500).json({ error: riErr.message });
  }

  // REVISED (Stage 5 course-correction): no stock_movements are written here any more.
  // BK isn't a tracked location — confirmed directly with the owner that the old "BK
  // Closing Stock" count has only ever been Store's real count, mislabeled, and BK
  // operationally works like an outlet (demand -> receive -> no live ledger). The raw
  // materials "consumed" here already left Store's tracked balance when BK's demand for
  // them was originally dispatched (see stockOutHooks.js) — decrementing them again at a
  // 'bk' location with no real balance would be double-counting against nothing. This
  // stays purely a historical/reporting log now (bk_production_runs +
  // bk_production_run_ingredients, both still written above) — what was cooked, when,
  // and from what — without pretending there's a live BK stock number behind it.
  res.json({ ...run, ingredients: ingredientRows });
});

// GET /production — recent runs, newest first.
router.get("/production", async (req, res) => {
  if (!await gate(req, res)) return;
  const { from } = req.query;
  let query = supabase.from("bk_production_runs").select("*, items(name, base_unit)").order("created_at", { ascending: false }).limit(100);
  if (from) query = query.gte("produced_date", from);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map((run) => ({ ...run, output_item_name: run.items?.name, output_base_unit: run.items?.base_unit, items: undefined })));
});

module.exports = router;
