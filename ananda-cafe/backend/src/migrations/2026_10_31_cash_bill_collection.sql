-- ─────────────────────────────────────────────────────────────────────────────
-- Bill-backed cash "collection". When an owner/store manager collects from an
-- outlet, some cash was already spent at the outlet and can't be handed over as
-- physical notes — instead a BILL is accepted for it, and that amount is counted
-- as collected (it reduces the outlet's available cash, same as a deposit).
--
-- It is tracked in its OWN column, deliberately separate from cash_deposited, so:
--   • the closing/available formula subtracts it (money is accounted for / gone)
--   • it is NOT summed into any collector's "holding" (which counts cash_deposited
--     only) — because the money was spent, not physically carried. Honest numbers.
--
-- Individual bills (amount + photo(s) + who + note) live in outlet_cash_bills;
-- daily_outlet_sales.cash_bill_collected is the per-(outlet,date) aggregate the
-- cash cascade reads. Bill photos reuse the existing `Photos` storage bucket.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE daily_outlet_sales ADD COLUMN IF NOT EXISTS cash_bill_collected NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE daily_outlet_sales ADD COLUMN IF NOT EXISTS cash_bill_collected_by TEXT;

CREATE TABLE IF NOT EXISTS outlet_cash_bills (
  id BIGSERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  date DATE NOT NULL,
  amount NUMERIC NOT NULL,
  note TEXT,
  collected_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outlet_cash_bills_od ON outlet_cash_bills (outlet_id, date);

CREATE TABLE IF NOT EXISTS outlet_cash_bill_photos (
  id BIGSERIAL PRIMARY KEY,
  bill_id BIGINT NOT NULL REFERENCES outlet_cash_bills(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outlet_cash_bill_photos_bid ON outlet_cash_bill_photos (bill_id);

ALTER TABLE outlet_cash_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlet_cash_bill_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON outlet_cash_bills;
CREATE POLICY "Service role access" ON outlet_cash_bills FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON outlet_cash_bill_photos;
CREATE POLICY "Service role access" ON outlet_cash_bill_photos FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
