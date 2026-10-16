-- Roster (DOD → Roster): per-employee shift, position bucket, and daily break hours.
-- No shift data existed before, so these all start null and are assigned from the Roster UI.
alter table employees add column if not exists shift text;          -- 'morning' | 'evening' | null
alter table employees add column if not exists break_hours numeric; -- daily break length in hours
alter table employees add column if not exists position text;       -- Manager/Chef/Helper/Bainmarry/House Keeping/Other
