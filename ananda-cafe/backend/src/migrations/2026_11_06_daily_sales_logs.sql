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
-- Guarded with NOT EXISTS so re-running this migration (or running it after some rows were
-- already logged live) can't insert duplicate baseline rows — one baseline per (outlet,date,action).
INSERT INTO daily_sales_logs (outlet_id, date, action, actor, detail, created_at)
SELECT s.outlet_id, s.date, 'sales_submitted', s.submitted_by, 'Daily sales submitted', s.submitted_at
FROM daily_outlet_sales s
WHERE s.submitted_by IS NOT NULL AND s.submitted_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM daily_sales_logs l WHERE l.outlet_id = s.outlet_id AND l.date = s.date AND l.action = 'sales_submitted');

INSERT INTO daily_sales_logs (outlet_id, date, action, actor, new_value, detail, created_at)
SELECT s.outlet_id, s.date, 'cash_collected', s.cash_deposited_by, s.cash_deposited, 'Cash collection recorded', s.cash_deposited_at
FROM daily_outlet_sales s
WHERE s.cash_deposited_by IS NOT NULL AND s.cash_deposited_at IS NOT NULL AND s.cash_deposited > 0
  AND NOT EXISTS (SELECT 1 FROM daily_sales_logs l WHERE l.outlet_id = s.outlet_id AND l.date = s.date AND l.action = 'cash_collected');

NOTIFY pgrst, 'reload schema';
