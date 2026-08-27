-- Category-wise markup for Franchise Settings. Until now every franchise outlet had one
-- flat markup_pct applied to every item in its bill regardless of category (Vegetables,
-- Packaging, Food, ...) — the owner wants to charge different markups per category (e.g.
-- a lower markup on Packaging, higher on prepared Food). Stored as a JSONB map of
-- category_id -> pct (DEMAND_SECTIONS ids: food/dairy/vegetable/grocery/masala/packaging/
-- cleaning/gas/cold_drink) so it can hold any subset of categories without a schema change
-- per category. Any category NOT present in the map falls back to the row's own flat
-- markup_pct — this column is additive on top of the existing behavior, not a replacement,
-- so an outlet with no overrides configured keeps working exactly as before.
ALTER TABLE franchise_settings ADD COLUMN IF NOT EXISTS category_markup JSONB NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
