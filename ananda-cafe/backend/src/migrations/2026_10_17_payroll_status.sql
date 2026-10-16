-- Payroll status lifecycle. Until now a finalized month was represented purely by the
-- existence of an employee_payroll_runs row (exists = finalized, absent = draft). Add an
-- explicit status so a run can move Finalize → Paid → Got Reversed:
--   finalized — snapshot locked, outstanding advances settled (unchanged default)
--   paid      — salary actually disbursed
--   reversed  — the finalize/payment was undone; its deducted advances are un-settled again
--               (restored to outstanding), and the row becomes editable/re-finalizable while
--               staying on record for audit.
-- Existing rows default to 'finalized' so nothing changes for already-finalized months.
ALTER TABLE employee_payroll_runs
  ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'finalized',
  ADD COLUMN IF NOT EXISTS paid_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by     TEXT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by TEXT;
