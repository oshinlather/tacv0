-- Employee Master — full staff directory for the "👤 Employee Master" tab on the
-- Owner Dashboard. Superset of app_users: covers everyone on payroll, including
-- staff who never log into the app (helpers, cooks, cleaners), grouped under an
-- Outlet, Base Kitchen, or Top Management. Optionally links to an app_users row
-- for employees who also have login access, so PIN/role stays managed in one place.

CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  designation TEXT NOT NULL,                  -- e.g. 'Chef', 'Helper', 'Cleaner', 'Cashier', 'Manager'
  department TEXT NOT NULL,                   -- outlet id (e.g. 'sec23'), 'bk' (Base Kitchen), or 'top_mgmt' (Top Management)
  phone TEXT,
  joining_date DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  app_user_id UUID REFERENCES app_users(id),  -- optional link for employees who also have app login
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employees_department ON employees (department);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees (active);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON employees FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
