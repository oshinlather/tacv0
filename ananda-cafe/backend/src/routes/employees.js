// employees.js — Employee Master: a mini HRMS covering the full staff directory
// (superset of app_users — includes staff who never log into the app), grouped by
// department (an outlet id, 'bk' for Base Kitchen, or 'top_mgmt' for Top
// Management). Covers employee code, salary, shift/roster timing, bank/UPI
// details, and daily attendance. Advances stay tracked in Books Ledger
// (books_ledger.employee_id) rather than a second ledger — this file only reads
// that table to compute each employee's outstanding balance, and writes a new
// advance row via POST /:id/advance.
//
// Two access tiers:
//  - OWNER_LEVEL_ROLES (owner, avp, head_chef): unrestricted — every department,
//    every field (salary, bank/UPI details), full attendance control. Same as
//    the existing owner-only behavior, just widened to avp/head_chef.
//  - SCOPED_MANAGER_ROLES (outlet_mgr, store_mgr, bk_manager): locked to their
//    own department (outlet_mgr → their outlet_id, store_mgr/bk_manager →
//    'bk'), and limited to onboarding + giving advances — no salary/bank data,
//    no attendance. This is what an outlet or BK manager's own dashboard uses.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const supabase = require('../supabase');
const { requireRole, requireRoleOrResp, hasResponsibility } = require('./authGuards');
const { todayIST } = require('../helpers');

const upload = multer({ storage: multer.memoryStorage() });

// Outlet managers may only mark/correct attendance for the last 3 days (today and the two
// prior) — older days are view-only for them in the app; this is the server-side backstop.
// Owner/AVP/Head Chef/Store Manager keep unrestricted control via the owner attendance screen.
const OUTLET_MGR_ATTENDANCE_EDIT_DAYS = 3;
function outletMgrAttendanceCutoff() {
  const d = new Date(todayIST() + 'T00:00:00');
  d.setDate(d.getDate() - (OUTLET_MGR_ATTENDANCE_EDIT_DAYS - 1));
  return d.toISOString().slice(0, 10);
}

const ATTENDANCE_STATUSES = ['present', 'absent', 'half_day', 'leave', 'holiday'];
const DOC_TYPES = ['aadhar', 'pan', 'police_verification', 'offer_letter', 'id_card'];
const DOC_BUCKET = 'employee-docs';
// A scoped manager may upload/view only these two — the ones they'd realistically
// be collecting from their own new hires in person. PAN/offer letter/ID card stay
// owner-only, same as salary/bank data.
const SCOPED_DOC_TYPES = ['aadhar', 'police_verification'];

const OWNER_LEVEL_ROLES = ['owner', 'avp', 'head_chef'];
const SCOPED_MANAGER_ROLES = ['outlet_mgr', 'store_mgr', 'bk_manager'];
const ALL_EMPLOYEE_ROLES = [...OWNER_LEVEL_ROLES, ...SCOPED_MANAGER_ROLES];
const ATTENDANCE_ROLES = [...OWNER_LEVEL_ROLES, 'store_mgr'];
// outlet_mgr can MARK their own outlet's daily attendance (Team → Attendance punch) — the
// scope check in POST /attendance already confines them to their own department, and this
// daily punch now feeds Punch Score / Missing Punches. Bulk CSV backfill and DELETE stay
// owner-tier (ATTENDANCE_ROLES) — a scoped manager marks today's punch, not rewrites history.
const ATTENDANCE_MARK_ROLES = [...ATTENDANCE_ROLES, 'outlet_mgr'];
// Read-only extension — outlet_mgr can also VIEW their own outlet's attendance (Performance
// Dashboard's Discipline score, and pre-filling today's punch screen).
const ATTENDANCE_READ_ROLES = [...ATTENDANCE_ROLES, 'outlet_mgr'];

