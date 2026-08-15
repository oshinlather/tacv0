-- Store Inventory Module — Stage 4: blind closing count -> audit/variance -> owner
-- rollup. Final stage on top of Stages 1-3's items/item_units/locations/
-- stock_movements/store_stock_balances ledger.
--
-- "Blind" means the counter never sees the system's current quantity while entering a
-- physical count — stock_count_items.counted_qty is write-only from the counting UI's
-- point of view; the system_qty_at_submit snapshot and variance are only computed and
-- shown AFTER the whole count is submitted, on the audit/variance view (a different
-- screen, gated to owner/store_mgr — the counter themselves doesn't see it as part of
-- counting). This is enforced by the API (the count-entry endpoints never return
-- system_qty or variance), not just the UI, so a direct API call can't defeat it either.
--
-- A submitted count reconciles the ledger to physical reality: for every counted item,
-- an ADJUSTMENT movement is written with qty_delta = counted - system (whatever that
-- takes the balance from is exactly cancelled out, landing on the counted number). This
-- is the same append-only stock_movements table from Stage 1 — 'ADJUSTMENT' was already
-- a valid movement_type there, unused until now.
--
-- No variance tolerance threshold is hardcoded anywhere here — showing every variance,
-- sorted by size, rather than guessing at what an "acceptable" threshold would be. An
-- owner can add one later via the existing generic app_config key/value table (same
-- pattern finance.js already uses for delivery_commission_pct) without a migration.
--
-- A count is scoped to ONE location (store or bk) and ONE date, and can include as few
-- or as many items as were actually physically counted that session — an item left out
-- is "not counted this time", not implicitly zero.
--
-- Rollback: 2026_08_17_store_inventory_stage4_DOWN.sql.

CREATE TABLE IF NOT EXISTS stock_counts (
  id BIGSERIAL PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  count_date DATE NOT NULL,          -- IST calendar date
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'cancelled')),
  counted_by TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by TEXT,
  submitted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS stock_counts_date_idx ON stock_counts (count_date, location_id);

CREATE TABLE IF NOT EXISTS stock_count_items (
  id BIGSERIAL PRIMARY KEY,
  count_id BIGINT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  counted_qty NUMERIC NOT NULL,      -- what was physically counted, converted to base unit
  qty_entered NUMERIC,               -- what the user actually typed (audit trail, same as
                                      -- stock_movements' qty_entered/unit_entered pattern)
  unit_entered TEXT,
  system_qty_at_submit NUMERIC,      -- snapshot taken at submit time, NULL until submitted —
                                      -- this + variance are the "not blind anymore" fields
  variance_qty NUMERIC,              -- counted_qty - system_qty_at_submit
  variance_value NUMERIC,            -- variance_qty priced at rate_card where available
  UNIQUE (count_id, item_id)
);

ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON stock_counts; CREATE POLICY "Service role access" ON stock_counts FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON stock_count_items; CREATE POLICY "Service role access" ON stock_count_items FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
