-- September 2026 active-member salaries, from "employee data - Sheet1.csv".
-- Decisions (confirmed with owner):
--   • Sets salary AND active=true for each matched employee. Does NOT deactivate
--     anyone who isn't on the sheet.
--   • Outlet → department mapping: SEC23/31/56/14 → sec##, ELAN → elan, BK → bk,
--     Ghaziabad → gaursid, TAC → top_mgmt.
--   • Matched by normalized name (UPPER + collapsed whitespace) AND department, so the
--     two different "PANKAJ KUMAR" rows (sec31 vs bk) each update the right person.
--   • 3 multi-outlet rows are intentionally EXCLUDED (a payroll employee sits in one
--     department) — assign these by hand in Employee Master, then set their salary:
--       MOHAMMAD CHAND  — SEC14 & Sec-31 — 15000
--       RAHUL SHARMA    — SEC56 & SEC23 — 17000
--       RAJ KUMAR       — SEC14 & SEC23 — 17000
-- Run in the Supabase SQL editor. The final SELECT lists every sheet row that matched
-- NO employee (name/department mismatch) — resolve those by hand. Expect at least
-- "RAVEENDRA PURI / sec23 / 26000" here, whose app record is spelled "Ravinder Puri".

create temporary table sept_salaries (name text, department text, salary numeric);

