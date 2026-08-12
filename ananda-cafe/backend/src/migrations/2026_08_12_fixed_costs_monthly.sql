-- Fixed Costs become month-specific instead of one evergreen value per (outlet, cost_head)
-- forever. Water/Electricity/Wastage genuinely differ month to month, so a single current
-- value silently misrepresented every PAST month's P&L (Finance module, Daily P&L) as if
-- that same figure applied then too. Each entry now belongs to a specific month; the
-- application falls back to the most recent PRIOR month's value when the exact month has
-- no entry yet (not handled here — see resolveFixedCostsForMonth in salesRoutes.js), so
-- Rent/Salary (which rarely change) don't need re-entry every month, while Water/
-- Electricity/Wastage can be updated whenever a fresh bill comes in.

alter table fixed_costs add column if not exists month text;

-- Backfill existing rows: tag each with the month it was last actually set (from
-- updated_at) — the most honest available signal for when that figure was really entered,
-- not a guessed business value.
update fixed_costs set month = to_char(updated_at, 'YYYY-MM') where month is null;

alter table fixed_costs alter column month set not null;

-- Old unique constraint was (outlet_id, cost_head) — one row per head, forever. Find it
-- dynamically (rather than hardcoding its auto-generated name, which may not match) and
-- drop it, then key on (outlet_id, cost_head, month) instead, so the same head can have a
-- different amount in different months without deleting/overwriting history.
do $$
declare
  con_name text;
begin
  select tc.constraint_name into con_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_name = kcu.table_name
  where tc.table_name = 'fixed_costs' and tc.constraint_type = 'UNIQUE'
  group by tc.constraint_name
  having array_agg(kcu.column_name::text order by kcu.column_name::text) = array['cost_head', 'outlet_id']::text[]
  limit 1;
  if con_name is not null then
    execute format('alter table fixed_costs drop constraint %I', con_name);
  end if;
end $$;

alter table fixed_costs add constraint fixed_costs_outlet_head_month_key unique (outlet_id, cost_head, month);
