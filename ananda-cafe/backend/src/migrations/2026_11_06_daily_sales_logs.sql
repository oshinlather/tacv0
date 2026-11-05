-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only change log for the Cash Ledger's per-date 🕘 history icon. Until now
-- both cash writers (POST /outlet-sales and PATCH .../cash-collection) just UPSERT —
-- overwriting the previous value and keeping only the latest who/when stamp, so there
-- was no trail of "manager A entered ₹X, manager B changed it to ₹Y". This table keeps
-- one row per change: sales submissions/edits and cash-collection edits. (Bill-backed
-- collections already have their own append table, outlet_cash_bills, and are merged in
-- on read — not duplicated here. Quantity edits have their own log, qty_corrections.)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS daily_sales_logs (
  id BIGSERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  date DATE NOT NULL,
  action TEXT NOT NULL,        -- 'sales_submitted' | 'sales_edited' | 'cash_collected'
  actor TEXT,                  -- manager name who made the change
  detail TEXT,                 -- human-readable summary
  old_value NUMERIC,           -- for amount changes (e.g. cash_deposited old → new)
  new_value NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_sales_logs_od ON daily_sales_logs (outlet_id, date, created_at DESC);

ALTER TABLE daily_sales_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON daily_sales_logs;
CREATE POLICY "Service role access" ON daily_sales_logs FOR ALL USING (true) WITH CHECK (true);

-- Baseline backfill: seed one row from each existing row's CURRENT stamp so historical
-- dates aren't empty. Only the latest submission/collection is recoverable (there was no
-- trail before this) — every change from now on is appended in full.
INSERT INTO daily_sales_logs (outlet_id, date, action, actor, detail, created_at)
SELECT outlet_id, date, 'sales_submitted', submitted_by, 'Daily sales submitted', submitted_at
FROM daily_outlet_sales WHERE submitted_by IS NOT NULL AND submitted_at IS NOT NULL;

INSERT INTO daily_sales_logs (outlet_id, date, action, actor, new_value, detail, created_at)
SELECT outlet_id, date, 'cash_collected', cash_deposited_by, cash_deposited, 'Cash collection recorded', cash_deposited_at
FROM daily_outlet_sales WHERE cash_deposited_by IS NOT NULL AND cash_deposited_at IS NOT NULL AND cash_deposited > 0;

NOTIFY pgrst, 'reload schema';
