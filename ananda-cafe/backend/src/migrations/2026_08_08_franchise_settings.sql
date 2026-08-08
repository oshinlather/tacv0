-- Franchise Billing v2 — markup fee, royalty %, and a proper company-owned/franchise flag.
-- The `outlets` table already exists (schema.sql) and already has `is_franchise`, but it was
-- never kept in sync with the frontend's hardcoded OUTLETS list (missing sec14, stale flags)
-- and nothing ever read it at runtime. This backfills it so it can finally be the source of
-- truth for the new Franchise Settings admin panel and Franchise Billing outlet picker.
INSERT INTO outlets (id, name, short_name, is_franchise) VALUES
  ('sec23', 'Sector 23', 'S-23', false),
  ('sec31', 'Sector 31', 'S-31', false),
  ('sec56', 'Sector 56', 'S-56', false),
  ('sec14', 'Sector 14', 'S-14', false),
  ('elan', 'Elan (Franchise)', 'ELAN', true),
  ('gaursid', 'Gaur Siddhartham (Franchise)', 'GSID', true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name;
-- is_franchise intentionally NOT overwritten on conflict — if the owner has already
-- toggled it via the admin panel by the time this runs again, don't stomp that choice.

-- Franchise agreement terms — markup % (on material cost) and royalty % (on revenue),
-- per outlet, effective-dated. Every change is a new INSERT, never an UPDATE, so past
-- bills can always be recomputed against the terms that were actually in force at the
-- time instead of silently picking up a later correction.
CREATE TABLE IF NOT EXISTS franchise_settings (
  id SERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  markup_pct NUMERIC NOT NULL DEFAULT 0,
  royalty_pct NUMERIC NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_franchise_settings_outlet ON franchise_settings (outlet_id, effective_from DESC);

ALTER TABLE franchise_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON franchise_settings FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