const FULL_EDIT_FIELDS = [
  'name', 'designation', 'department', 'phone', 'joining_date', 'notes', 'app_user_id', 'active',
  'salary', 'salary_type', 'leave_allowed', 'shift_start', 'shift_end', 'weekly_off',
  'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id',
  // Roster (DOD → Roster): named shift (morning/evening), position bucket, break time window,
  // shift-manager flag (who runs this outlet+shift).
  'shift', 'position', 'break_window', 'is_shift_manager',
];
// What a scoped manager (outlet_mgr/store_mgr/bk_manager) may create/edit — no
// salary, bank/UPI, app-login linking, or department reassignment. 'active' is
// included so an outlet manager can mark a departed staff member inactive
// themselves — otherwise a former employee keeps accumulating 0%s in the
// Performance Dashboard's Discipline score (personRatio scores "not marked" as 0)
// until the owner happens to notice and deactivate them.
// Roster fields (shift/position/break_window) are included — an outlet/BK manager runs the
// shift on the ground, so they assign and change their own team's position, shift and break
// window (the PATCH route already confines a scoped manager to their own department).
const SCOPED_EDIT_FIELDS = ['name', 'designation', 'phone', 'joining_date', 'notes', 'active', 'bank_account_number', 'bank_ifsc', 'shift', 'position', 'break_window', 'is_shift_manager'];
// Fields stripped out of API responses for scoped managers — payroll/bank data
// isn't their business even read-only.
const SENSITIVE_FIELDS = ['salary', 'salary_type', 'leave_allowed', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id'];
// The two bank fields outlet/BK managers legitimately manage for their own team (salary/
// advance payout) — kept visible AND editable for scoped roles. Salary, account-holder name
// and UPI stay owner-only.
const SCOPED_VISIBLE_FIELDS = ['bank_account_number', 'bank_ifsc'];

// null = unrestricted (owner/avp/head_chef). A string = the one department
// value (outlet id or 'bk') this user's employees are confined to. false = this
// user's role IS scope-restricted but has no valid department to restrict to
// (e.g. an outlet_mgr whose app_users.outlet_id was never set) — callers MUST
// treat this as "deny", never fall through to "unrestricted". Previously this
// case returned the same falsy value as the unrestricted case (both were
// effectively null/undefined), so `if (scope)` silently skipped the department
// filter for a misconfigured outlet manager and handed them every outlet's
// employee list — including cross-outlet advance-giving. See requireScope().
function scopeForUser(user) {
  if (OWNER_LEVEL_ROLES.includes(user.role)) return null;
  if (user.role === 'outlet_mgr' || user.role === 'chef') return user.outlet_id || false;
  if (user.role === 'store_mgr' || user.role === 'bk_manager') return 'bk';
  return false;
}
// Scope for the employee DIRECTORY (list / profile / edit / documents). The 'onboarding'
// responsibility grants owner-tier, cross-outlet access there — a delegated hiring manager
// manages every outlet's staff (position/outlet/salary/joining + Aadhaar/police/offer-letter
// docs). Deliberately NOT used by advance / fine / attendance routes, so an onboarding manager
// still gives advances & marks attendance only for their own outlet, same as before.
function directoryScope(user) {
  if (hasResponsibility(user, 'onboarding')) return null;
  return scopeForUser(user);
}
// Call right after scopeForUser() in every scoped route. Returns true (and
// already responded 403) if this account is scope-restricted but misconfigured.
function requireScope(scope, res) {
  if (scope === false) {
    res.status(403).json({ error: 'Your account has no outlet assigned — ask the owner to fix this in Users' });
    return true;
  }
  return false;
}
function sanitize(emp, user) {
  // Owner tier OR an onboarding-responsibility manager sees everything (salary/bank) — the
  // latter needs it to do the hiring they're delegated, same widening as directoryScope above.
  if (OWNER_LEVEL_ROLES.includes(user.role) || hasResponsibility(user, 'onboarding')) return emp;
  const clean = { ...emp };
  SENSITIVE_FIELDS.filter((f) => !SCOPED_VISIBLE_FIELDS.includes(f)).forEach((f) => delete clean[f]);
  return clean;
}

// ── GET /api/employees — full directory (scoped managers only see their own
// department), each row annotated with its outstanding (unsettled) advance
// balance from Books Ledger. 'chef' added on this route only (not the shared
// ALL_EMPLOYEE_ROLES constant) — they need the roster to pick who to fine, but
// stay locked out of every write route below except POST /:id/fine.
router.get('/', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES, 'chef');
    if (!user) return;
    const scope = directoryScope(user);
    if (requireScope(scope, res)) return;

    let query = supabase.from('employees').select('*').order('name');
    if (scope) query = query.eq('department', scope);
    const { data: employees, error } = await query;
    if (error) throw error;

    // status='approved' excludes fines still awaiting owner approval (see
    // 2026_08_12_books_ledger_approval_status.sql) — a pending fine must not drag
    // down outstanding_advance (or payroll's deduction, see payroll.js) until approved.
    const { data: advances } = await supabase.from('books_ledger')
      .select('employee_id, amount, settled, status, entry_date').eq('is_advance', true).not('employee_id', 'is', null);

    // Shift-manager login credentials — so the card can keep showing the phone + PIN to
    // share for as long as the person is a shift manager (not just a one-time popup).
    const smUserIds = (employees || []).filter((e) => e.is_shift_manager && e.app_user_id).map((e) => e.app_user_id);
    const loginById = {};
    if (smUserIds.length) {
      const { data: logins } = await supabase.from('app_users').select('id, phone, pin, active').in('id', smUserIds);
      (logins || []).forEach((u) => { loginById[u.id] = { phone: u.phone, pin: u.pin, active: u.active }; });
    }
    // First day of the current IST month (UTC+5:30) — entry_date is a plain 'YYYY-MM-DD', so
    // a lexical >= compare against this string is the same as a date compare.
    const istNow = new Date(Date.now() + 330 * 60000);
    const monthStart = `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, '0')}-01`;
    // First day of the PREVIOUS IST month. The Team view's advance figure resets to this
    // month's on the 1st, so last month's total is kept available alongside it for reference
    // (a manager still wants to see what was given last month after the monthly reset).
    const lmDate = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth() - 1, 1));
    const lastMonthStart = `${lmDate.getUTCFullYear()}-${String(lmDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const balances = {};          // all-time outstanding (payroll deduction / Employee Master)
    const monthBalances = {};     // just this month's un-repaid advances (Team view)
    const lastMonthBalances = {}; // the previous calendar month's un-repaid advances (Team view)
    (advances || []).forEach((a) => {
      if (a.settled || a.status !== 'approved') return;
      const amt = Number(a.amount || 0);
      balances[a.employee_id] = (balances[a.employee_id] || 0) + amt;
      if (a.entry_date && a.entry_date >= monthStart) monthBalances[a.employee_id] = (monthBalances[a.employee_id] || 0) + amt;
      else if (a.entry_date && a.entry_date >= lastMonthStart) lastMonthBalances[a.employee_id] = (lastMonthBalances[a.employee_id] || 0) + amt;
    });

    res.json((employees || []).map((e) => sanitize({ ...e, outstanding_advance: balances[e.id] || 0, current_month_advance: monthBalances[e.id] || 0, last_month_advance: lastMonthBalances[e.id] || 0, shift_login: (e.is_shift_manager && e.app_user_id) ? (loginById[e.app_user_id] || null) : null }, user)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees — create; employee_code is auto-assigned (EMP0001, ...).
// Scoped managers can only onboard into their own department (forced server-side,
// regardless of what's in the request body) with a restricted field set.
router.post('/', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = directoryScope(user);
    if (requireScope(scope, res)) return;
    const isScoped = scope !== null;

    const { name, designation, department } = req.body;
    const finalDepartment = scope || department;
    if (!name || !designation || !finalDepartment) return res.status(400).json({ error: "name, designation, and department are required" });

    const { data: last } = await supabase.from('employees').select('employee_code').order('id', { ascending: false }).limit(1).maybeSingle();
    const lastNum = last?.employee_code ? parseInt(String(last.employee_code).replace(/\D/g, ''), 10) || 0 : 0;
    const employee_code = `EMP${String(lastNum + 1).padStart(4, '0')}`;

    const insertRow = { name, designation, department: finalDepartment, employee_code };
    // 'active' is deliberately excluded here (NOT NULL DEFAULT TRUE) — let the DB default
    // apply rather than risk inserting an explicit NULL if the caller omits it.
    const editable = isScoped
      ? SCOPED_EDIT_FIELDS.filter((f) => f !== 'name' && f !== 'designation')
      : FULL_EDIT_FIELDS.filter((f) => !['name', 'designation', 'department', 'active'].includes(f));
    // Skip (rather than force-null) anything the caller left out, so NOT NULL DEFAULT
    // columns like salary_type keep working without special-casing them here.
    editable.forEach((f) => { if (req.body[f] !== undefined && req.body[f] !== '') insertRow[f] = req.body[f]; });

    const { data, error } = await supabase.from('employees').insert(insertRow).select('*').single();
    if (error) throw error;
    res.json(sanitize(data, user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/employees/:id — scoped managers can only touch employees in
// their own department, and only the restricted field set.
router.patch('/:id', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = directoryScope(user);
    if (requireScope(scope, res)) return;

    if (scope) {
      const { data: existing } = await supabase.from('employees').select('department').eq('id', req.params.id).single();
      if (!existing || existing.department !== scope) return res.status(403).json({ error: "Cannot edit an employee outside your own outlet/department" });
    }

    const editable = scope ? SCOPED_EDIT_FIELDS : FULL_EDIT_FIELDS;
    const updates = { updated_at: new Date().toISOString() };
    for (const f of editable) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    const { data, error } = await supabase.from('employees').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(sanitize(data, user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/employees/:id — HARD delete, owner-tier only, and ONLY when the employee
// has no financial history: no books_ledger rows (advances/fines) and no payroll run at all
// (finalized/paid/reversed). Otherwise it's refused — a departed staff member with real money
// history must be marked Inactive (active=false) instead, which keeps the record and just
// hides them from the payroll matrix. When clean, cascades the no-money child rows first
// (attendance / OT / payroll overrides / KYC docs) so the employees-row delete isn't FK-blocked.
router.delete('/:id', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...OWNER_LEVEL_ROLES);
    if (!user) return;
    const id = req.params.id;
    const [{ count: ledgerCount }, { count: runCount }] = await Promise.all([
      supabase.from('books_ledger').select('id', { count: 'exact', head: true }).eq('employee_id', id),
      supabase.from('employee_payroll_runs').select('id', { count: 'exact', head: true }).eq('employee_id', id),
    ]);
    if ((ledgerCount || 0) > 0 || (runCount || 0) > 0) {
      return res.status(400).json({ error: 'This employee has advances or payroll history — mark them Inactive instead of deleting.' });
    }
    // No financial history: clear the remaining (money-free) child rows, then the employee.
    await supabase.from('employee_attendance').delete().eq('employee_id', id);
    await supabase.from('employee_monthly_ot').delete().eq('employee_id', id);
    await supabase.from('employee_payroll_overrides').delete().eq('employee_id', id);
    await supabase.from('employee_documents').delete().eq('employee_id', id);
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/shift-manager — toggle the shift-manager flag AND its app
// login in one action. Flipping ON auto-provisions a 'shift_manager' app_users login on the
// employee's own phone + a generated 4-digit PIN (returned so the manager can share it) —
// that restricted login lands on the shift-manager photo-capture screen (Opening / Clean
// Kitchen / Briefing / Closing, built separately). Flipping OFF deactivates that login.
// Reuses an already-linked login if there is one (keeps the same PIN) rather than spawning
// duplicates. Scoped managers can only do this for their own department's staff.
router.post('/:id/shift-manager', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = directoryScope(user);
    if (requireScope(scope, res)) return;
    const enabled = req.body.enabled === true || req.body.enabled === 'true';

    const { data: emp } = await supabase.from('employees').select('*').eq('id', req.params.id).single();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (scope && emp.department !== scope) return res.status(403).json({ error: 'Cannot edit an employee outside your own outlet/department' });

    if (!enabled) {
      await supabase.from('employees').update({ is_shift_manager: false, updated_at: new Date().toISOString() }).eq('id', emp.id);
      if (emp.app_user_id) await supabase.from('app_users').update({ active: false }).eq('id', emp.app_user_id);
      return res.json({ enabled: false });
    }

    // Enabling needs a phone — it IS the login id.
    const phone = (emp.phone || '').replace(/\D/g, '');
    if (phone.length < 10) return res.status(400).json({ error: 'Add a 10-digit phone number for this employee first — it is their login.' });

    // Reuse the employee's own linked login, else any existing login on that phone.
    let appUser = null;
    if (emp.app_user_id) {
      const { data } = await supabase.from('app_users').select('*').eq('id', emp.app_user_id).maybeSingle();
      appUser = data || null;
    }
    if (!appUser) {
      const { data } = await supabase.from('app_users').select('*').eq('phone', phone).maybeSingle();
      appUser = data || null;
    }
    // Don't hijack an existing login that belongs to a different role (e.g. the person is
    // already an outlet_mgr) — surface it instead of silently downgrading their access.
    if (appUser && appUser.role && appUser.role !== 'shift_manager') {
      return res.status(400).json({ error: `This phone already has a '${appUser.role}' login — resolve it in Users before making them a shift manager.` });
    }

    if (appUser) {
      const { data: upd } = await supabase.from('app_users')
        .update({ active: true, role: 'shift_manager', outlet_id: emp.department || null, name: emp.name })
        .eq('id', appUser.id).select('*').single();
      appUser = upd;
    } else {
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      const { data: ins, error: insErr } = await supabase.from('app_users')
        .insert({ name: emp.name, phone, pin, role: 'shift_manager', outlet_id: emp.department || null })
        .select('*').single();
      if (insErr) return res.status(500).json({ error: insErr.message });
      appUser = ins;
    }

    await supabase.from('employees').update({ is_shift_manager: true, app_user_id: appUser.id, updated_at: new Date().toISOString() }).eq('id', emp.id);
    res.json({ enabled: true, name: emp.name, phone: appUser.phone, pin: appUser.pin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/advance — record an advance for one employee,
// straight into Books Ledger (outstanding until owner settles it). Scoped
// managers can only do this for an employee in their own department.
router.post('/:id/advance', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const { amount, note, entry_date } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required' });

    const { data: emp, error: empErr } = await supabase.from('employees').select('id, name, department').eq('id', req.params.id).single();
    if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;
    if (scope && emp.department !== scope) return res.status(403).json({ error: "Cannot record an advance for an employee outside your own outlet/department" });

    const { data, error } = await supabase.from('books_ledger').insert({
      entry_date: entry_date || new Date().toISOString().slice(0, 10),
      submitted_by: user.name,
      description: note ? `Advance to ${emp.name} — ${note}` : `Advance to ${emp.name}`,
      category: 'staff_advance', amount: Number(amount), payment_mode: null, vendor_or_recipient: null,
      is_advance: true, advance_to: emp.name, employee_id: emp.id,
      outlet_id: null, source: 'manual', raw_message: null, created_by: user.id,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/:id/advances — one employee's advance history (includes
// fines, approved or still pending — both are is_advance=true rows, see POST
// /:id/fine below; status distinguishes them for display)
router.get('/:id/advances', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;

    const { data: emp } = await supabase.from('employees').select('id, department').eq('id', req.params.id).single();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;
    if (scope && emp.department !== scope) return res.status(403).json({ error: "Not your employee" });

    const { data, error } = await supabase.from('books_ledger')
      .select('*').eq('employee_id', req.params.id).eq('is_advance', true).order('entry_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/fine — impose a fine on an employee, with a
// mandatory reason. Unlike an advance, this does NOT take effect immediately:
// it's inserted as a books_ledger row (is_advance=true, category='staff_fine')
// with status='pending', so it's invisible to outstanding_advance and payroll's
// advance deduction (both now filter on status='approved' — see the GET /
// and GET /:id handlers above and payroll.js) until approved via PATCH
// /fines/:id/approve below — Head Chef included there via OWNER_LEVEL_ROLES, so
// a fine Chef imposes on their own team is Head Chef's to approve. Same
// scoped-manager gating as /advance; 'chef' added here only (see GET / above —
// this is their one and only write route in this file).
router.post('/:id/fine', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES, 'chef');
    if (!user) return;
    const { amount, reason, entry_date } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to impose a fine' });

    const { data: emp, error: empErr } = await supabase.from('employees').select('id, name, department').eq('id', req.params.id).single();
    if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;
    if (scope && emp.department !== scope) return res.status(403).json({ error: "Cannot impose a fine on an employee outside your own outlet/department" });

    const { data, error } = await supabase.from('books_ledger').insert({
      entry_date: entry_date || new Date().toISOString().slice(0, 10),
      submitted_by: user.name,
      description: `Fine for ${emp.name} — ${reason.trim()}`,
      category: 'staff_fine', amount: Number(amount), payment_mode: null, vendor_or_recipient: null,
      is_advance: true, advance_to: emp.name, employee_id: emp.id, status: 'pending',
      outlet_id: null, source: 'manual', raw_message: null, created_by: user.id,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/fines/pending — every fine awaiting owner approval,
// across every department, for the P&L "Fines" pill. Owner-level only.
router.get('/fines/pending', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...OWNER_LEVEL_ROLES);
    if (!user) return;
    const { data, error } = await supabase.from('books_ledger')
      .select('*, employees(name, department, designation)')
      .eq('category', 'staff_fine').eq('status', 'pending').order('entry_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/employees/fines/:id/approve — owner approves a pending fine; it
// immediately becomes a live outstanding advance (counted in outstanding_advance
// and swept into the employee's next payroll finalize, same as any other advance).
router.patch('/fines/:id/approve', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...OWNER_LEVEL_ROLES);
    if (!user) return;
    const { data: fine } = await supabase.from('books_ledger').select('id, category, status').eq('id', req.params.id).single();
    if (!fine || fine.category !== 'staff_fine') return res.status(404).json({ error: 'Fine not found' });
    if (fine.status !== 'pending') return res.status(400).json({ error: `This fine is already ${fine.status}` });

    const { data, error } = await supabase.from('books_ledger')
      .update({ status: 'approved', approved_by: user.name, approved_at: new Date().toISOString() })
      .eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/employees/fines/:id/reject — owner rejects a pending fine; it
// never becomes an advance and stays permanently excluded (status filter).
router.patch('/fines/:id/reject', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...OWNER_LEVEL_ROLES);
    if (!user) return;
    const { data: fine } = await supabase.from('books_ledger').select('id, category, status').eq('id', req.params.id).single();
    if (!fine || fine.category !== 'staff_fine') return res.status(404).json({ error: 'Fine not found' });
    if (fine.status !== 'pending') return res.status(400).json({ error: `This fine is already ${fine.status}` });

    const { data, error } = await supabase.from('books_ledger')
      .update({ status: 'rejected', approved_by: user.name, approved_at: new Date().toISOString(), rejection_note: req.body.note || null })
      .eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/attendance — filter by date, employee_id, and/or from/to range
router.get('/attendance', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_READ_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;
    const { date, employee_id, from, to } = req.query;

    if (scope && employee_id) {
      const { data: emp } = await supabase.from('employees').select('department').eq('id', employee_id).single();
      if (!emp || emp.department !== scope) return res.status(403).json({ error: 'Not your employee' });
    }

    let query = scope
      ? supabase.from('employee_attendance').select('*, employees!inner(department)').eq('employees.department', scope)
      : supabase.from('employee_attendance').select('*');
    if (date) query = query.eq('date', date);
    if (employee_id) query = query.eq('employee_id', employee_id);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    const { data, error } = await query.order('date', { ascending: false });
    if (error) throw error;
    res.json((data || []).map((r) => { const { employees, ...rest } = r; return rest; }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/attendance — mark/update one employee's status for one
// date (upsert on employee_id+date, so re-tapping a day just overwrites it)
router.post('/attendance', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_MARK_ROLES);
    if (!user) return;
    const { employee_id, date, status, note, hours_worked } = req.body;
    if (!employee_id || !date || !status) return res.status(400).json({ error: 'employee_id, date, and status are required' });
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });

    // Outlet managers: last-3-days edit window (see OUTLET_MGR_ATTENDANCE_EDIT_DAYS).
    if (user.role === 'outlet_mgr' && date < outletMgrAttendanceCutoff()) {
      return res.status(403).json({ error: `Attendance older than ${OUTLET_MGR_ATTENDANCE_EDIT_DAYS} days can't be edited` });
    }

    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;
    if (scope) {
      const { data: emp } = await supabase.from('employees').select('department').eq('id', employee_id).single();
      if (!emp || emp.department !== scope) return res.status(403).json({ error: 'Not your employee' });
    }

    const { data, error } = await supabase.from('employee_attendance')
      .upsert({ employee_id, date, status, note: note || null, hours_worked: hours_worked !== undefined ? Number(hours_worked) : null, marked_by: user.name, updated_at: new Date().toISOString() }, { onConflict: 'employee_id,date' })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/attendance/bulk — backfill one missed day for many
