# Build Prompt — Employee Self-Service Portal ("My HRMS")

> Paste this whole file to Claude Code (or your coding agent) working inside the
> `ananda-cafe` repo. It is written to match the existing conventions documented in
> `CLAUDE.md`. Read the referenced files before writing code.

---

## 1. Goal

We already have a full **owner/manager-facing HRMS** (Employee Master, Daily Attendance,
Monthly Payroll, Fines & Advances, KYC docs). Now I want to **open a read-only
self-service portal to every employee** — including the helpers, cooks, and cleaners who
have **no app login today** — so each person can see, for **their own record only**:

1. **Their daily attendance** — day-by-day, with hours worked and OT.
2. **Their salary history** — every month, with the **full calculation shown and
   explained in plain language**: base salary, leave allowed, leaves taken, leaves
   cash-in, OT hours → OT days, month days, working days, prorated salary, advances
   deducted, and net payable.
3. **Their fine history** — each fine's date, amount, and **reason**, plus advances taken
   and outstanding balance.
4. **Their responsibilities & KRA** — a text summary the owner maintains per employee.

The single most important rule: **an employee can only ever see their own data.** The
portal auth path must be completely separate from the existing owner/manager
(`x-user-id` / `app_users`) auth so a staff credential can never reach a management route.

---

## 2. What already exists — DO NOT rebuild these

Read these first; reuse them, don't duplicate them:

- **`backend/src/routes/payroll.js`** — the monthly payroll engine. It already computes,
  per employee per month:
  ```
  Leaves Cash-in  = Leave Allowed − Leaves Taken        (can go negative)
  OT Days         = OT Hours ÷ 10
  Working Days    = Month Days + Leaves Cash-in + OT Days
  Prorated Salary = (Working Days ÷ Month Days) × Base Salary
  Net Payable     = Prorated Salary − outstanding (approved) advances
  ```
  `Leaves Taken` and `OT Hours` are derived live from `employee_attendance` via
  `computeAttendanceTotals()`; `computeRow()` layers manual overrides on top. Finalized
  months are frozen snapshots in `employee_payroll_runs`; unfinalized months are computed
  live. **The portal must show numbers identical to what the owner sees** — so we will
  extract this logic into a shared module (see §5) rather than re-deriving it.
- **`backend/src/routes/employees.js`** — Employee Master, attendance marking, fines
  (`POST /:id/fine`, status `pending`→`approved`), advances, KYC docs. Note fines are
  `books_ledger` rows (`is_advance=true`, `category='staff_fine'`) and only count once
  `status='approved'`.
- **`backend/src/migrations/`** — the schema. Relevant tables: `employees`,
  `employee_attendance` (has `hours_worked`), `employee_monthly_ot`,
  `employee_payroll_runs`, `employee_payroll_overrides`, `employee_documents`, and
  `books_ledger` (advances + fines).
- **`backend/src/routes/authGuards.js`** — role-based guards for the *management* side.
- **`frontend/src/api.js`** — the API client (`authHeaders()`, `get/post/patch/del`).
- **`frontend/src/App.jsx`** — single-file React app; login stores `ananda_user` in
  `localStorage`; management screens are role-gated.

Existing management roles: `owner, store_mgr, outlet_mgr, chef, bainmarry, franchise,
avp, head_chef`. Do **not** add employees to any of these.

---

## 3. Access model (decided): owner-generated access code

Staff mostly don't have `app_users` logins and won't remember PINs, so:

- The **owner generates a unique access code per employee** from the Employee Master.
  The code is the employee's credential to the portal — no PIN, no phone OTP.
- Codes are **revocable** and **regenerable** (revoking invalidates the old code
  immediately).
