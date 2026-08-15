-- Rollback for 2026_08_17_store_inventory_stage4.sql.
-- Safe until real counts exist — export stock_counts/stock_count_items first if any
-- real closing counts have been submitted. The ADJUSTMENT movements a submitted count
-- wrote into stock_movements (Stage 1's table) are NOT touched by this rollback, so
-- balances would stay as last-reconciled even after dropping these tables.

DROP TABLE IF EXISTS stock_count_items;
DROP TABLE IF EXISTS stock_counts;

NOTIFY pgrst, 'reload schema';
