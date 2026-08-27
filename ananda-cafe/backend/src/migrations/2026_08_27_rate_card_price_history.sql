-- Date-effective rate-card pricing — price ledger.
--
-- Until now rate_card.price was a single mutable number: every cost in the app (P&L, RM
-- Audit, Finance, BK recipe costs, franchise billing) reads it as "the" price, so editing
-- it silently rewrites the cost of every PAST day too. That makes it impossible to have
-- challan/purchase-driven prices without corrupting history.
--
-- This table is the price ledger. A row = "from this effective_date, this rate_card item
-- costs this much". Costing resolves a date D to the latest row with effective_date <= D
-- (tie-break created_at DESC — "latest price paid wins"); an item with no newer row simply
-- carries its previous price forward. rate_card.price stays as the CURRENT price (what the
-- master screen shows/edits and a defensive fallback), kept mirrored to the newest row.
--
-- Effective date is FORWARD-ONLY by product decision: a challan's price takes effect from
-- the date it was RECEIVED (challan) / submitted (purchase), never back-dated — so a late
-- entry can never reprice a day before it landed.
--
-- Baseline seed below stamps every active item's CURRENT price at a floor date (2000-01-01)
-- so any historical as-of lookup resolves to exactly today's price. Result: the day this
-- ships, every past P&L/audit number is byte-identical to before — only prices dated after
-- a real challan/purchase/manual change ever move.
--
-- Writers that append here: vendor challan receive (source='challan'), cash/dairy purchase
-- submit (source='purchase'), and manual rate-card add/edit (source='manual'). See
-- salesRoutes.js appendRateCardPrice / vendorChallans.js receive.
--
-- Rollback: 2026_08_27_rate_card_price_history_DOWN.sql.

CREATE TABLE IF NOT EXISTS rate_card_prices (
  id BIGSERIAL PRIMARY KEY,
  rate_card_id   TEXT NOT NULL REFERENCES rate_card(id),
  effective_date DATE NOT NULL,          -- IST date the price takes effect (forward-only)
  price          NUMERIC NOT NULL,       -- per rate_card.unit
  source         TEXT NOT NULL,          -- 'seed' | 'challan' | 'purchase' | 'manual'
  source_id      TEXT,                   -- challan/purchase id, for traceability
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every as-of lookup is (rate_card_id, latest effective_date <= D, then latest created_at).
CREATE INDEX IF NOT EXISTS rate_card_prices_lookup ON rate_card_prices (rate_card_id, effective_date DESC, created_at DESC);

ALTER TABLE rate_card_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role access" ON rate_card_prices;
CREATE POLICY "Service role access" ON rate_card_prices FOR ALL USING (true) WITH CHECK (true);

-- Baseline: one row per active item at the floor date = current price. Idempotent — only
-- seeds items that have no ledger row yet, so re-running never duplicates the baseline.
INSERT INTO rate_card_prices (rate_card_id, effective_date, price, source)
SELECT rc.id, DATE '2000-01-01', COALESCE(rc.price, 0), 'seed'
FROM rate_card rc
WHERE rc.active = true
  AND NOT EXISTS (SELECT 1 FROM rate_card_prices p WHERE p.rate_card_id = rc.id);

NOTIFY pgrst, 'reload schema';
