-- ─────────────────────────────────────────────────────────────────────────────
-- Add two distinct glove items — "Gloves (Blue)" and "Gloves (Plastic)" — across
-- the demand side AND the Store catalog (challans + inventory). These are separate
-- SKUs from the existing "Hand Gloves" (hand_gloves), which is left untouched.
--
-- 1) demand_items  → so outlets can demand them and the audit/costing maps their
--    category (section_id='packaging'). The hardcoded DEMAND_SECTIONS list in
--    App.jsx is updated in the same change so the demand form offers them too.
-- 2) items         → so they appear in the "📦 Packaging & Cleaning" order screen
--    (category must be 'Packaging') and in Store inventory, linked back to their
--    demand_items row via demand_item_id for audit reconcile.
--
-- Units = 'Pkt', matching the demand convention for gloves (hand_gloves is 'Pkt').
-- The Monthly BK/Store audit reconciles in-vs-out as raw numbers with no unit
-- conversion, so demand unit and catalog base_unit must match — both 'Pkt'.
--
-- demand_items is inserted FIRST so the items.demand_item_id subquery resolves in
-- the same migration. rate_card_id is NULL-safe (no price exists yet — add via the
-- rate card if these need costing). Idempotent: ON CONFLICT DO NOTHING, re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Demand side
INSERT INTO demand_items (id, section_id, name, unit, sort_order, active)
VALUES
  ('gloves_blue',    'packaging', 'Gloves (Blue)',    'Pkt', 99, TRUE),
  ('gloves_plastic', 'packaging', 'Gloves (Plastic)', 'Pkt', 99, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 2) Store catalog (challans + inventory)
INSERT INTO items (id, name, category, base_unit, active, demand_item_id, rate_card_id, created_at)
VALUES
  ('gloves_blue',    'Gloves (Blue)',    'Packaging', 'Pkt', TRUE,
     (SELECT id FROM demand_items WHERE id = 'gloves_blue'),
     (SELECT id FROM rate_card   WHERE id = 'gloves_blue'    AND active = TRUE LIMIT 1), now()),
  ('gloves_plastic', 'Gloves (Plastic)', 'Packaging', 'Pkt', TRUE,
     (SELECT id FROM demand_items WHERE id = 'gloves_plastic'),
     (SELECT id FROM rate_card   WHERE id = 'gloves_plastic' AND active = TRUE LIMIT 1), now())
ON CONFLICT (id) DO NOTHING;

-- Trivial item_units row per new item (its own base unit, factor 1) — matches the stage-1 seed.
INSERT INTO item_units (item_id, unit, factor, is_purchase_unit, is_issue_unit)
SELECT id, base_unit, 1, TRUE, TRUE
FROM items
WHERE id IN ('gloves_blue', 'gloves_plastic')
ON CONFLICT (item_id, unit) DO NOTHING;
