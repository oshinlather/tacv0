-- ─────────────────────────────────────────────────────────────────────────────
-- Optional free-text remark the collector can attach when recording a cash
-- collection/deposit for an outlet+date (pencil "Record Collection" modal and the
-- "I'm Collecting Cash" outlet flow). Purely informational — it does not affect
-- any cash balance/cascade. Kept separate from `notes` (the outlet manager's
-- daily-sales note) and `cash_expense_note` (the expense note) so the three don't
-- collide.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE daily_outlet_sales ADD COLUMN IF NOT EXISTS cash_collection_remark TEXT;

NOTIFY pgrst, 'reload schema';
