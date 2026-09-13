-- Batter (Dosa/Idli/Vada) Batch→Kg unit backfill.
--
-- Batters were demanded/dispatched in BATCH until 2026-08-11, then switched to Kg — but
-- demand records never tagged their unit (items_units[<batter>] is null), so every
-- backend cost path that falls back to the catalog default unit ("Batch") treated the
-- post-cutover Kg values as Batch and multiplied them by the batch size (×18/×16/×2),
-- and the raw-sum displays mixed Batch and Kg in one column. Franchise Billing was fixed
-- in the frontend by resolving each record's unit off the 2026-08-11 cutover; this does
-- the same at the data level so P&L / RM Audit / BK consumption / stock-usage agree.
--
-- What it does:
--   1. Tags every PRE-cutover batter demand record with items_units[<batter>] = 'Batch'
--      (only where the tag is missing — idempotent, never overrides a real explicit unit).
--      convFactorFor then converts those correctly via unit_conversions (1 Batch = N Kg).
--   2. Flips the catalog default unit for Dosa/Idli/Vada Batter in demand_items to 'Kg',
--      so POST-cutover records (left untagged) resolve to Kg (factor 1) — no ×batch
--      inflation. New demands default to Kg too.
--
-- Post-cutover records are deliberately NOT mass-tagged — the new 'Kg' default covers them,
-- and the Franchise Billing frontend already resolves them to Kg by the cutover date.
--
-- REVIEW BEFORE RUNNING — counts the records this touches, split by era:
--   SELECT CASE WHEN date < DATE '2026-08-11' THEN 'pre (→Batch)' ELSE 'post (stays Kg)' END AS era,
--          count(*) FILTER (WHERE items ? 'dosa_batter' OR dispatch_items ? 'dosa_batter') AS dosa,
--          count(*) FILTER (WHERE items ? 'idli_batter' OR dispatch_items ? 'idli_batter') AS idli,
--          count(*) FILTER (WHERE items ? 'vada_batter' OR dispatch_items ? 'vada_batter') AS vada
--   FROM demands
--   WHERE items ?| array['dosa_batter','idli_batter','vada_batter']
--      OR dispatch_items ?| array['dosa_batter','idli_batter','vada_batter']
--   GROUP BY 1;
--
-- Rollback: 2026_09_14_batter_unit_backfill_DOWN.sql.

-- 0. Correct the Batch→Kg factor first — owner-confirmed 1 Dosa Batch = 9 Kg, 1 Idli Batch
--    = 8 Kg (Vada = 2). Some rows carried 18/16 (double). This MUST be right before the
--    Batch tags below take effect, or pre-cutover history converts at twice the real weight.
UPDATE unit_conversions SET qty = 9, notes = '1 Batch = 9 Kg' WHERE item_id = 'dosa_batter' AND unit_type = 'Batch';
UPDATE unit_conversions SET qty = 8, notes = '1 Batch = 8 Kg' WHERE item_id = 'idli_batter' AND unit_type = 'Batch';
UPDATE unit_conversions SET qty = 2, notes = '1 Batch = 2 Kg' WHERE item_id = 'vada_batter' AND unit_type = 'Batch';

-- 1. Tag pre-cutover batter records as Batch (fills only missing tags → idempotent).
UPDATE demands
SET items_units = COALESCE(items_units, '{}'::jsonb)
  || CASE WHEN (items ? 'dosa_batter' OR dispatch_items ? 'dosa_batter') AND (items_units ->> 'dosa_batter') IS NULL
          THEN jsonb_build_object('dosa_batter', 'Batch') ELSE '{}'::jsonb END
  || CASE WHEN (items ? 'idli_batter' OR dispatch_items ? 'idli_batter') AND (items_units ->> 'idli_batter') IS NULL
          THEN jsonb_build_object('idli_batter', 'Batch') ELSE '{}'::jsonb END
  || CASE WHEN (items ? 'vada_batter' OR dispatch_items ? 'vada_batter') AND (items_units ->> 'vada_batter') IS NULL
          THEN jsonb_build_object('vada_batter', 'Batch') ELSE '{}'::jsonb END
WHERE date < DATE '2026-08-11'
  AND (items ?| array['dosa_batter','idli_batter','vada_batter']
    OR dispatch_items ?| array['dosa_batter','idli_batter','vada_batter']);

-- 2. Default unit → Kg so post-cutover (untagged) batter records resolve to Kg in costing.
UPDATE demand_items SET unit = 'Kg' WHERE id IN ('dosa_batter', 'idli_batter', 'vada_batter');

NOTIFY pgrst, 'reload schema';
