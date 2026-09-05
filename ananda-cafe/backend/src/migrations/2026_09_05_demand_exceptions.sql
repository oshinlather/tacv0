-- Evening demand slot cutoff — outlet managers were able to punch an "evening" demand at
-- any hour, no matter how late, with nothing stopping a habit of very-late orders. Owner
-- wants a hard 11:45 AM IST cutoff enforced server-side (see the check added to POST
-- /demands and PATCH /demands/draft in salesRoutes.js), with the ONLY way past it being an
-- explicit, one-day, per-outlet exception the owner grants from the Owner Dashboard's
-- Demand Approval screen — for the real case of an outlet calling in on the phone asking
-- for a late evening order on some particular day.
--
-- One row per (outlet_id, date) the owner has granted an exception for — the unique
-- constraint means granting again for the same outlet+day is just a no-op upsert, not a
-- growing pile of duplicate rows, and a grant for today has no effect at all tomorrow
-- (the date simply won't match), so nothing needs to be manually revoked/expired.
CREATE TABLE IF NOT EXISTS demand_exceptions (
  id SERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  date DATE NOT NULL,
  reason TEXT,
  granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, date)
);

CREATE INDEX IF NOT EXISTS idx_demand_exceptions_outlet_date ON demand_exceptions (outlet_id, date);

ALTER TABLE demand_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON demand_exceptions FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
