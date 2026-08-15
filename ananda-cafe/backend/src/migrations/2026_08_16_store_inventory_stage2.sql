-- Store Inventory Module — Stage 2: vendor challan (delivery note) → receive → auto
-- stock-in against the Stage 1 ledger (items/item_units/locations/stock_movements/
-- store_stock_balances from 2026_08_15_store_inventory_stage1.sql).
--
-- Naming note: "challan" is already used for two UNRELATED existing things in this
-- app — the outbound "Order Challan" (purchase_orders table, App.jsx's
-- ORDER_VENDORS/OrderChallanView — a PO document TO a vendor) and the outlet
-- manager's "Verify Dispatch Challan" punch (confirming BK->outlet internal
-- transfer, nothing to do with vendors). This module is the RECEIVING side of a
-- vendor's own delivery note — a third, genuinely different thing — so it gets its
-- own table names (vendor_challans / vendor_challan_items) rather than reusing
-- purchase_orders or any other existing table, to avoid tangling three different
-- purchase/receiving lineages together. It does not read from or write to
-- purchase_orders, purchases, purchase_items, or inventory_movements/inventory_stock
-- — those keep working exactly as before.
--
-- No `vendors` table exists anywhere in the app today (checked — every "vendor"
-- reference elsewhere is either free text or a hardcoded category bucket, not a real
-- entity) so this migration adds a minimal one. Not seeded with any rows — no vendor
-- names invented; added via the UI as needed.
--
-- Unit handling: a challan line's qty is only accepted in a unit that already has a
-- factor recorded in item_units for that item (seeded in Stage 1 with just each
-- item's own base unit, factor 1). This migration does NOT add any new conversion
-- factors (e.g. Tin->Kg) — those numbers were never available in a real, checked
-- source (see Stage 1's migration notes: zero overlap between the old
-- unit_conversions table and the new item ids). The item-units admin endpoint added
-- in store.js lets an owner/store_mgr type in a factor themselves when they actually
-- need to receive in a non-base unit; nothing is guessed here.
--
-- Rollback: 2026_08_16_store_inventory_stage2_DOWN.sql.
--
-- Also fixes a real bug found while writing this stage's receive endpoint: Stage 1's
-- stock_movements.idempotency_key uniqueness was a PARTIAL index (WHERE idempotency_key
-- IS NOT NULL). Postgres will only use a partial index as an ON CONFLICT arbiter if the
-- same WHERE predicate is restated in the ON CONFLICT clause — which supabase-js's
-- .upsert(..., {onConflict}) never does, so every idempotent receipt upsert would have
-- failed with "no unique or exclusion constraint matching the ON CONFLICT specification".
-- A plain (non-partial) UNIQUE constraint fixes it — Postgres already treats multiple
-- NULLs as non-conflicting under a plain UNIQUE constraint, so this loses nothing versus
-- the partial index; it was never necessary. Swapped here since nothing has written a
-- non-null idempotency_key into stock_movements yet (only Stage 1's OPENING backfill
-- rows exist, all NULL) — safe to change now, would not be once real data depends on it.

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_idempotency_key_uq;
DROP INDEX IF EXISTS stock_movements_idempotency_key_uq;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_idempotency_key_uq UNIQUE (idempotency_key);

CREATE TABLE IF NOT EXISTS vendors (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendor_challans (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT REFERENCES vendors(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  challan_number TEXT,               -- the vendor's own document number, if they gave one
  challan_date DATE NOT NULL,        -- IST calendar date (see backend/src/helpers.js todayIST)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'received', 'cancelled')),
  bill_photo_path TEXT,              -- storage path in the existing 'photos' bucket, not a URL
                                      -- (signed URLs are regenerated fresh on every read, same
                                      -- pattern as employees.js's KYC docs — a stored URL would
                                      -- go dead after its 24h signed-URL expiry)
  no_bill_reason TEXT,               -- filled in when the vendor gave no computerized bill —
                                      -- API requires bill_photo_path OR no_bill_reason before
                                      -- a challan can be received, never both empty
  total_amount NUMERIC,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by TEXT,
  received_at TIMESTAMPTZ,
  idempotency_key TEXT UNIQUE          -- plain UNIQUE, not a partial index — see the
                                        -- stock_movements fix above for why; multiple
                                        -- NULLs are already fine under a plain constraint
);
CREATE INDEX IF NOT EXISTS vendor_challans_date_idx ON vendor_challans (challan_date, location_id);

CREATE TABLE IF NOT EXISTS vendor_challan_items (
  id BIGSERIAL PRIMARY KEY,
  challan_id BIGINT NOT NULL REFERENCES vendor_challans(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  qty_entered NUMERIC NOT NULL,      -- what the user actually typed
  unit_entered TEXT NOT NULL,
  qty_base NUMERIC NOT NULL,         -- qty_entered converted via item_units factor, persisted
  unit_price NUMERIC,                -- price per base unit (this row IS the price history —
                                      -- no separate table; queried directly for "last price paid")
  line_total NUMERIC
);
CREATE INDEX IF NOT EXISTS vendor_challan_items_item_idx ON vendor_challan_items (item_id, challan_id);

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_challan_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON vendors; CREATE POLICY "Service role access" ON vendors FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON vendor_challans; CREATE POLICY "Service role access" ON vendor_challans FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role access" ON vendor_challan_items; CREATE POLICY "Service role access" ON vendor_challan_items FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
