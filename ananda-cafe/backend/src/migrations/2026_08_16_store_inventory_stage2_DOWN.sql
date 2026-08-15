-- Rollback for 2026_08_16_store_inventory_stage2.sql.
-- Safe until real challans exist; once vendors are actively being received against,
-- export vendor_challans/vendor_challan_items first — this deletes them along with any
-- stock_movements they created (those live in the Stage 1 tables and are NOT touched by
-- this rollback, so balances would then be stale until manually corrected).
--
-- Deliberately NOT reverting the stock_movements.idempotency_key constraint change (the
-- partial-index -> plain-UNIQUE fix) — that was a real bug fix independent of Stage 2's
-- own tables, not a Stage-2-specific behavior; leaving it fixed even if Stage 2 itself
-- is rolled back.

DROP TABLE IF EXISTS vendor_challan_items;
DROP TABLE IF EXISTS vendor_challans;
DROP TABLE IF EXISTS vendors;

NOTIFY pgrst, 'reload schema';
