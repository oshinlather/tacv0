-- Store Inventory Module — Stage 5, Production stock-in flow.
--
-- Found via the Stage 5 migration-comparison tool (pnl-compare/:date), not guessed:
-- every BK-prepared recipe output (sambhar, batters, chutneys, masalas) was going
-- steadily NEGATIVE in the new ledger. Real dispatches were correctly decrementing them
-- (Stage 3 works exactly as verified) but nothing ever replenished them, because Vendor
-- Challans only models external vendor purchases — there was no way to record "BK just
-- cooked a batch of X" at all. This fixes that.
--
-- 'PRODUCTION' is a new stock_movements.movement_type: negative rows for each raw
-- material consumed, one positive row for the output produced, all at location='bk'
-- (prep happens at BK, consuming BK's own stock). Existing types are unchanged.
--
-- bk_production_runs / bk_production_run_ingredients record what was actually applied
-- (same "persist what really happened" pattern as vendor_challan_items / stock_count_items
-- — not just a pointer back to the recipe, since the recipe could change later and the
-- run should still show what it actually consumed at the time).

-- Drop whatever the inline CHECK from Stage 1 actually got auto-named (not assumed —
-- found dynamically via pg_constraint rather than guessing the Postgres-generated name,
-- since guessing wrong here would leave the OLD, PRODUCTION-less constraint silently
-- still enforced alongside a new one, which only fails confusingly later when someone
-- actually tries to record a production run).
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'stock_movements'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%movement_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('RECEIPT','DISPATCH','WASTAGE','ADJUSTMENT','OPENING','TRANSFER','PRODUCTION'));

CREATE TABLE IF NOT EXISTS bk_production_runs (
  id BIGSERIAL PRIMARY KEY,
  recipe_id TEXT NOT NULL,              -- bk_recipes.id (old table, untouched — this just
                                         -- reads it, same as the existing costing code)
  output_item_id TEXT NOT NULL REFERENCES items(id),
  batches NUMERIC NOT NULL,
  yield_qty NUMERIC NOT NULL,           -- actual qty produced this run (batches x recipe yield,
                                         -- or a direct override — either way, what really happened)
  yield_unit TEXT,
  produced_date DATE NOT NULL,          -- IST calendar date
  produced_by TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bk_production_runs_date_idx ON bk_production_runs (produced_date);

CREATE TABLE IF NOT EXISTS bk_production_run_ingredients (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES bk_production_runs(id) ON DELETE CASCADE,
  raw_material_id TEXT NOT NULL,        -- raw_materials.id, kept for traceability back to the recipe
  item_id TEXT NOT NULL REFERENCES items(id),
  qty_consumed NUMERIC NOT NULL         -- in the item's base unit
);

ALTER TABLE bk_production_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bk_production_run_ingredients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON bk_production_runs; CREATE POLICY "Service role access" ON bk_production_runs FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON bk_production_run_ingredients; CREATE POLICY "Service role access" ON bk_production_run_ingredients FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
