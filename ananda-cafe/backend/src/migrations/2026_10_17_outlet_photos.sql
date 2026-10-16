-- ─────────────────────────────────────────────────────────────────────────────
-- Outlet daily photo module. Each company outlet captures 4 time-bound photos
-- per operational day: opening / clean / briefing / closing. One row per
-- (outlet, date, type); recapture before the deadline overwrites via upsert.
-- Photos live in the existing `Photos` storage bucket; only the path is stored.
-- `date` = the OPERATIONAL date (rolls at 1:30 AM, so a late-night closing photo
-- still belongs to the day that just ended).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outlet_photos (
  id BIGSERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  date DATE NOT NULL,
  photo_type TEXT NOT NULL CHECK (photo_type IN ('opening', 'closing', 'clean', 'briefing')),
  storage_path TEXT NOT NULL,
  captured_by TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, date, photo_type)
);
CREATE INDEX IF NOT EXISTS idx_outlet_photos_date ON outlet_photos (date, outlet_id);

ALTER TABLE outlet_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON outlet_photos;
CREATE POLICY "Service role access" ON outlet_photos FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
