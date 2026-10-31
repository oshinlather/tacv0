-- ─────────────────────────────────────────────────────────────────────────────
-- Add "Cold Coffee Glass" (cold_coffee_glass) end-to-end: outlet demand + dispatch,
-- Store catalog (vendor challans + inventory + closing counts), AND the legacy
-- Store/BK Audit. A disposable serving glass, same family as filter_coffee_glass /
-- rasam_glass / chhachh_glass — so unit = 'Pkt', category = 'Packaging'.
--
-- Unlike the earlier add_gloves / add_packaging migrations, this id is BRAND NEW —
-- it did NOT already exist in the legacy `inventory_items` catalog. Those migrations
-- could skip `inventory_items` only because their ids were already present there from
-- the original 145-row seed. The Store Audit (daily + monthly, inventory.js) still
-- enumerates `inventory_items` and maps outlet dispatch OUT via
-- inventory_items.demand_item_id, so a new id MUST be seeded there too (step 2) or it
-- would silently never appear in the audit and its dispatches wouldn't count as OUT.
--
-- UNIT CONSISTENCY IS LOAD-BEARING: demand_items.unit, items.base_unit and
-- inventory_items.unit must all be identical ('Pkt'). The Monthly BK/Store audit
-- reconciles stock-in vs stock-out as RAW NUMBERS with no unit conversion, so a unit
-- mismatch across these tables would corrupt the reconcile.
--
-- Price: left unpriced for now (rate_card_id resolves to NULL below). Add a ₹/Pkt via
-- the Rate Card screen if costing/P&L is needed, or it auto-fills on the first vendor
-- challan receive (challan price → rate_card_prices ledger). The hardcoded
-- DEMAND_SECTIONS list in frontend/src/App.jsx is updated in the same change so the
-- demand form (and the module-eval BK_ITEMS / CLOSING_STOCK arrays) offer it too.
--
-- Idempotent: ON CONFLICT DO NOTHING, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Demand side (outlet demand form runtime source + dispatch + audit category map)
INSERT INTO demand_items (id, section_id, name, unit, sort_order, active)
VALUES ('cold_coffee_glass', 'packaging', 'Cold Coffee Glass', 'Pkt', 99, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 2) Legacy inventory catalog — REQUIRED for the Store/BK Audit to render this item and
--    to count its outlet dispatch as OUT (mapped via inventory_items.demand_item_id).
INSERT INTO inventory_items (id, name, category, unit, threshold, demand_item_id)
VALUES ('cold_coffee_glass', 'Cold Coffee Glass', 'Packaging', 'Pkt', 0, 'cold_coffee_glass')
ON CONFLICT (id) DO NOTHING;

-- 3) Store catalog (vendor challans + inventory + closing counts). category MUST be
--    'Packaging' so it shows in the "📦 Packaging & Cleaning" 10-day order screen.
--    demand_item_id / rate_card_id are NULL-safe subqueries (resolve if present, else NULL).
INSERT INTO items (id, name, category, base_unit, active, demand_item_id, rate_card_id, created_at)
VALUES
  ('cold_coffee_glass', 'Cold Coffee Glass', 'Packaging', 'Pkt', TRUE,
     (SELECT id FROM demand_items WHERE id = 'cold_coffee_glass'),
     (SELECT id FROM rate_card   WHERE id = 'cold_coffee_glass' AND active = TRUE LIMIT 1), now())
ON CONFLICT (id) DO NOTHING;

-- 4) Trivial item_units row (its own base unit, factor 1) — matches the stage-1 seed.
INSERT INTO item_units (item_id, unit, factor, is_purchase_unit, is_issue_unit)
SELECT id, base_unit, 1, TRUE, TRUE
FROM items
WHERE id = 'cold_coffee_glass'
ON CONFLICT (item_id, unit) DO NOTHING;

-- PostgREST schema cache reload (mirrors stage-1 migration).
NOTIFY pgrst, 'reload schema';