// employees at once from a CSV (columns: employee_code and/or name, hours_worked,
// optional status/note). Same upsert-on-employee_id+date semantics as the
// single-row POST above, so re-uploading the same date just overwrites those
// rows rather than duplicating them. Rows that don't match a known employee
// (in scope) are skipped and reported back, not silently dropped.
router.post('/attendance/bulk', upload.single('file'), async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required' });
    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;

    let empQuery = supabase.from('employees').select('id, employee_code, name').eq('active', true);
    if (scope) empQuery = empQuery.eq('department', scope);
    const { data: employees } = await empQuery;
    const byCode = {}, byName = {};
    (employees || []).forEach((e) => {
      if (e.employee_code) byCode[e.employee_code.trim().toLowerCase()] = e;
      byName[e.name.trim().toLowerCase()] = e;
    });

    const rows = [];
    const skipped = [];
    const stream = Readable.from(req.file.buffer.toString());
    await new Promise((resolve, reject) => {
      stream.pipe(csv())
        .on('data', (row) => {
          const codeKey = (row.employee_code || '').trim().toLowerCase();
          const nameKey = (row.name || row.employee_name || '').trim().toLowerCase();
          const emp = (codeKey && byCode[codeKey]) || (nameKey && byName[nameKey]);
          if (!emp) { skipped.push(row.employee_code || row.name || row.employee_name || '(blank row)'); return; }
          const hours = row.hours_worked !== undefined && row.hours_worked !== '' ? Number(row.hours_worked) : 0;
          let status = (row.status || '').trim().toLowerCase();
          if (!ATTENDANCE_STATUSES.includes(status)) status = hours > 0 ? 'present' : 'leave';
          rows.push({
            employee_id: emp.id, date, status, note: row.note || null,
            hours_worked: hours, marked_by: `${user.name} (CSV upload)`, updated_at: new Date().toISOString(),
          });
        })
        .on('end', resolve).on('error', reject);
    });

    if (rows.length === 0) return res.status(400).json({ error: 'No matching employees found in the file', skipped });

    const { error } = await supabase.from('employee_attendance').upsert(rows, { onConflict: 'employee_id,date' });
    if (error) throw error;
    res.json({ success: true, date, rows_saved: rows.length, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A real attendance register exported to CSV is unlikely to already be in strict
// YYYY-MM-DD — Excel/Sheets tends to emit DD/MM/YYYY (this business's own locale) or
// "17-Aug-2026" once a date-formatted column is exported. Extracts year/month/day
// directly via regex for every format handled — deliberately NOT `new Date(s)` +
// `.toISOString()`: that round-trip parses a non-ISO string as LOCAL midnight but
// formats back out as UTC, silently shifting the date by a day whenever the server's
// timezone isn't UTC (caught by testing this exact case before shipping it — "17-Aug-2026"
// came back "2026-08-16"). Returns null (never a guessed date) if nothing matches, so an
// unrecognized value is reported as a skip, not silently misdated.
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseFlexibleDate(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    // DD/MM/YYYY (or DD-MM-YYYY) — this business's locale, not US MM/DD/YYYY.
    const day = Number(dmy[1]), mon = Number(dmy[2]);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return `${dmy[3]}-${pad(mon)}-${pad(day)}`;
    return null;
  }
  const dMonY = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{4})$/); // "17-Aug-2026" / "17 August 2026"
  if (dMonY) {
    const day = Number(dMonY[1]);
    const monIdx = MONTH_NAMES.indexOf(dMonY[2].slice(0, 3).toLowerCase());
    if (monIdx >= 0 && day >= 1 && day <= 31) return `${dMonY[3]}-${pad(monIdx + 1)}-${pad(day)}`;
    return null;
  }
  return null;
}

