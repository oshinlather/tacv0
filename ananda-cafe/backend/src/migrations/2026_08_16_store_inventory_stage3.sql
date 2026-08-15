-- Store Inventory Module — Stage 3: fixes a real bug found during live verification of
-- the dispatch stock-out hook (backend/src/routes/stockOutHooks.js).
--
-- stock_movements.source_id was typed BIGINT in Stage 1, written assuming every source
-- table (vendor_challans, and whatever else) uses a bigserial id. That's true for
-- vendor_challans (Stage 2), so Stage 2's receipts worked fine — but demands.id is a
-- UUID, not a bigint, and Stage 3's dispatch hook writes source_id = demands.id. Every
-- real dispatch attempt failed with "invalid input syntax for type bigint" until this
-- was caught by testing an actual dispatch end-to-end rather than trusting it from
-- reading the code. TEXT holds both a stringified bigint and a UUID without loss, and
-- nothing reads source_id as a number anywhere today.
--
-- No corresponding DOWN migration — reverting BIGINT would just reintroduce the bug for
-- any environment that has since written a UUID into this column; TEXT is strictly the
-- correct type going forward regardless of whether Stage 3 itself is ever rolled back.

ALTER TABLE stock_movements ALTER COLUMN source_id TYPE TEXT;

NOTIFY pgrst, 'reload schema';