insert into sept_salaries (name, department, salary) values
  ('ABHIMANYU', 'sec31', 15000),
  ('ABHINASH', 'sec31', 15000),
  ('ABHISHEK KUMAR', 'sec56', 15000),
  ('AJAY KUMAR', 'gaursid', 15000),
  ('AKASH', 'sec14', 15000),
  ('ALOK KUMAR', 'sec56', 14000),
  ('ALOK YADAV', 'sec14', 16000),
  ('AMBUJ', 'bk', 15000),
  ('ANIL KUMAR', 'sec14', 15000),
  ('ANMOL', 'bk', 18000),
  ('ARTI', 'bk', 16000),
  ('ASHISH KUMAR', 'sec56', 17000),
  ('BADAL SINGH', 'gaursid', 12000),
  ('BEETU KUSHWA', 'sec56', 16000),
  ('BHAGMAN BABU', 'sec23', 14000),
  ('BIKASH NUNIA', 'sec14', 16000),
  ('BIRENDER SINGH', 'sec14', 16000),
  ('BRIJESH KUMAR', 'gaursid', 12000),
  ('BUDHAN', 'sec31', 14000),
  ('CHEENU', 'bk', 17000),
  ('CHOTU NISHAD', 'gaursid', 20000),
  ('DEEPAK MISHRA', 'sec14', 24000),
  ('DEVENDRA', 'sec31', 8000),
  ('DHRUV NEGI', 'sec14', 24000),
  ('DINESH KUMAR', 'sec23', 15000),
  ('DIPAK KUMAR', 'bk', 15000),
  ('DIWAKAR', 'sec14', 32000),
  ('GANGA', 'sec23', 19000),
  ('GAURAV KUMAR', 'sec14', 16000),
  ('HEERALA', 'bk', 14000),
  ('HIMANSHU', 'sec56', 14000),
  ('JAGARU MACHHUAR', 'sec31', 15000),
  ('JAI PARKASH', 'gaursid', 14000),
  ('JYOTISH KUMAR', 'sec31', 15000),
  ('KAMALA', 'elan', 14000),
  ('KRISHNA', 'sec56', 20000),
  ('KUNAL', 'sec23', 24000),
  ('LAKSHMAN', 'sec31', 15000),
  ('LALMAN', 'bk', 16000),
  ('MAHESH', 'bk', 17000),
  ('MOHAMMAD AAHID', 'sec14', 15000),
  ('MOHAMMAD ALAM', 'sec31', 17000),
  ('MOHAMMAD GAZI', 'sec14', 15000),
  ('MOHAMMAD MUZAMIL', 'sec14', 15000),
  ('NARESH', 'sec31', 30000),
  ('NILKAMAL MAHTO', 'sec31', 14000),
  ('NISHANT', 'sec14', 20000),
  ('NUTAN KUMAR(KALU)', 'bk', 17000),
  ('PANKAJ KUMAR', 'sec31', 15000),
  ('PANKAJ KUMAR', 'bk', 15000),
  ('PAWAN', 'sec23', 19000),
  ('PRAKASH YADAV', 'gaursid', 17000),
  ('PRAMOD GAUTAM', 'elan', 24000),
  ('PRITI', 'bk', 16000),
  ('PRIYANSHU', 'sec23', 24000),
  ('PUSHPA DEVI', 'bk', 14000),
  ('PUSHPENDRA KUMAR', 'bk', 15000),
  ('RAHUL KUMAR', 'sec31', 15000),
  ('RAJENDRA', 'sec23', 14000),
  ('RAJESH', 'gaursid', 25000),
  ('RAJKUMAR', 'bk', 14000),
  ('RAJNESH KUMAR', 'bk', 15000),
  ('RAJU', 'sec31', 17000),
  ('RAKESH KUMAR MISHRA', 'gaursid', 22000),
  ('RAMA MANDAL', 'sec14', 15000),
  ('RANJEET KUMAR', 'gaursid', 17000),
  ('RANJIT', 'bk', 20000),
  ('RAVEENDRA PURI', 'sec23', 26000),
  ('RAVI KUMAR', 'gaursid', 14000),
  ('RITU KUMAR', 'bk', 15000),
  ('ROHIT BHEGAL', 'gaursid', 14000),
  ('ROHIT SINGH', 'sec31', 16000),
  ('ROSHAN KUMAR', 'sec14', 15000),
  ('ROSHAN MUKHIYA', 'sec23', 15000),
  ('SACHIN KUMAR', 'sec14', 15000),
  ('SAGAR NEPALI', 'sec56', 15000),
  ('SAHEB SINGH', 'bk', 35000),
  ('SAJAN SHARMA', 'sec31', 30000),
  ('SANDEEP', 'elan', 22000),
  ('SANDEEP KUMAR', 'sec31', 18000),
  ('SANTOSH', 'bk', 17000),
  ('SARAD KUMAR', 'bk', 15000),
  ('SARTHAK SHAKYA', 'sec56', 15000),
  ('SATYAM KUMAR', 'sec56', 20000),
  ('SHIVAM COUNTER', 'sec31', 17000),
  ('SHIVAM HK', 'sec31', 15000),
  ('SHYAM BABU', 'sec31', 15000),
  ('SONAM ANGEL', 'sec14', 16000),
  ('SONU', 'sec23', 15000),
  ('SONU VERMA', 'sec31', 15000),
  ('SUHAIL', 'sec23', 17000),
  ('SUMAN KUMAR', 'bk', 15000),
  ('SUNNY BANSAL', 'sec14', 15000),
  ('SURJIT CHAUDHARY', 'sec56', 24000),
  ('TEEJ RANA', 'sec56', 15000),
  ('TEKCHAND', 'top_mgmt', 30000),
  ('TINKU', 'bk', 17000),
  ('VIMAL', 'sec31', 18000),
  ('VISHAL YADAV', 'sec31', 22000);

-- Apply salary + activate, matched on normalized name + department.
update employees e
set salary = s.salary, active = true
from sept_salaries s
where regexp_replace(upper(trim(e.name)), '\s+', ' ', 'g') = s.name
  and e.department = s.department;

-- UNMATCHED sheet rows — no employee with that name+department. Resolve by hand.
select s.name, s.department, s.salary
from sept_salaries s
where not exists (
  select 1 from employees e
  where regexp_replace(upper(trim(e.name)), '\s+', ' ', 'g') = s.name
    and e.department = s.department
)
order by s.department, s.name;

drop table sept_salaries;
