-- Daily Sales (PetPooja upload) previously discarded three columns that are
-- present in every raw PetPooja export but weren't being captured:
--   status              — 'Success' | 'Cancelled'. Cancelled orders' `total`
--                         is their would-have-been billed amount, not zero —
--                         without this column, any revenue aggregation built
--                         off daily_sales silently counted cancelled orders as
--                         real sales.
--   order_cancel_reason — free text, kept for audit ("why was this cancelled").
--   waived_off          — a real per-order comp/waiver amount already present
--                         in PetPooja's own export (distinct from `discount`).
--
-- These three, plus the already-captured `area` column (which turns out to
-- carry the aggregator name — 'Zomato'/'Swiggy' — for delivery orders, and a
-- seating-area name for dine-in), are what let Daily P&L's Total Sale/
-- Effective Sale move off the outlet manager's manual "Daily Sales & Cash"
-- entry and onto real PetPooja billing data instead. See GET /api/pnl/live
-- in salesRoutes.js.
--
-- Existing rows (already-uploaded historical dates) will have NULL for all
-- three — re-upload that day's CSV after this migration to backfill them.

ALTER TABLE daily_sales ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE daily_sales ADD COLUMN IF NOT EXISTS order_cancel_reason TEXT;
ALTER TABLE daily_sales ADD COLUMN IF NOT EXISTS waived_off NUMERIC;

NOTIFY pgrst, 'reload schema';
