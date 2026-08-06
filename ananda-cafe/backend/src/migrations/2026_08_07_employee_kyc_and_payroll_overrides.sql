-- Employee KYC documents (Aadhar, PAN, Police Verification, Offer Letter, ID
-- Card) — one row per employee per doc type, re-uploading replaces the row
-- (storage_path points at the latest file; the old object is best-effort
-- removed from storage by the API, not by this migration).
CREATE TABLE IF NOT EXISTS employee_documents (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('aadhar', 'pan', 'police_verification', 'offer_letter', 'id_card')),
  storage_path TEXT NOT NULL,
  file_name TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, doc_type)
);
ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON employee_documents;
CREATE POLICY "Service role access" ON employee_documents FOR ALL USING (true) WITH CHECK (true);

-- Private bucket — Aadhar/PAN/police-verification scans are the most
-- sensitive files in this app, so unlike the 'photos'/'bills' buckets this
-- one is never public; the API always hands out short-lived signed URLs.
INSERT INTO storage.buckets (id, name, public)
VALUES ('employee-docs', 'employee-docs', false)
ON CONFLICT (id) DO NOTHING;

-- Per-employee-month manual overrides for Monthly Payroll. Every cell in that
-- sheet (Base, Leave Allowed, Leaves Taken, Leave Cash-in, OT Days, Working
-- Days, Prorated, Advances, Net Payable) is editable in the UI; a non-null
-- column here wins over the live computed value (see computeRow in
-- payroll.js) and also gets baked into the frozen snapshot on Finalize.
-- OT Hours already has its own override path (employee_monthly_ot) and isn't
-- duplicated here.
CREATE TABLE IF NOT EXISTS employee_payroll_overrides (
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  base_salary NUMERIC,
  leave_allowed NUMERIC,
  leaves_taken NUMERIC,
  leaves_cashin NUMERIC,
  ot_days NUMERIC,
  working_days NUMERIC,
  prorated_salary NUMERIC,
  advances_deducted NUMERIC,
  net_payable NUMERIC,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month)
);
ALTER TABLE employee_payroll_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON employee_payroll_overrides;
CREATE POLICY "Service role access" ON employee_payroll_overrides FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
