-- ─────────────────────────────────────────────────────────────────────────────
-- Make "Sugar Sachet" (sugar_sachet) appear in the "🛒 Grocery & Masala"
-- Order-from-Vendor screen. The store order catalog is the `items` table filtered
-- by category, so this ensures a Sugar Sachet row with category = 'Grocery'
-- (creating it, or moving it from whatever category it had). Unit stays 'Pkt'
-- to match the demand side (audit reconciles in-vs-out as raw numbers). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- Demand side already carries it (packaging section); keep as-is, insert idempotently.
INSERT INTO demand_items (id, section_id, name, unit, sort_order, active)
VALUES ('sugar_sachet', 'packaging', 'Sugar Sachet', 'Pkt', 99, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory_items (id, name, category, unit, threshold, demand_item_id)
VALUES ('sugar_sachet', 'Sugar Sachet', 'Grocery', 'Pkt', 0, 'sugar_sachet')
ON CONFLICT (id) DO NOTHING;

-- Store order catalog — category 'Grocery' (force it, in case the row already exists
-- under a different category) so it lands in the Grocery & Masala order.
INSERT INTO items (id, name, category, base_unit, active, demand_item_id, rate_card_id, created_at)
VALUES
  ('sugar_sachet', 'Sugar Sachet', 'Grocery', 'Pkt', TRUE,
     (SELECT id FROM demand_items WHERE id = 'sugar_sachet'),
     (SELECT id FROM rate_card   WHERE id = 'sugar_sachet' AND active = TRUE LIMIT 1), now())
ON CONFLICT (id) DO UPDATE SET category = 'Grocery', active = TRUE;

INSERT INTO item_units (item_id, unit, factor, is_purchase_unit, is_issue_unit)
SELECT id, base_unit, 1, TRUE, TRUE FROM items WHERE id = 'sugar_sachet'
ON CONFLICT (item_id, unit) DO NOTHING;

NOTIFY pgrst, 'reload schema';
