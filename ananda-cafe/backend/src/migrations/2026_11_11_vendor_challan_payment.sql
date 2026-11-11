-- ─────────────────────────────────────────────────────────────────────────────
-- Vendor challan payment status. A challan being RECEIVED (stock came in) is
-- separate from it being PAID (the vendor's money is settled) — the owner wants
-- to track which received deliveries are still owed. Defaults to 'unpaid'; when
-- marked paid, we record who settled it (paid_by, from a fixed people list) and
-- when (paid_at). Clearing back to unpaid wipes both.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE vendor_challans
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_by TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
