-- Store Inventory Module — Stage 6: reorder threshold, the one real feature gap found
-- when comparing the new system against the old Inventory screen before retiring it
-- ("hide the old flow ... make sure no single dependency on old flow remains"). The old
-- inventory_items.threshold column drove a below_threshold low-stock alert + a
-- thresholds editor; the new items table had no equivalent at all, which would have
-- been a real, silent capability loss on cutover, not a cosmetic one.
--
-- Backfilled from inventory_items.threshold, not reinvented — these are real numbers
-- someone configured (140 of 145 items have a threshold > 0 today), same "carry over
-- what's real" rule Stage 1's own backfill used for demand_item_id/raw_material_id.
--
-- Rollback: 2026_08_27_store_reorder_threshold_DOWN.sql.

ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_threshold NUMERIC;

UPDATE items i
SET reorder_threshold = ii.threshold
FROM inventory_items ii
WHERE ii.id = i.id AND ii.threshold > 0 AND i.reorder_threshold IS NULL;

NOTIFY pgrst, 'reload schema';
