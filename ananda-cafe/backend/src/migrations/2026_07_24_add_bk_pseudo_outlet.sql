-- Base Kitchen needs its own demand/ordering flow (like the 4 outlets), and
-- demands.outlet_id has a FK constraint into outlets. Add a pseudo-outlet row
-- so BK demands (outlet_id='bk') can be inserted. Not surfaced in any outlet
-- picker UI — the frontend's OUTLETS array is hardcoded and does not query
-- this table, so this row only exists to satisfy the FK.
INSERT INTO outlets (id, name, short_name, is_franchise)
VALUES ('bk', 'Base Kitchen', 'BK', false)
ON CONFLICT (id) DO NOTHING;
