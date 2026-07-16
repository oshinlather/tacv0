-- Base Kitchen inventory audit loop (Stage 1 + Stage 3 of the store-inventory rebuild).
-- Run this once in the Supabase SQL Editor before deploying the matching backend code.

-- Stage 1: trace which PO a stock-in movement came from receiving.
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS po_id text;

-- Stage 3: Base Kitchen's own daily physical count, audited against the running
-- inventory_stock balance. Mirrors closing_stocks' shape, minus outlet_id (BK has one
-- store, not per-outlet). submitted_by is plain text (not a Supabase Auth FK) to match
-- how inventory_movements.submitted_by is already used in this app.
CREATE TABLE IF NOT EXISTS bk_closing_stock (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  items JSONB NOT NULL DEFAULT '{}',  -- {item_id: counted_quantity, ...}
  submitted_by TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);
