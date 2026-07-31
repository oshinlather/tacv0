-- ═══════════════════════════════════════════════════════════════
-- OWNER TODOS — initial seed from the "TAC Managers" WhatsApp group,
-- 28 Jul 2026 (day-end report summary photo + surrounding discussion).
-- Run AFTER owner_todos has been created (see migrations/2026_07_28_owner_todos.sql).
--
-- The two rows marked needs_review = TRUE were hard to read on the
-- handwritten note's photo (name/amount uncertain) — verify against the
-- original photo in WhatsApp before paying out.
-- ═══════════════════════════════════════════════════════════════

INSERT INTO owner_todos
  (title, category, amount, status, priority, source, raw_message, needs_review, created_by)
VALUES
  -- Operational issues (from "Operational issue" section of the day-end note)
  ('Sound box not working — repair or replace', 'operational_issue', NULL, 'open', 'high', 'whatsapp', 'Operational issue: Sound Box', FALSE, 'Parveen Lather'),
  ('Company phone issue', 'operational_issue', NULL, 'open', 'normal', 'whatsapp', 'Operational issue: Company Phone', FALSE, 'Parveen Lather'),
  ('Company SIM issue', 'operational_issue', NULL, 'open', 'normal', 'whatsapp', 'Operational issue: Company Sim', FALSE, 'Parveen Lather'),
  ('Water dispenser (guest) not working — fix', 'operational_issue', NULL, 'open', 'high', 'whatsapp', 'Operational issue: Water Dispenser (guest)', FALSE, 'Parveen Lather'),
  ('Fan not working — fix', 'operational_issue', NULL, 'open', 'normal', 'whatsapp', 'Operational issue: Fan not working', FALSE, 'Parveen Lather'),

  -- Complaints / reviews (from "Complaints" + "Google Reviews" section)
  ('Review and resolve today''s refund / NC / cancellation complaints', 'complaint', NULL, 'open', 'high', 'whatsapp', 'Complaints: Refund/NC/cancel', FALSE, 'Parveen Lather'),
  ('Verify Google Reviews figure for the day (noted as "0.8" on the report — confirm actual count/rating)', 'complaint', NULL, 'open', 'low', 'whatsapp', 'Google Reviews: 0.8', TRUE, 'Parveen Lather'),

  -- Vendor payments due (from the numbered list, totalling ₹1,243 on the note)
  ('Pay vendor — Board', 'vendor_payment', 354, 'open', 'normal', 'whatsapp', 'Vendor Board - 354', FALSE, 'Parveen Lather'),
  ('Pay vendor — Plumber', 'vendor_payment', 178, 'open', 'normal', 'whatsapp', 'Vendor Plumber - 178', FALSE, 'Parveen Lather'),
  ('Pay vendor — Painter', 'vendor_payment', 95, 'open', 'normal', 'whatsapp', 'Vendor Painter - 95', FALSE, 'Parveen Lather'),
  ('Pay vendor — Stair', 'vendor_payment', 190, 'open', 'normal', 'whatsapp', 'Vendor Stair - 190', FALSE, 'Parveen Lather'),
  ('Settle — Parveen Sir', 'vendor_payment', 357, 'open', 'normal', 'whatsapp', 'Parveen Sir - 357 (handwriting unclear, verify name/amount against photo)', TRUE, 'Parveen Lather'),
  ('Settle — Amit Sir', 'vendor_payment', 69, 'open', 'normal', 'whatsapp', 'Amit Sir - 69', FALSE, 'Parveen Lather'),

  -- Process / communication follow-ups (from the group's stated purpose + thread)
  ('Ensure the day-end report photo is posted daily before closing, every outlet', 'process', NULL, 'open', 'normal', 'whatsapp', '"har roj niklne se phele dalna" — Parveen Lather', FALSE, 'Parveen Lather'),
  ('Follow up with Virat — missed posting this morning''s report photo, get it posted', 'process', NULL, 'open', 'normal', 'whatsapp', '"Sir photo click nhi kr paya morning m daal dunga" — #virat', FALSE, 'Parveen Lather');
