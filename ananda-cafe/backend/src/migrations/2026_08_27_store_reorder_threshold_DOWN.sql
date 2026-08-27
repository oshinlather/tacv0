-- Rollback for 2026_08_27_store_reorder_threshold.sql
ALTER TABLE items DROP COLUMN IF EXISTS reorder_threshold;
NOTIFY pgrst, 'reload schema';