// Case-insensitive column lookup with aliases — a real biometric-machine export (the
// actual file this was built against) uses "Employee Name"/"Date"/"Total Working
// Hours"/"Status" with capitals and spaces, not the plain employee_code/date/
// hours_worked/status the simpler hand-made CSV format uses; this accepts either
// without the uploader needing to rename columns first.
function getField(lowerRow, aliases) {
  for (const a of aliases) { if (lowerRow[a] !== undefined && lowerRow[a] !== '') return lowerRow[a]; }
  return undefined;
}
// "11h 17m" / "13h" / "45m" / "-" (no punch) -> decimal hours. Falls back to treating
// the value as a plain number for the simple hand-made format (hours_worked=8).
function parseDurationHours(raw) {
  const s = (raw || '').trim();
  if (!s || s === '-') return 0;
  const h = s.match(/(\d+)\s*h/i), m = s.match(/(\d+)\s*m/i);
  if (h || m) return Math.round(((h ? Number(h[1]) : 0) + (m ? Number(m[1]) : 0) / 60) * 100) / 100;
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}
// Biometric export's own status codes (FD/HD full/half day, Absent) alongside this
// app's own employee_attendance.status values — never guessed when unrecognized, falls
// back to the same hours>0 heuristic the simple format already used.
const STATUS_ALIASES = { fd: 'present', 'full day': 'present', hd: 'half_day', 'half day': 'half_day' };
function normalizeStatus(raw, hours) {
  const key = (raw || '').trim().toLowerCase();
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  if (ATTENDANCE_STATUSES.includes(key)) return key;
  return hours > 0 ? 'present' : 'leave';
}

