-- ─────────────────────────────────────────────────────────────────────────────
-- "Glido" and "Rishit" are the same grocery vendor — the earlier seed wrongly
-- created two rows. Merge into one ("Rishit (Glido)"): move any challans that
-- landed on Glido over to Rishit, rename Rishit, then remove the Glido row.
-- Idempotent / safe to re-run (no-ops once merged).
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE vendor_challans
  SET vendor_id = (SELECT id FROM vendors WHERE lower(name) = 'rishit' ORDER BY id LIMIT 1)
  WHERE vendor_id = (SELECT id FROM vendors WHERE lower(name) = 'glido' ORDER BY id LIMIT 1);

UPDATE vendors SET name = 'Rishit (Glido)', category = 'grocery_masala'
  WHERE lower(name) = 'rishit';

DELETE FROM vendor_item_units WHERE vendor_id IN (SELECT id FROM vendors WHERE lower(name) = 'glido');
DELETE FROM vendors WHERE lower(name) = 'glido';

NOTIFY pgrst, 'reload schema';
