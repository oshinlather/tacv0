-- Crockery/Packaging "should consume" rule (sec23, sec56, elan, gaursid): every
-- dine-in item sold gets 1 Wooden Plate + 2 Bio Spoon + 1 Paper Bowl; every
-- pickup/delivery order gets 1 Dosa Box Small + 2x 50ML Container + 2 Bio Spoon +
-- 1 Podi Idli Container. Bio Spoon (100/Pkt) and Paper Bowl (50/Pkt) already had
-- unit_conversions rows. 50ML Container and Podi Idli Container had NONE at all
-- (not just for this feature — nothing in the app could convert their Pkt count
-- to pieces), so the rule couldn't compute a correct should-consume figure without
-- these. Confirmed 50 pieces/Pkt for both directly with the owner before inserting.
--
-- NOTE: This was already run directly against production (owner explicitly asked
-- for the DB rows to be added, not just hardcoded in application code) — this file
-- exists to document the change; running it again is a harmless no-op via the
-- existence check.
insert into unit_conversions (unit_type, item_id, item_name, qty, base_unit, notes, active)
select 'Pkt', 'container_50ml', '50ML Container', 50, 'Piece', '1 Pkt = 50 Piece', true
where not exists (select 1 from unit_conversions where item_id = 'container_50ml');

insert into unit_conversions (unit_type, item_id, item_name, qty, base_unit, notes, active)
select 'Pkt', 'podi_idli_container', 'Podi Idli Container', 50, 'Piece', '1 Pkt = 50 Piece', true
where not exists (select 1 from unit_conversions where item_id = 'podi_idli_container');
