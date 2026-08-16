-- Store Inventory Module — Stage 5, Step 3: adds a nullable `reason` column to
-- stock_movements for the new manual-adjustment endpoint (POST /api/store/adjust),
-- the replacement for the old inventory_movements-based manual "Stock Out" screen's
-- one remaining real use case (ad-hoc write-offs — breakage/spoilage/expiry — not tied
-- to a dispatch or a closing count). Every other movement type's own fields already
-- explain themselves (a RECEIPT/DISPATCH has qty_entered+unit_entered, a count's
-- ADJUSTMENT has the count row it came from via source_id) — only a manual adjustment
-- needs a free-text reason, so this is nullable and only ever populated for
-- source_type='manual_adjustment'.
--
-- Rollback: DROP COLUMN reason (safe — nothing else reads it).

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reason TEXT;

NOTIFY pgrst, 'reload schema';
