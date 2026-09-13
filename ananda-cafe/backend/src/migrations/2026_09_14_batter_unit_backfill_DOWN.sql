-- Rollback for 2026_09_14_batter_unit_backfill.sql.
-- Removes the 'Batch' tags this migration added to pre-cutover batter records and restores
-- the catalog default unit. NOTE: this can't tell an added tag from a pre-existing real one,
-- so it only strips Batch tags on pre-cutover dates (the exact set the UP migration wrote).
-- Restoring the default to 'Batch' will re-introduce the ×batch inflation for post-cutover
-- Kg records, so only roll back if you're also reverting the whole batter-unit change.

UPDATE demands
SET items_units = (items_units - 'dosa_batter') - 'idli_batter' - 'vada_batter'
      || CASE WHEN (items_units ->> 'dosa_batter') <> 'Batch' THEN jsonb_build_object('dosa_batter', items_units ->> 'dosa_batter') ELSE '{}'::jsonb END
      || CASE WHEN (items_units ->> 'idli_batter') <> 'Batch' THEN jsonb_build_object('idli_batter', items_units ->> 'idli_batter') ELSE '{}'::jsonb END
      || CASE WHEN (items_units ->> 'vada_batter') <> 'Batch' THEN jsonb_build_object('vada_batter', items_units ->> 'vada_batter') ELSE '{}'::jsonb END
WHERE date < DATE '2026-08-11'
  AND (items_units ->> 'dosa_batter' = 'Batch' OR items_units ->> 'idli_batter' = 'Batch' OR items_units ->> 'vada_batter' = 'Batch');

UPDATE demand_items SET unit = 'Batch' WHERE id IN ('dosa_batter', 'idli_batter');

NOTIFY pgrst, 'reload schema';
