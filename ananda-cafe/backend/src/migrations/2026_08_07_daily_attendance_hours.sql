-- Daily Attendance (P&L page) — tracks actual hours worked per employee per
-- day, not just a leave/present flag. Powers the new "Attendance" pill: owner
-- enters each employee's hours for a day, across all outlets/BK/top mgmt;
-- OT = hours beyond the 11-hour standard shift; anyone left at 0 hours is
-- recorded as on leave (status='leave') rather than silently unmarked.

ALTER TABLE employee_attendance ADD COLUMN IF NOT EXISTS hours_worked NUMERIC;

NOTIFY pgrst, 'reload schema';
