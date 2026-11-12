-- ─────────────────────────────────────────────────────────────────────────────
-- Add "Butter Paper" (butter_paper) to the Store catalog so it shows in the
-- "📦 Packaging & Cleaning" Order-from-Vendor screen, WITH a 1 Box = 75 Pkt
-- purchase conversion. It already exists on the demand side (DEMAND_SECTIONS in
-- App.jsx, unit 'Pkt') but was never in the `items` store master — which is why
-- it was missing from the vendor-order catalog.
--
-- UNIT CONSISTENCY IS LOAD-BEARING: demand_items.unit, items.base_unit and
-- inventory_items.unit must all be 'Pkt' (the Monthly BK/Store audit reconciles
-- in-vs-out as raw numbers). The Box unit is ONLY a purchase conversion in
-- item_units (qty_base = qty_entered × 75), not a base unit. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Demand side (idempotent; already present at runtime via the frontend array).
INSERT INTO demand_items (id, section_id, name, unit, sort_order, active)
VALUES ('butter_paper', 'packaging', 'Butter Paper', 'Pkt', 99, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 2) Legacy inventory catalog — REQUIRED for the Store/BK Audit to count dispatch as OUT.
INSERT INTO inventory_items (id, name, category, unit, threshold, demand_item_id)
VALUES ('butter_paper', 'Butter Paper', 'Packaging', 'Pkt', 0, 'butter_paper')
ON CONFLICT (id) DO NOTHING;

-- 3) Store catalog — category 'Packaging' so it shows in the 10-day Packaging order screen.
INSERT INTO items (id, name, category, base_unit, active, demand_item_id, rate_card_id, created_at)
VALUES
  ('butter_paper', 'Butter Paper', 'Packaging', 'Pkt', TRUE,
     (SELECT id FROM demand_items WHERE id = 'butter_paper'),
     (SELECT id FROM rate_card   WHERE id = 'butter_paper' AND active = TRUE LIMIT 1), now())
ON CONFLICT (id) DO NOTHING;

-- 4) Units: trivial base-unit row (Pkt, factor 1) + the purchase conversion 1 Box = 75 Pkt.
INSERT INTO item_units (item_id, unit, factor, is_purchase_unit, is_issue_unit)
VALUES
  ('butter_paper', 'Pkt', 1,  TRUE, TRUE),
  ('butter_paper', 'Box', 75, TRUE, FALSE)
ON CONFLICT (item_id, unit) DO NOTHING;

NOTIFY pgrst, 'reload schema';
