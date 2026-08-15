-- Rollback for 2026_08_15_store_inventory_stage1.sql.
-- Drops everything that migration created, in dependency order. Safe at any point
-- during Stage 1 — nothing outside the new tables reads from them yet. Once Stage 2+
-- starts writing real receipts/dispatches into stock_movements, do NOT run this without
-- exporting that data first (it deletes the ledger).

DROP TABLE IF EXISTS store_stock_balances;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS item_units;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS locations;

NOTIFY pgrst, 'reload schema';
