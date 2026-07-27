-- inventory_movements never actually had unit_price/total_price columns, even though
-- POST /api/inventory/stock-in has been trying to write them on every stock-in for
-- months. The insert was failing silently (error never checked), so no stock-in
-- movement has been recorded at all since ~2026-04-15 — Daily Stock Movements, the
-- Inventory Ledger, and "last purchase price" have all been blind to real stock-ins
-- since then, even though purchase orders were still correctly flipping to 'received'.
-- The backend now falls back to recording the movement without prices if these columns
-- are missing (so stock-in itself is fixed either way), but run this once in the
-- Supabase SQL Editor to restore per-unit purchase price tracking too.

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_price NUMERIC;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS total_price NUMERIC;
