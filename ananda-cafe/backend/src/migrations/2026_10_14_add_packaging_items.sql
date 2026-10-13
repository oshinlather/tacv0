-- ─────────────────────────────────────────────────────────────────────────────
-- Add 4 Packaging items to the Store catalog (`items`) so they appear in the
-- "📦 Packaging & Cleaning" 10-day RM order screen (VendorChallans OrderView,
-- which lists every active `items` row whose category ∈ {'Packaging','Cleaning'}).
--
-- Names, ids and units are taken verbatim from the outlet-demand side
-- (DEMAND_SECTIONS → demand_items) so the Monthly BK / Store audit — which
-- compares stock-in vs stock-out as raw numbers with NO unit conversion —
-- reconciles correctly. Units deliberately match demand (Pcs/Bundle/Pkt), not
-- the operator's physical buying unit, per that audit constraint.
--
--   id          name         category    base_unit   demand unit
--   stirrer     Stirrer      Packaging   Pkt         Pkt
--   clean_wrap  Clean Wrap   Packaging   Pcs         Pcs
--   tissues     Tissues      Packaging   Bundle      Bundle
--   chef_cap    Chef Cap     Packaging   Pkt         Pkt
--
-- demand_item_id / rate_card_id are linked via NULL-safe subqueries (same pattern
-- as the stage-1 backfill): they resolve to the matching master row if it exists,
-- else NULL — no FK violation either way. New items start at 0 stock; store.js's
-- /stock read defaults a missing balance row to current_qty 0, so no OPENING
-- movement or store_stock_balances seed is needed — the first challan receive
-- will create the RECEIPT movement + balance.
-- Idempotent: ON CONFLICT DO NOTHING, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO items (id, name, category, base_unit, active, demand_item_id, rate_card_id, created_at)
VALUES
  ('stirrer',    'Stirrer',    'Packaging', 'Pkt',    TRUE,
     (SELECT id FROM demand_items WHERE id = 'stirrer'),
     (SELECT id FROM rate_card   WHERE id = 'stirrer'    AND active = TRUE LIMIT 1), now()),
  ('clean_wrap', 'Clean Wrap', 'Packaging', 'Pcs',    TRUE,
     (SELECT id FROM demand_items WHERE id = 'clean_wrap'),
     (SELECT id FROM rate_card   WHERE id = 'clean_wrap' AND active = TRUE LIMIT 1), now()),
  ('tissues',    'Tissues',    'Packaging', 'Bundle', TRUE,
     (SELECT id FROM demand_items WHERE id = 'tissues'),
     (SELECT id FROM rate_card   WHERE id = 'tissues'    AND active = TRUE LIMIT 1), now()),
  ('chef_cap',   'Chef Cap',   'Packaging', 'Pkt',    TRUE,
     (SELECT id FROM demand_items WHERE id = 'chef_cap'),
     (SELECT id FROM rate_card   WHERE id = 'chef_cap'   AND active = TRUE LIMIT 1), now())
ON CONFLICT (id) DO NOTHING;

-- Trivial item_units row per new item (its own base unit, factor 1) — matches how
-- every existing item was seeded in stage-1.
INSERT INTO item_units (item_id, unit, factor, is_purchase_unit, is_issue_unit)
SELECT id, base_unit, 1, TRUE, TRUE
FROM items
WHERE id IN ('stirrer', 'clean_wrap', 'tissues', 'chef_cap')
ON CONFLICT (item_id, unit) DO NOTHING;
