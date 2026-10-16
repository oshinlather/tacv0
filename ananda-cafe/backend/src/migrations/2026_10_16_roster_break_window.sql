-- Break is a time WINDOW (e.g. '2pm-5pm'), not a number of hours — replace the numeric
-- break_hours column (added hours earlier in 2026_10_16_employee_roster.sql, still empty)
-- with a text break_window. Run after 2026_10_16_employee_roster.sql.
alter table employees drop column if exists break_hours;
alter table employees add column if not exists break_window text; -- e.g. '2pm-5pm'