// ── POST /api/employees/attendance/bulk-month — same idea as /attendance/bulk
// above, but for a WHOLE month in one file instead of re-uploading day by day.
// Accepts either the simple hand-made CSV shape (employee_code/name, date,
// hours_worked, status, note) or a real biometric-machine export (Employee Name,
// Date, Total Working Hours as "11h 17m", Status as FD/HD/Absent — Employee ID is
// deliberately NOT used for matching, since a machine's own internal id has nothing to
// do with this app's employee_code and matching on it would risk a wrong-employee
// match; name is the reliable common field, checked case-insensitively) — one row per
// employee per day (a flat register, not one row per employee with 31 date columns).
// `month` is required and used only to catch a wrong-file upload early — any row dated
// outside it is skipped and reported, not silently saved against the wrong month. Same
// upsert-on-employee_id+date semantics, so re-uploading (a corrected file, or just the
// current month again) overwrites rather than duplicates.
router.post('/attendance/bulk-month', upload.single('file'), async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month (YYYY-MM) is required' });
    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;

    let empQuery = supabase.from('employees').select('id, employee_code, name').eq('active', true);
    if (scope) empQuery = empQuery.eq('department', scope);
    const { data: employees } = await empQuery;
    const byCode = {}, byName = {};
    (employees || []).forEach((e) => {
      if (e.employee_code) byCode[e.employee_code.trim().toLowerCase()] = e;
      byName[e.name.trim().toLowerCase()] = e;
    });

    const rows = [];
    const skipped = [];
    const stream = Readable.from(req.file.buffer.toString());
    await new Promise((resolve, reject) => {
      stream.pipe(csv())
        .on('data', (row) => {
          const lowerRow = {};
          Object.keys(row).forEach((k) => { lowerRow[k.trim().toLowerCase()] = row[k]; });
          const codeKey = (getField(lowerRow, ['employee_code', 'emp code', 'emp id']) || '').trim().toLowerCase();
          const nameVal = getField(lowerRow, ['name', 'employee_name', 'employee name']) || '';
          const nameKey = nameVal.trim().toLowerCase();
          const emp = (codeKey && byCode[codeKey]) || (nameKey && byName[nameKey]);
          const who = nameVal || getField(lowerRow, ['employee_code', 'employee id']) || '(blank row)';
          if (!emp) { skipped.push(`${who}: unknown employee`); return; }
          const dateRaw = getField(lowerRow, ['date']);
          const date = parseFlexibleDate(dateRaw);
          if (!date) { skipped.push(`${who} "${dateRaw || ''}": unrecognized date`); return; }
          if (!date.startsWith(month)) { skipped.push(`${who} ${date}: not in ${month}`); return; }
          const hours = parseDurationHours(getField(lowerRow, ['hours_worked', 'total working hours', 'working hours']));
          const status = normalizeStatus(getField(lowerRow, ['status']), hours);
          const note = getField(lowerRow, ['note', 'remarks']) || null;
          rows.push({
            employee_id: emp.id, date, status, note,
            hours_worked: hours, marked_by: `${user.name} (monthly CSV upload)`, updated_at: new Date().toISOString(),
          });
        })
        .on('end', resolve).on('error', reject);
    });

    if (rows.length === 0) return res.status(400).json({ error: 'No matching rows found for ' + month, skipped });

    // Batched — a full month × full roster can be a few hundred rows, comfortably one
    // upsert call, but chunked defensively in case a very large roster pushes past a
    // single request's practical row limit.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('employee_attendance').upsert(rows.slice(i, i + CHUNK), { onConflict: 'employee_id,date' });
      if (error) throw error;
    }
    res.json({ success: true, month, rows_saved: rows.length, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/employees/attendance/:id — clear a wrongly-marked day
router.delete('/attendance/:id', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);
    if (requireScope(scope, res)) return;
    if (scope) {
      const { data: existing } = await supabase.from('employee_attendance').select('employee_id, employees!inner(department)').eq('id', req.params.id).single();
      if (!existing || existing.employees.department !== scope) return res.status(403).json({ error: 'Not your employee' });
    }
    const { error } = await supabase.from('employee_attendance').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/:id — single employee for the profile page: full
// particulars, KYC documents (with signed URLs), and advance history.
// Owner-level only — bank/salary details plus ID-proof scans are the most
// sensitive data in this app, more than the directory list justifies for a
// scoped manager.
router.get('/:id', async (req, res) => {
  try {
    // Owner tier OR an onboarding-responsibility manager (full cross-outlet profile incl. all
    // KYC docs — Aadhaar/police/offer letter — which they need to onboard a hire).
    const user = await requireRoleOrResp(req, res, 'onboarding', ...OWNER_LEVEL_ROLES);
    if (!user) return;

    const { data: emp, error } = await supabase.from('employees').select('*').eq('id', req.params.id).single();
    if (error || !emp) return res.status(404).json({ error: 'Employee not found' });

    const [{ data: docs }, { data: advances }] = await Promise.all([
      supabase.from('employee_documents').select('*').eq('employee_id', req.params.id),
      supabase.from('books_ledger').select('*').eq('employee_id', req.params.id).eq('is_advance', true).order('entry_date', { ascending: false }).limit(20),
    ]);

    const documents = await Promise.all((docs || []).map(async (d) => {
      const { data: signed } = await supabase.storage.from(DOC_BUCKET).createSignedUrl(d.storage_path, 86400);
      return { ...d, url: signed?.signedUrl || null };
    }));

    const outstanding_advance = (advances || []).filter((a) => !a.settled && a.status === 'approved').reduce((s, a) => s + Number(a.amount || 0), 0);
    res.json({ ...emp, documents, advances: advances || [], outstanding_advance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/:id/documents — upload or replace one KYC document
// (aadhar, pan, police_verification, offer_letter, id_card). Stored in the
// private 'employee-docs' bucket — signed URLs only, never a public link,
// since these are ID-proof scans. Re-uploading the same doc_type overwrites
// the record (unique on employee_id+doc_type) and best-effort deletes the
// previous file from storage. Scoped managers can upload for their own
// department's employees, but only aadhar/police_verification (SCOPED_DOC_TYPES) —
// everything else (PAN, offer letter, ID card) stays owner-only.
router.post('/:id/documents', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const { doc_type, base64, file_name } = req.body;
    if (!doc_type || !DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: `doc_type must be one of: ${DOC_TYPES.join(', ')}` });
    if (!base64) return res.status(400).json({ error: 'base64 file data is required' });

    const scope = directoryScope(user); // onboarding resp → null → all DOC_TYPES, every outlet
    if (requireScope(scope, res)) return;
    if (scope && !SCOPED_DOC_TYPES.includes(doc_type)) return res.status(403).json({ error: `You can only upload: ${SCOPED_DOC_TYPES.join(', ')}` });

    const { data: emp } = await supabase.from('employees').select('id, department').eq('id', req.params.id).single();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (scope && emp.department !== scope) return res.status(403).json({ error: "Cannot upload a document for an employee outside your own outlet/department" });

    const match = /^data:(.+);base64,(.+)$/.exec(base64);
    const contentType = match ? match[1] : 'application/octet-stream';
    const buffer = Buffer.from(match ? match[2] : base64, 'base64');
    const ext = contentType.includes('pdf') ? 'pdf' : (contentType.split('/')[1] || 'jpg');
    const storagePath = `${req.params.id}/${doc_type}_${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage.from(DOC_BUCKET).upload(storagePath, buffer, { contentType, upsert: true });
    if (upErr) throw upErr;

    const { data: existing } = await supabase.from('employee_documents').select('storage_path')
      .eq('employee_id', req.params.id).eq('doc_type', doc_type).maybeSingle();
    if (existing && existing.storage_path !== storagePath) {
      supabase.storage.from(DOC_BUCKET).remove([existing.storage_path]).catch(() => {});
    }

    const { data, error } = await supabase.from('employee_documents')
      .upsert({ employee_id: req.params.id, doc_type, storage_path: storagePath, file_name: file_name || null, uploaded_by: user.name, created_at: new Date().toISOString() }, { onConflict: 'employee_id,doc_type' })
      .select('*').single();
    if (error) throw error;

    const { data: signed } = await supabase.storage.from(DOC_BUCKET).createSignedUrl(storagePath, 86400);
    res.json({ ...data, url: signed?.signedUrl || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/:id/documents — lightweight doc list (with signed URLs)
// for the scoped Team edit form, so it can show "already uploaded" state without
// pulling the owner-only GET /:id (which also returns salary/bank data). A
// scoped manager only ever sees the doc types they're allowed to manage.
router.get('/:id/documents', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = directoryScope(user);
    if (requireScope(scope, res)) return;

    const { data: emp } = await supabase.from('employees').select('id, department').eq('id', req.params.id).single();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (scope && emp.department !== scope) return res.status(403).json({ error: "Not your employee" });

    let query = supabase.from('employee_documents').select('*').eq('employee_id', req.params.id);
    if (scope) query = query.in('doc_type', SCOPED_DOC_TYPES);
    const { data: docs, error } = await query;
    if (error) throw error;

    const documents = await Promise.all((docs || []).map(async (d) => {
      const { data: signed } = await supabase.storage.from(DOC_BUCKET).createSignedUrl(d.storage_path, 86400);
      return { ...d, url: signed?.signedUrl || null };
    }));
    res.json(documents);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
