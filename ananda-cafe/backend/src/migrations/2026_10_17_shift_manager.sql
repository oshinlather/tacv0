-- Shift manager flag: who runs a given outlet's shift. Combined with the employee's
-- department (outlet) and shift (morning/evening), a flagged employee is that outlet+shift's
-- in-charge. Assignable from DOD → Roster and the outlet-manager Team card.
alter table employees add column if not exists is_shift_manager boolean default false;
