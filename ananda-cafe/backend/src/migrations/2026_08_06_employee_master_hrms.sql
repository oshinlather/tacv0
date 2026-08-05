-- Employee Master → mini HRMS: employee code, salary, shift/roster timing, bank/UPI
-- details, daily attendance, and a link from Books Ledger advances to a specific
-- employee (so "outstanding advance" can be computed per-employee instead of by
-- matching free-text names).

-- ── Employees: HR fields ──────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_code TEXT UNIQUE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary NUMERIC;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_type TEXT NOT NULL DEFAULT 'monthly'; -- 'monthly' | 'daily'
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_start TIME;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_end TIME;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS weekly_off TEXT;                -- e.g. 'Monday', or NULL if none
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_name TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_ifsc TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS upi_id TEXT;

-- ── Daily attendance ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_attendance (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  date DATE NOT NULL,
  status TEXT NOT NULL,          -- 'present' | 'absent' | 'half_day' | 'leave' | 'holiday'
  note TEXT,
  marked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_date ON employee_attendance (date);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_employee ON employee_attendance (employee_id);

ALTER TABLE employee_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON employee_attendance FOR ALL USING (true);

-- ── Books Ledger → Employee link (for accurate per-employee advance balances) ──
ALTER TABLE books_ledger ADD COLUMN IF NOT EXISTS employee_id BIGINT REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_books_ledger_employee ON books_ledger (employee_id);

NOTIFY pgrst, 'reload schema';
