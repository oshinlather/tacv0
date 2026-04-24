-- Option: Add coconut_crush back to rate_card but with coconut's price (₹80/Pcs)
-- This way, historical dispatches with coconut_crush get priced correctly.
-- The BK recipe coconut_crush still exists for recipe costing tab,
-- but dispatched items hit rate_card first (rate card takes priority over recipe).

UPDATE rate_card SET active = true, unit = 'Pcs', price = 80, category = 'Vegetable', name = 'Coconut' 
WHERE id = 'coconut_crush';

-- If the above didn't find it (was already deleted), insert it:
INSERT INTO rate_card (id, name, category, unit, price, active)
VALUES ('coconut_crush', 'Coconut', 'Vegetable', 'Pcs', 80, true)
ON CONFLICT (id) DO UPDATE SET name = 'Coconut', category = 'Vegetable', unit = 'Pcs', price = 80, active = true;

-- Verify both coconut entries:
SELECT id, name, category, unit, price, active FROM rate_card WHERE id IN ('coconut', 'coconut_crush');
