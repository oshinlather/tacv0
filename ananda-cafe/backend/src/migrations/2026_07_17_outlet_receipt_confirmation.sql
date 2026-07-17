-- Outlet-side receipt confirmation, closing the demand -> dispatch -> receipt loop.
-- Run this once in the Supabase SQL Editor.

-- received_items may differ from dispatch_items if the outlet finds a shortage or
-- damage on arrival — kept separate from dispatch_items (BK's record of what left
-- the kitchen) so neither side's record gets silently overwritten by the other.
ALTER TABLE demands ADD COLUMN IF NOT EXISTS received_items JSONB;
ALTER TABLE demands ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE demands ADD COLUMN IF NOT EXISTS received_by TEXT;
