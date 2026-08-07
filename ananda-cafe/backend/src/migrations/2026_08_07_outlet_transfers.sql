-- Inter-outlet stock transfers — lets an outlet manager send stock directly to another
-- outlet when it's short (bypassing Base Kitchen dispatch), with the receiving outlet
-- confirming what actually arrived. Two-step, mirroring the existing demands
-- dispatch/receive flow (dispatch_items vs received_items on demands): sent_items is the
-- sender's claim at send time, received_items is the receiver's confirmed actual, kept as
-- a separate column so a shortage/damage discrepancy stays visible instead of being
-- silently overwritten. Only 'confirmed' transfers (received_items set) count toward
-- either outlet's consumed-material math — see computeStockUsageForDate in salesRoutes.js.

CREATE TABLE IF NOT EXISTS outlet_transfers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL,
  from_outlet_id TEXT NOT NULL REFERENCES outlets(id),
  to_outlet_id TEXT NOT NULL REFERENCES outlets(id),
  sent_items JSONB NOT NULL DEFAULT '{}',       -- {item_id: qty} — sender's claim at send time
  sent_items_units JSONB DEFAULT '{}',          -- {item_id: unit}
  received_items JSONB,                          -- {item_id: qty} — receiver's confirmed actual; null = pending
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  note TEXT,
  sent_by TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outlet_transfers_date ON outlet_transfers (date);
CREATE INDEX IF NOT EXISTS idx_outlet_transfers_from ON outlet_transfers (from_outlet_id, date);
CREATE INDEX IF NOT EXISTS idx_outlet_transfers_to ON outlet_transfers (to_outlet_id, date, status);

ALTER TABLE outlet_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON outlet_transfers FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
