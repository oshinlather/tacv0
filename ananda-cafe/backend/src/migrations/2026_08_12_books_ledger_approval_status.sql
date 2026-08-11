-- Approval workflow for books_ledger — first "submit → owner approves" pattern in
-- the app (existing outlet_transfers.status is a two-PEER confirm, not an owner
-- gate). Built for the new "Impose Fine" feature: an outlet/BK manager can fine an
-- employee (with a mandatory reason), but it must NOT count as an outstanding
-- advance — and must NOT be swept into Monthly Payroll's advance deduction — until
-- the owner approves it. Modeled as a plain books_ledger row (is_advance=true,
-- category='staff_fine') gated by this new status column, rather than a separate
-- table, so it automatically inherits the existing "advance" machinery
-- (GET /api/employees outstanding_advance, employee profile advance history,
-- payroll's advances_deducted) the instant it's approved — see employees.js and
-- payroll.js for the status='approved' filters added alongside this migration.
--
-- Defaulting existing/ordinary rows (advances included) to 'approved' means every
-- pre-existing behavior is unchanged: an advance given today is still outstanding
-- immediately, no new approval step for advances themselves — only fines start
-- life as 'pending'.
ALTER TABLE books_ledger ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE books_ledger DROP CONSTRAINT IF EXISTS books_ledger_status_check;
ALTER TABLE books_ledger ADD CONSTRAINT books_ledger_status_check CHECK (status IN ('pending', 'approved', 'rejected'));

ALTER TABLE books_ledger ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE books_ledger ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE books_ledger ADD COLUMN IF NOT EXISTS rejection_note TEXT;

-- Widen the category enum to add 'staff_fine' alongside the existing 'staff_advance'.
ALTER TABLE books_ledger DROP CONSTRAINT IF EXISTS books_ledger_category_check;
ALTER TABLE books_ledger ADD CONSTRAINT books_ledger_category_check CHECK (category IN (
  'cogs_dairy', 'cogs_vegetables', 'cogs_other',
  'utilities_electric', 'utilities_gas', 'utilities_water',
  'repairs_maintenance', 'labor_porter', 'staff_advance', 'staff_fine',
  'vendor_payment', 'uncategorized'
));

CREATE INDEX IF NOT EXISTS idx_books_ledger_pending_fines ON books_ledger(category, status) WHERE category = 'staff_fine' AND status = 'pending';

NOTIFY pgrst, 'reload schema';
