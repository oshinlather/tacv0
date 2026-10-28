-- ─────────────────────────────────────────────────────────────────────────────
-- Department / asset purchases — a per-outlet "bill vault". Managers log a
-- capital/maintenance purchase (Electrical, Mixer, Weighing Machine, Water
-- Tanki, Repairs, Civil Works, …) and attach the bill photo(s). The whole point
-- is PRESERVING the bill for a future warranty claim, so the bill is optional at
-- entry time (you can log the purchase now and add the bill later) and an
-- optional warranty-till date surfaces what's still covered.
--
-- Bills live in the existing `Photos` storage bucket; only the path is stored,
-- signed on read (same convention as vendor challans / outlet photos).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS department_purchases (
  id BIGSERIAL PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  department TEXT NOT NULL,
  title TEXT NOT NULL,            -- what was purchased, e.g. "Ceiling fan", "Mixer jar"
  amount NUMERIC,                 -- optional — this is a bill vault, not a cash-expense ledger
  vendor TEXT,                    -- shop / supplier — needed when claiming warranty
  purchase_date DATE NOT NULL,
  warranty_until DATE,            -- optional — null = no/unknown warranty
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dept_purchases_outlet ON department_purchases (outlet_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_dept_purchases_dept ON department_purchases (outlet_id, department);

CREATE TABLE IF NOT EXISTS department_purchase_photos (
  id BIGSERIAL PRIMARY KEY,
  purchase_id BIGINT NOT NULL REFERENCES department_purchases(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dept_purchase_photos_pid ON department_purchase_photos (purchase_id);

ALTER TABLE department_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_purchase_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON department_purchases;
CREATE POLICY "Service role access" ON department_purchases FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON department_purchase_photos;
CREATE POLICY "Service role access" ON department_purchase_photos FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
