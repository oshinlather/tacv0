-- ─────────────────────────────────────────────────────────────────────────────
-- One-off cleanup: the initial daily_sales_logs backfill wasn't idempotent, so
-- running it more than once (or after a collection was already logged live)
-- inserted identical rows — surfaced as duplicate entries in the Cash Ledger's
-- 🕘 history. Delete exact-duplicate rows (same outlet/date/action/actor/values
-- AT THE SAME timestamp), keeping the lowest id. Two genuine edits always have
-- distinct created_at, so this only removes true duplicates. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM daily_sales_logs a
USING daily_sales_logs b
WHERE a.id > b.id
  AND a.outlet_id = b.outlet_id
  AND a.date = b.date
  AND a.action = b.action
  AND a.created_at = b.created_at
  AND a.actor IS NOT DISTINCT FROM b.actor
  AND a.old_value IS NOT DISTINCT FROM b.old_value
  AND a.new_value IS NOT DISTINCT FROM b.new_value
  AND a.detail IS NOT DISTINCT FROM b.detail;

NOTIFY pgrst, 'reload schema';
