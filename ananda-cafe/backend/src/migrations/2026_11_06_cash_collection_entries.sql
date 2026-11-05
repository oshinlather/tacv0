-- ─────────────────────────────────────────────────────────────────────────────
-- Multi-entry cash collections → the day's "deposited" amount is now the SUM of
-- one or more collection entries, not a single overwrite scalar.
--
-- Until now daily_outlet_sales.cash_deposited was ONE value per (outlet, date),
-- set either by the outlet manager's daily-sales form or overwritten by an owner/
-- store collection. The owner wants to record SEVERAL collections in a day that
-- ADD UP to that day's deposited total, and to be able to REMOVE any single entry.
--
-- This mirrors the proven bill-collection append model (outlet_cash_bills →
-- cash_bill_collected): a child table of per-collection rows, summed by the backend
-- (recomputeCashDeposited) into daily_outlet_sales.cash_deposited, which becomes a
-- DERIVED aggregate with a SINGLE writer. The daily-sales form now carries
-- cash_deposited forward verbatim (like cash_bill_collected) instead of setting it,
-- so the form and the entries can never diverge.
--
-- Backfill: every existing non-zero cash_deposited becomes ONE collection entry, so
-- the sum stays identical to what's already on the ledger and no balance shifts.
-- Guarded by NOT EXISTS so it's idempotent / safe to re-run and won't duplicate an
-- entry for an outlet+date that already has one.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outlet_cash_collections (
  id BIGSERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  date DATE NOT NULL,
  amount NUMERIC NOT NULL,
  note TEXT,
  collected_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outlet_cash_collections_od ON outlet_cash_collections (outlet_id, date);

-- Backfill existing single-value deposits as one entry each (preserves the day's total).
-- note is left NULL (the day-level cash_collection_remark stays on daily_outlet_sales) so this
-- doesn't depend on that column existing — keeps the migration order-independent.
INSERT INTO outlet_cash_collections (outlet_id, date, amount, note, collected_by, created_at)
SELECT s.outlet_id, s.date, s.cash_deposited, NULL, s.cash_deposited_by,
       COALESCE(s.cash_deposited_at, s.date::timestamptz + interval '12 hours')
FROM daily_outlet_sales s
WHERE s.cash_deposited IS NOT NULL AND s.cash_deposited <> 0
  AND NOT EXISTS (
    SELECT 1 FROM outlet_cash_collections c
    WHERE c.outlet_id = s.outlet_id AND c.date = s.date
  );

NOTIFY pgrst, 'reload schema';
