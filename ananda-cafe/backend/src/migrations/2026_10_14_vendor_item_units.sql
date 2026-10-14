-- Store Inventory Module — per-vendor unit conversions for receiving.
--
-- Problem this solves: a vendor bills in ITS OWN units (Dheeraj Traders sells Duster by
-- "Packe", containers by "Box", poly by "Kgs") while our store master tracks each item in
-- its own base unit (Pcs / Pkt / Can). Receiving meant doing that conversion in the head,
-- line by line — the "big confusion" the owner flagged. This table records, per vendor +
-- item, the vendor's unit name and how many base units one of them is, so the draft challan
-- can SHOW "Duster (1 Packe = 10 Pcs)" next to each name as a reminder.
--
-- NOT the same as item_units (that's the GLOBAL per-item conversion the create/receive path
-- uses to turn qty_entered into qty_base). This one is per-VENDOR and, for now, DISPLAY ONLY
-- — it does not change how stock or price is computed. Different vendors can hold a different
-- unit/factor for the same item, which is exactly why it's keyed by vendor and kept separate
-- from the global item_units factor.
--
-- factor meaning (mirrors item_units' own convention): 1 vendor_unit = factor × item.base_unit.
-- e.g. Duster base_unit 'Pcs', vendor sells a 'Packe' of 10 → vendor_unit='Packe', factor=10.

CREATE TABLE IF NOT EXISTS vendor_item_units (
  id          BIGSERIAL PRIMARY KEY,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  item_id     TEXT   NOT NULL REFERENCES items(id)   ON DELETE CASCADE,
  vendor_unit TEXT   NOT NULL,          -- the vendor's own unit name, e.g. 'Packe', 'Box', 'Katta'
  factor      NUMERIC NOT NULL CHECK (factor > 0),  -- 1 vendor_unit = factor × base_unit
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (vendor_id, item_id)           -- one vendor sells a given item in one unit
);

CREATE INDEX IF NOT EXISTS idx_vendor_item_units_vendor ON vendor_item_units (vendor_id);
