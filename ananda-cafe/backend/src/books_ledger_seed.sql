-- ═══════════════════════════════════════════════════════════════
--  BOOKS LEDGER — historical seed from the "TAC - Books" WhatsApp group
--  Covers the group's full visible history: 20 Jul 2026 – 23 Jul 2026.
--  Run AFTER books_ledger has been created (see schema.sql).
--
--  Every amount below was verified against the actual UPI/Paytm/GPay
--  transaction screenshot where one was attached — not guessed from the
--  WhatsApp caption. One entry ("water tanker 31", 19 Jul, 2:29 PM) could
--  not be verified because it replies to a photo sent before this device
--  was added to the group, so it's inserted with amount 0 and
--  needs_review = true for you to fill in manually.
-- ═══════════════════════════════════════════════════════════════

INSERT INTO books_ledger
  (entry_date, entry_time, submitted_by, description, category, amount, payment_mode, vendor_or_recipient, is_advance, advance_to, source, raw_message, needs_review)
VALUES
  ('2026-07-19', '14:29', 'Parveen Lather', 'water tanker 31', 'utilities_water', 0, NULL, NULL, FALSE, NULL, 'whatsapp', 'water tanker 31', TRUE),
  ('2026-07-19', '23:23', 'Parveen Lather', 'cash handover / advance', 'staff_advance', 2060, 'upi', 'GANGA RAM', TRUE, 'Ganga', 'whatsapp', '[photo, no caption] — UPI ₹2,060 to GANGA RAM', FALSE),
  ('2026-07-20', '12:36', 'Parveen Lather', 'vendor payment (uncaptioned)', 'vendor_payment', 9300, 'paytm', 'SUMAN MITTAL', FALSE, NULL, 'whatsapp', '[photo, no caption] — Paytm ₹9,300 to SUMAN MITTAL', TRUE),
  ('2026-07-20', '21:17', 'Parveen Lather', 'ac installation', 'repairs_maintenance', 19000, 'gpay', 'Mr FIROJ HUSAIN', FALSE, NULL, 'whatsapp', 'ac installation', FALSE),
  ('2026-07-21', '20:56', 'Parveen Lather', 'electric wires', 'utilities_electric', 3740, 'cash', NULL, FALSE, NULL, 'whatsapp', '3740- electric wires', FALSE),
  ('2026-07-21', '23:20', 'Aishwarya Singh', 'gas payment', 'utilities_gas', 189060, 'cash', NULL, FALSE, NULL, 'whatsapp', '189060- gas payment', FALSE),
  ('2026-07-21', '23:20', 'Aishwarya Singh', '31 ki dairy', 'cogs_dairy', 34878, 'cash', NULL, FALSE, NULL, 'whatsapp', '34878- 31 ki dairy', FALSE),
  ('2026-07-22', '08:27', 'Parveen Lather', 'hyperpure - 31 dairy', 'cogs_dairy', 2720, 'cash', 'Hyperpure', FALSE, NULL, 'whatsapp', '1023+1109+588 =2,720 hyperpure - 31 dairy (edited)', FALSE),
  ('2026-07-22', '13:13', 'Aishwarya Singh', 'patthar for table top', 'repairs_maintenance', 3500, 'cash', NULL, FALSE, NULL, 'whatsapp', '3500- patthar for table top', FALSE),
  ('2026-07-22', '16:22', 'Parveen Lather', 'nariyal', 'cogs_other', 52740, 'cash', NULL, FALSE, NULL, 'whatsapp', '49000+3740=52,740- nariyal', FALSE),
  ('2026-07-22', '19:58', 'Parveen Lather', 'shankar dairy advance', 'staff_advance', 40000, 'cash', 'Shankar', TRUE, 'Shankar', 'whatsapp', '40000- shankar dairy advance', FALSE),
  ('2026-07-22', '20:06', 'Parveen Lather', 'prakash sec 23 advance', 'staff_advance', 2000, 'paytm', 'HARADEV RAM', TRUE, 'Prakash', 'whatsapp', 'prakash sec 23 advance', FALSE),
  ('2026-07-22', '21:46', 'Parveen Lather', 'porter for khana', 'labor_porter', 400, 'cash', NULL, FALSE, NULL, 'whatsapp', '400 - porter for khana', FALSE),
  ('2026-07-23', '13:01', 'Parveen Lather', 'shivam 31 advance', 'staff_advance', 2000, 'upi', 'SHIVAM KUMAR', TRUE, 'Shivam', 'whatsapp', 'shivam 31 advance', FALSE),
  ('2026-07-23', '13:27', 'Parveen Lather', 'amit electrician', 'utilities_electric', 5832, 'gpay', 'AMIT KUMAR', FALSE, NULL, 'whatsapp', 'amit electrician -5832', FALSE),
  ('2026-07-23', '17:39', 'Aishwarya Singh', 'milk 14', 'cogs_dairy', 5825, 'cash', NULL, FALSE, NULL, 'whatsapp', '5825- milk 14', FALSE),
  ('2026-07-23', '19:03', 'Parveen Lather', 'water tanker sec23', 'utilities_water', 700, 'upi', 'NEELAM YADAV', FALSE, NULL, 'whatsapp', 'water tanker sec23', FALSE),
  ('2026-07-23', '19:03', 'Parveen Lather', 'porter chair', 'labor_porter', 421, 'cash', NULL, FALSE, NULL, 'whatsapp', '421 - porter chair', FALSE),
  ('2026-07-23', '19:46', 'Parveen Lather', 'sahil advance', 'staff_advance', 5000, 'upi', 'SAHIL', TRUE, 'Sahil', 'whatsapp', 'sahil advance', FALSE),
  ('2026-07-23', '20:01', 'Parveen Lather', 'vegetable', 'cogs_vegetables', 8650, 'upi', 'NEERAJ TRADING COMPANY', FALSE, NULL, 'whatsapp', 'vegetable', FALSE),
  ('2026-07-23', '20:46', 'Parveen Lather', '31 milk', 'cogs_dairy', 109, 'paytm', 'TEJRAM', FALSE, NULL, 'whatsapp', '31 milk', FALSE),
  ('2026-07-23', '20:52', 'Aishwarya Singh', 'porter 23', 'labor_porter', 60, 'cash', NULL, FALSE, NULL, 'whatsapp', '60- porter 23', FALSE),
  ('2026-07-23', '21:47', 'Aishwarya Singh', 'Pani (water)', 'utilities_water', 7870, 'upi', 'SUNIL KUMAR', FALSE, NULL, 'whatsapp', 'Pani', FALSE),
  ('2026-07-23', '21:48', 'Aishwarya Singh', 'Porter 56', 'labor_porter', 169, 'upi', 'MD SHAMSHAD', FALSE, NULL, 'whatsapp', 'Porter 56', FALSE),
  ('2026-07-23', '23:16', 'Parveen Lather', 'Rahul advance', 'staff_advance', 3000, 'upi', 'RAHUL KUMAR RAY', TRUE, 'Rahul', 'whatsapp', 'Rahul advance', FALSE);
