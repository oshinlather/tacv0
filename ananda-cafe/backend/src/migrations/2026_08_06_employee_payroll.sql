-- Monthly Payroll — replicates the owner's existing salary-sheet formulas:
--   Leaves Cash-in = Leave Allowed − Leaves Taken   (can go negative)
--   OT Days        = OT Hours ÷ 10
--   Working Days   = Month Days + Leaves Cash-in + OT Days
--   Prorated Salary = (Working Days ÷ Month Days) × Base Salary
--   Net Payable     = Prorated Salary − outstanding advances
-- "Leaves Taken" is computed live from employee_attendance (absent/leave = 1,
-- half_day = 0.5). OT hours are entered manually per employee per month for now
-- (PetPooja isn't connected yet — this becomes an auto-fill later without a
-- schema change). Finalizing a month snapshots the computed numbers into
-- employee_payroll_runs (so history doesn't shift if attendance is edited
-- later) and settles whatever advances were outstanding at that moment.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS leave_allowed NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS employee_monthly_ot (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  month TEXT NOT NULL,                 -- 'YYYY-MM'
  ot_hours NUMERIC NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, month)
);
ALTER TABLE employee_monthly_ot ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON employee_monthly_ot FOR ALL USING (true);

CREATE TABLE IF NOT EXISTS employee_payroll_runs (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  month TEXT NOT NULL,                 -- 'YYYY-MM'
  base_salary NUMERIC NOT NULL,
  leave_allowed NUMERIC NOT NULL,
  leaves_taken NUMERIC NOT NULL,
  ot_hours NUMERIC NOT NULL,
  month_days INT NOT NULL,
  leaves_cashin NUMERIC NOT NULL,
  ot_days NUMERIC NOT NULL,
  working_days NUMERIC NOT NULL,
  prorated_salary NUMERIC NOT NULL,
  advances_deducted NUMERIC NOT NULL,
  net_payable NUMERIC NOT NULL,
  finalized_by TEXT,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, month)
);
CREATE INDEX IF NOT EXISTS idx_employee_payroll_runs_month ON employee_payroll_runs (month);
ALTER TABLE employee_payroll_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON employee_payroll_runs FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
