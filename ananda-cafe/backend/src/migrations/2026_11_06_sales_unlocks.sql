-- ─────────────────────────────────────────────────────────────────────────────
-- Sales unlock — the owner's "open a locked daily-sales entry" grant, mirroring
-- demand_exceptions ("ordering open"). A manager gets exactly ONE sales submission
-- per (outlet, date); once submitted the form is frozen to them. When a correction
-- is genuinely needed the owner grants an unlock for that outlet+date, which lifts
-- the lock for a single re-submission.
--
-- One row per (outlet_id, date): granting twice is an idempotent upsert, not a pile
-- of duplicates. Unlike demand_exceptions (today-only, naturally expiring), a sales
-- unlock may target any past date — so it is CONSUMED on the manager's next sales
-- submit (POST /outlet-sales deletes the matching row), re-locking the day after the
-- one correction. The owner can also revoke a grant made in error.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_unlocks (
  id SERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  date DATE NOT NULL,
  reason TEXT,
  granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, date)
);

CREATE INDEX IF NOT EXISTS idx_sales_unlocks_outlet_date ON sales_unlocks (outlet_id, date);

ALTER TABLE sales_unlocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON sales_unlocks;
CREATE POLICY "Service role access" ON sales_unlocks FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
