-- Store Inventory Module — Stage 1: item master + stock_movements ledger.
-- See STAFF_PORTAL_PROMPT.md's sibling doc (the store-inventory build prompt) for the
-- full Phase 0/1 writeup. This migration:
--   1. Creates locations (exactly 'store' and 'bk' — outlets are NOT tracked locations
--      here; they stay consume-only per the approved plan), items, item_units,
--      stock_movements (the ledger), and store_stock_balances (the rebuildable cache).
--   2. Backfills items 1:1 from the existing inventory_items catalog (145 rows as of
--      writing) — base_unit is kept exactly as inventory_items.unit is today, NOT
--      re-derived to some "truer" atomic unit (some items are natively tracked in Pkt/
--      Tin/Batch/Peti/Bundle — this migration does not second-guess that; a later,
--      explicit decision can change it item by item).
--   3. Links raw_material_id via raw_materials.inventory_item_id (reverse lookup) and
--      rate_card_id via demand_item_id-then-direct-id matching — confirmed against real
--      data: 121 items matched via demand_item_id, 1 via direct id, 23 unmatched
--      (mostly BK-prepared items priced via the recipe-cost fallback instead, e.g.
--      sambhar/dosa_batter/idli_batter, plus a handful of raw ingredients bought
--      directly with no demand-form or rate-card entry — food_besan, food_jeera,
--      food_kaju, food_poha, food_sugar, food_suji, food_black_pepper, food_mustard).
--      These stay NULL, not guessed.
--   4. Seeds item_units with just the trivial "item's own unit, factor 1" row per item.
--      NOT importing the existing unit_conversions table's rows — checked, and ZERO of
--      its 30 entries' item_id values match any inventory_items id (they use a
--      different ID space, e.g. 'gas_cylinder'/'dosa_batter' which aren't in
--      inventory_items at all). Cross-linking those is a real decision for later, not
--      something to invent here.
--   5. Backfills stock_movements as a single OPENING row per item per location:
--        - 'store': from current inventory_stock.current_qty (0 if no row).
--        - 'bk': from the MOST RECENT SUBMITTED bk_closing_stock.items (a real,
--          per-item jsonb count keyed by the same ids as inventory_items — confirmed
--          the most recent one, 2026-08-14, has all 145 items). Old inventory_movements
--          history is deliberately NOT replayed — that table has a known months-long
--          gap (2026_07_28 migration documents stock-in silently failing to record
--          price columns), so a fresh, known-good opening snapshot is more trustworthy
--          than reconstructing broken history.
--   6. Backfills store_stock_balances from those OPENING rows.
--
-- Old tables (inventory_items, inventory_stock, inventory_movements, etc.) are
-- untouched — the existing Inventory screens keep working exactly as before through
-- the whole staged build.
--
-- Rollback: see the companion 2026_08_15_store_inventory_stage1_DOWN.sql — drops
-- everything created here, in dependency order. Safe to run any time since nothing
-- outside this migration's own new tables reads from them yet.

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO locations (id, name) VALUES ('store', 'Central Store'), ('bk', 'Base Kitchen')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  base_unit TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  demand_item_id TEXT REFERENCES demand_items(id),
  raw_material_id TEXT REFERENCES raw_materials(id),
  rate_card_id TEXT REFERENCES rate_card(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_units (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit TEXT NOT NULL,
  factor NUMERIC NOT NULL,          -- qty in this unit × factor = qty in items.base_unit
  is_purchase_unit BOOLEAN NOT NULL DEFAULT TRUE,
  is_issue_unit BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (item_id, unit)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('RECEIPT','DISPATCH','WASTAGE','ADJUSTMENT','OPENING','TRANSFER')),
  qty_delta NUMERIC NOT NULL,       -- signed, in items.base_unit
  qty_entered NUMERIC,              -- what the user actually typed (audit trail for the conversion)
  unit_entered TEXT,
  rate NUMERIC,                     -- unit price at base_unit, where known
  dest_location_id TEXT REFERENCES locations(id),  -- TRANSFER's destination (store<->bk)
  dest_outlet_id TEXT,              -- DISPATCH's destination outlet code, for reporting only —
                                     -- outlets are not a tracked location, so this does NOT create
                                     -- a mirroring stock_movements row at the outlet.
  source_type TEXT NOT NULL,        -- 'receipt' | 'dispatch' | 'closing_count' | 'adjustment' | 'opening_balance'
  source_id BIGINT,                 -- points at the receipt/dispatch/closing row that caused this
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idempotency_key_uq ON stock_movements (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_item_location_idx ON stock_movements (item_id, location_id, created_at);

CREATE TABLE IF NOT EXISTS store_stock_balances (
  item_id TEXT NOT NULL REFERENCES items(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  current_qty NUMERIC NOT NULL DEFAULT 0,
  last_movement_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id)
);

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_stock_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON locations; CREATE POLICY "Service role access" ON locations FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON items; CREATE POLICY "Service role access" ON items FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON item_units; CREATE POLICY "Service role access" ON item_units FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON stock_movements; CREATE POLICY "Service role access" ON stock_movements FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON store_stock_balances; CREATE POLICY "Service role access" ON store_stock_balances FOR ALL USING (true) WITH CHECK (true);

-- ── Backfill: items, 1:1 from inventory_items ──
-- demand_item_id is only carried over if it actually resolves to a real demand_items
-- row (checked via LEFT JOIN, not assumed) — a handful of inventory_items reference a
-- demand_item_id that isn't in the active set (food_coconut_crush, food_sevya_payasam,
-- food_tadka, food_staff_dal, veg_staff_veg); this avoids an FK violation on the
-- backfill if any of those turn out to be dangling rather than just inactive.
INSERT INTO items (id, name, category, base_unit, active, demand_item_id, rate_card_id, created_at)
SELECT
  ii.id, ii.name, ii.category, ii.unit, TRUE, di.id,
  COALESCE(
    (SELECT rc.id FROM rate_card rc WHERE rc.id = ii.demand_item_id LIMIT 1),
    (SELECT rc.id FROM rate_card rc WHERE rc.id = ii.id LIMIT 1)
  ),
  now()
FROM inventory_items ii
LEFT JOIN demand_items di ON di.id = ii.demand_item_id
ON CONFLICT (id) DO NOTHING;

-- Reverse-link raw_material_id (raw_materials.inventory_item_id -> items.id)
UPDATE items i SET raw_material_id = rm.id
FROM raw_materials rm
WHERE rm.inventory_item_id = i.id AND i.raw_material_id IS NULL;

-- Trivial item_units row per item (its own unit, factor 1) — see header note on why
-- unit_conversions isn't cross-linked here.
INSERT INTO item_units (item_id, unit, factor, is_purchase_unit, is_issue_unit)
SELECT id, base_unit, 1, TRUE, TRUE FROM items
ON CONFLICT (item_id, unit) DO NOTHING;

-- ── Backfill: OPENING movements + balances, 'store' location, from inventory_stock ──
INSERT INTO stock_movements (item_id, location_id, movement_type, qty_delta, qty_entered, unit_entered, source_type, created_by, created_at)
SELECT i.id, 'store', 'OPENING', COALESCE(ist.current_qty, 0), COALESCE(ist.current_qty, 0), i.base_unit, 'opening_balance', 'migration', now()
FROM items i
LEFT JOIN inventory_stock ist ON ist.item_id = i.id;

INSERT INTO store_stock_balances (item_id, location_id, current_qty, last_movement_id, updated_at)
SELECT sm.item_id, sm.location_id, sm.qty_delta, sm.id, sm.created_at
FROM stock_movements sm
WHERE sm.movement_type = 'OPENING' AND sm.location_id = 'store'
ON CONFLICT (item_id, location_id) DO UPDATE SET current_qty = EXCLUDED.current_qty, last_movement_id = EXCLUDED.last_movement_id, updated_at = EXCLUDED.updated_at;

-- ── Backfill: OPENING movements + balances, 'bk' location, from the most recent
-- submitted bk_closing_stock (a real per-item jsonb count, keyed by the same ids as
-- inventory_items) ──
WITH latest_bk AS (
  SELECT items FROM bk_closing_stock ORDER BY date DESC LIMIT 1
)
INSERT INTO stock_movements (item_id, location_id, movement_type, qty_delta, qty_entered, unit_entered, source_type, created_by, created_at)
SELECT
  i.id, 'bk', 'OPENING',
  COALESCE((SELECT (latest_bk.items ->> i.id)::numeric FROM latest_bk), 0),
  COALESCE((SELECT (latest_bk.items ->> i.id)::numeric FROM latest_bk), 0),
  i.base_unit, 'opening_balance', 'migration', now()
FROM items i;

INSERT INTO store_stock_balances (item_id, location_id, current_qty, last_movement_id, updated_at)
SELECT sm.item_id, sm.location_id, sm.qty_delta, sm.id, sm.created_at
FROM stock_movements sm
WHERE sm.movement_type = 'OPENING' AND sm.location_id = 'bk'
ON CONFLICT (item_id, location_id) DO UPDATE SET current_qty = EXCLUDED.current_qty, last_movement_id = EXCLUDED.last_movement_id, updated_at = EXCLUDED.updated_at;

NOTIFY pgrst, 'reload schema';