- Because salary is sensitive, make the code **hard to guess**: a random
  URL-safe string of **at least 10 characters** (e.g. `crypto.randomBytes`), unique across
  all employees. Store it on the employee row. (Optional hardening, note it in a code
  comment but don't block on it: store a hash of the code instead of plaintext.)
- The portal is reached at a distinct entry point (e.g. `/portal` route or a "Staff
  Login" tab on the existing login screen) where the employee enters their code. On
  success the frontend stores the code in `localStorage` under a **new key** (e.g.
  `ananda_staff`) — **never** under `ananda_user` — and sends it as a **new header**
  `x-employee-code` on portal requests only.

⚠️ **Security note to surface to me in your summary:** a static access code is convenient
but weaker than PIN/OTP for payroll data. Implement basic protections: unique long codes,
server-side revocation, and **do not expose bank account / IFSC / UPI / KYC document
contents in the portal** (those stay owner-only). If easy, add simple rate-limiting on the
portal login endpoint.

---

## 4. Database migration

Create **one** new migration file following the existing naming convention
`backend/src/migrations/YYYY_MM_DD_staff_self_service_portal.sql` (use today's date). It
must be idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) and end with
`NOTIFY pgrst, 'reload schema';` like the others.

Add to `employees`:

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS responsibilities_kra TEXT;      -- owner-maintained free text
ALTER TABLE employees ADD COLUMN IF NOT EXISTS portal_access_code TEXT UNIQUE; -- NULL = portal disabled
ALTER TABLE employees ADD COLUMN IF NOT EXISTS portal_code_issued_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_employees_portal_code ON employees (portal_access_code);
```

No other schema changes are needed — attendance, payroll, fines, and advances all already
exist and are queried by `employee_id`.

---

## 5. Refactor: shared payroll computation (do this before the portal routes)

To guarantee the employee sees the **exact same numbers** as the owner's payroll sheet,
extract the pure functions out of `payroll.js` into a new
**`backend/src/payrollCompute.js`**:

- Move `monthRange`, `datesInRange`, `computeAttendanceTotals`, `computeRow`, and the
  constants `DAILY_STANDARD_HOURS`, `WEEKDAY_NAMES` into it and `module.exports` them.
- Update `payroll.js` to `require` them from the new module — **behaviour must not
  change**; the existing payroll endpoints and their output must stay byte-for-byte the
  same. Verify by diffing a `GET /api/payroll?month=...` response before and after.

The portal salary endpoint (§6) then imports the same functions, so a draft month shown to
staff matches the owner's draft exactly, and a finalized month reads from the same
`employee_payroll_runs` snapshot.

---

## 6. Backend: new portal route file

Create **`backend/src/routes/portal.js`**, mounted in `server.js` at `/api/portal`
(mirror the existing `app.use("/api/employees", employeesRouter)` lines).

**Portal auth helper** (put it in this file or extend `authGuards.js` — keep it separate
from `requireAuth`): read header `x-employee-code`, look up the single `employees` row
where `portal_access_code = code AND active = true`. If none, respond `401`. Return the
employee. Cache briefly if you like (mirror the 30s cache pattern in `authGuards.js`), but
**never** fall back to `x-user-id` here.

Endpoints (all resolve the employee **from the code only** — never accept an
`employee_id` from the client, so one employee can't request another's data):

1. **`POST /api/portal/login`** — body `{ code }`. Validates the code, returns a **minimal
   safe profile**: `{ id, name, employee_code, designation, department, joining_date,
   shift_start, shift_end, weekly_off, salary_type, responsibilities_kra }`. **Exclude**
   `salary` amount here, bank fields, UPI, and KYC. (Frontend stores the code, not the id,
   as the credential.)

2. **`GET /api/portal/me`** — same safe profile as above, for refetch.

3. **`GET /api/portal/attendance?month=YYYY-MM`** — the employee's rows from
   `employee_attendance` for that month: `date, status, hours_worked`, plus a computed
   `ot_hours = max(0, hours_worked − 11)` per present day, and a month summary
   `{ present, half_day, leave, absent, holiday, total_hours, total_ot_hours }`. Default to
   the current month if `month` is omitted. Cap at today (IST) — don't invent future days.

4. **`GET /api/portal/salary?month=YYYY-MM`** — the employee's **full payroll breakdown**
   for that month, computed via the shared module from §5 (finalized snapshot if it exists,
   else live draft). Return **every field** so the frontend can show the whole
   calculation: `base_salary, leave_allowed, leaves_taken, leaves_cashin, ot_hours,
   ot_days, month_days, working_days, prorated_salary, advances_deducted, net_payable,
   status` (`draft`/`finalized`), `finalized_at`. Also include a machine-readable
   `formula` block echoing each step with its inputs and result (see §8) so the UI can
   render the explanation without re-implementing the math.

5. **`GET /api/portal/salary-history`** — a compact list of the employee's **finalized**
   months from `employee_payroll_runs` (most recent first): `month, working_days,
   prorated_salary, advances_deducted, net_payable, finalized_at`. This powers the
   history list; tapping a month calls endpoint #4 for the full breakdown.

6. **`GET /api/portal/fines`** — the employee's fines and advances from `books_ledger`
   where `employee_id = me AND is_advance = true`, most recent first. For each:
   `entry_date, category` (`staff_fine` vs `staff_advance`), `amount, reason/note,
   status` (fines: `pending`/`approved`/`rejected`), `settled`. Compute
   `outstanding = sum(amount) where status='approved' AND settled=false`. **Only show
   fines that are `approved` or `rejected`** — do **not** surface a `pending` fine to the
   employee before the owner has approved it (matches how pending fines are hidden from
   `outstanding_advance` and payroll today).

**Do not** create any write endpoints in the portal. It is strictly read-only for staff.

---

## 7. Owner-side additions (management UI + endpoints)

In **`employees.js`** (owner/authorized roles only — reuse the existing role gating in
that file):

- **`POST /api/employees/:id/portal-code`** — generate (or regenerate) a unique
  `portal_access_code` for the employee, set `portal_code_issued_at = now()`, return the
  new code so the owner can copy/share it.
- **`DELETE /api/employees/:id/portal-code`** — revoke: set `portal_access_code = NULL`.
- Allow the existing employee-update path (`PATCH /api/employees/:id`) to set
  `responsibilities_kra` (add it to that route's editable-fields list). Keep bank/salary
  fields on their current access tier.

In **`App.jsx`** Employee Master (owner view), for each employee add:

- A **"Responsibilities & KRA"** multiline text field (saves via the employee PATCH).
- A **portal access control**: a button to **Generate access code** / show the current
  code with a copy button / **Revoke**. Make it obvious the code is what the employee uses
  to log in. Add matching `api.js` methods (`generatePortalCode`, `revokePortalCode`).

---

## 8. Salary transparency — the calculation must be *explained*, not just shown

This is the heart of the request. On the employee's **My Salary** screen, for the selected
month, render the numbers **and** a plain-language explanation of how each was derived.
Show it as a step-by-step breakdown, e.g.:

```
Base Salary (monthly)                                   ₹18,000
Days in this month                                           31
Leave Allowed                                                 2
Leaves Taken (from your attendance)                           3
  → Leave Cash-in = Allowed − Taken = 2 − 3 =               −1   (a day over your leaves)
Overtime Hours (beyond 11 hrs/day)                           20
  → OT Days = OT Hours ÷ 10 = 20 ÷ 10 =                       2
Working Days = Month Days + Leave Cash-in + OT Days
             = 31 + (−1) + 2 =                                32
Prorated Salary = (Working Days ÷ Month Days) × Base
                = (32 ÷ 31) × ₹18,000 =                 ₹18,580
Advances / approved fines deducted                      −₹2,000
─────────────────────────────────────────────────────────────
Net Payable                                             ₹16,580
Status: Finalized on 2 Aug 2026   (or: Draft — may change)
```

Requirements for this screen:

- Every line shows **the formula, the actual inputs, and the result** — no unexplained
  numbers. Use the `formula` block from endpoint #4 so the UI doesn't re-derive math.
- Explain in one short line, in simple language, what **Leave Cash-in** and **OT Days**
  mean (a negative cash-in reduces pay; OT converts to extra paid days at 10 hrs = 1 day).
- Clearly label **Draft vs Finalized**. For a draft month, add a note that it's live and
  may still change until the owner finalizes it.
- Show which fines/advances make up the "deducted" figure, linking to the Fines screen.
- Format currency as ₹ with Indian digit grouping; round money to whole rupees (match how
  payroll displays today).

---

## 9. Frontend: the employee portal

Add a **`StaffPortal`** component to `App.jsx` (keep the single-file convention). It
renders when a valid `ananda_staff` code is in `localStorage`, and is entirely separate
from the management app shell. Login flow: a "Staff Login" entry (tab on the login screen
or `/portal`) → enter access code → `POST /api/portal/login` → store code → show portal.

Portal tabs (mobile-first — most staff are on phones):

1. **My Profile** — name, employee code, designation, department/outlet, joining date,
   shift timing, weekly off. Below it, **Responsibilities & KRA** (the owner's text).
2. **My Attendance** — month picker; a day-by-day list/calendar showing status and hours,
   with the OT per day and the month summary (present / leaves / total hours / total OT).
3. **My Salary** — month picker + the salary-history list; selecting a month shows the
   full explained breakdown from §8. Default to the latest finalized month.
4. **My Fines & Advances** — list with date, amount, reason, and status; outstanding
   balance at top. (Hide pending fines.)

Add the portal calls to `api.js` under a clearly commented section, using a **separate
header helper** that sends `x-employee-code` (not `x-user-id`). A **Logout** button clears
`ananda_staff`.

Keep the visual language consistent with the existing app (same colors/logo), but the
portal should feel simple and read-only — no owner/manager controls anywhere in it.

---

## 10. Constraints & conventions

- Match existing code style: Express routers with the same error-handling shape
  (`try/catch` → `res.status(500).json({ error: e.message })`), Supabase query patterns,
  and `api.js` helper usage.
- Migration file naming, idempotency, and the trailing `NOTIFY pgrst` line must match the
  other files in `migrations/`.
- IST date handling: reuse `todayIST()` from `helpers.js` (already used in `payroll.js`)
  — don't introduce a new timezone path.
- Don't change any existing management behaviour. The `payroll.js` refactor (§5) must be
  output-preserving.
- Single-file frontend: extend `App.jsx`; don't split it into new files unless you also
  wire the build.

---

## 11. Acceptance checklist (verify before you call it done)

- [ ] Migration applies cleanly and is idempotent (safe to run twice).
- [ ] A generated access code logs a codeless staff member into the portal; a
      **revoked** code returns `401` immediately.
- [ ] Employee A **cannot** see Employee B's data by any request (no `employee_id`
      accepted from the client on portal routes; code resolves identity).
- [ ] Portal routes reject an `x-user-id` (management) header alone, and management routes
      reject an `x-employee-code` alone.
- [ ] Bank details, UPI, and KYC documents are **never** returned by any portal endpoint.
- [ ] A pending (unapproved) fine does **not** appear in the employee's fines list or
      salary deductions; it appears only after owner approval.
- [ ] For a given month, the employee's salary breakdown **matches the owner's payroll
      sheet exactly** (draft and finalized), because both use `payrollCompute.js`.
- [ ] The My Salary screen shows every number **with its formula and inputs**, labels
      Draft vs Finalized, and reads clearly on a phone.
- [ ] Attendance month summary math (present/leaves/hours/OT) matches the daily rows.

## 12. Deliver a short summary

When done, give me: the migration filename, the new/edited files, the new API endpoints,
how an employee logs in and where the owner generates the code, and the security note from
§3 (the access-code tradeoff) so I can decide if I want PIN/OTP hardening later.
