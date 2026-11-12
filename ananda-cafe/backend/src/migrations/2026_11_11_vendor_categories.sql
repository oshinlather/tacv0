-- ─────────────────────────────────────────────────────────────────────────────
-- Give vendors a category so the Order-from-Vendor flow can offer a vendor dropdown
-- scoped to the order's bucket (packaging orders → packaging vendors, etc.). The
-- category value matches the ORDER_VENDORS bucket id used on the frontend
-- ('packaging_cleaning', 'grocery_masala', …). NULL = uncategorised (shown everywhere).
--
-- Seeds the known real vendors. Idempotent on name (case-insensitive) so re-running,
-- or a name the Order flow already auto-created, won't duplicate.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS category TEXT;

INSERT INTO vendors (name, category)
SELECT v.name, v.category FROM (VALUES
  ('Dheeraj Traders', 'packaging_cleaning'),
  ('Areca Plates',    'packaging_cleaning'),
  ('Piyush',          'packaging_cleaning'),
  ('Kapil',           'grocery_masala'),
  ('Rishit (Glido)',  'grocery_masala')
) AS v(name, category)
WHERE NOT EXISTS (SELECT 1 FROM vendors e WHERE lower(e.name) = lower(v.name));

-- Tag any already-existing rows for these names (e.g. created before this migration).
UPDATE vendors SET category = 'packaging_cleaning'
  WHERE category IS NULL AND lower(name) IN ('dheeraj traders', 'areca plates', 'piyush');
UPDATE vendors SET category = 'grocery_masala'
  WHERE category IS NULL AND lower(name) IN ('kapil', 'rishit (glido)');

NOTIFY pgrst, 'reload schema';
