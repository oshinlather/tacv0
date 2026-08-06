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
const supabase = require('../supabase');
const { requireRole } = require('./authGuards');

const ATTENDANCE_STATUSES = ['present', 'absent', 'half_day', 'leave', 'holiday'];

const OWNER_LEVEL_ROLES = ['owner', 'avp', 'head_chef'];
const SCOPED_MANAGER_ROLES = ['outlet_mgr', 'store_mgr', 'bk_manager'];
const ALL_EMPLOYEE_ROLES = [...OWNER_LEVEL_ROLES, ...SCOPED_MANAGER_ROLES];
const ATTENDANCE_ROLES = [...OWNER_LEVEL_ROLES, 'store_mgr'];

const FULL_EDIT_FIELDS = [
  'name', 'designation', 'department', 'phone', 'joining_date', 'notes', 'app_user_id', 'active',
  'salary', 'salary_type', 'shift_start', 'shift_end', 'weekly_off',
  'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id',
];
// What a scoped manager (outlet_mgr/store_mgr/bk_manager) may create/edit — no
// salary, bank/UPI, app-login linking, or department reassignment.
const SCOPED_EDIT_FIELDS = ['name', 'designation', 'phone', 'joining_date', 'notes'];
// Fields stripped out of API responses for scoped managers — payroll/bank data
// isn't their business even read-only.
const SENSITIVE_FIELDS = ['salary', 'salary_type', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id'];

// null = unrestricted (owner/avp/head_chef). A string = the one department
// value (outlet id or 'bk') this user's employees are confined to.
function scopeForUser(user) {
  if (OWNER_LEVEL_ROLES.includes(user.role)) return null;
  if (user.role === 'outlet_mgr') return user.outlet_id;
  if (user.role === 'store_mgr' || user.role === 'bk_manager') return 'bk';
  return undefined;
}
function sanitize(emp, role) {
  if (OWNER_LEVEL_ROLES.includes(role)) return emp;
  const clean = { ...emp };
  SENSITIVE_FIELDS.forEach((f) => delete clean[f]);
  return clean;
}

// ── GET /api/employees — full directory (scoped managers only see their own
// department), each row annotated with its outstanding (unsettled) advance
// balance from Books Ledger
router.get('/', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);

    let query = supabase.from('employees').select('*').order('name');
    if (scope) query = query.eq('department', scope);
    const { data: employees, error } = await query;
    if (error) throw error;

    const { data: advances } = await supabase.from('books_ledger')
      .select('employee_id, amount, settled').eq('is_advance', true).not('employee_id', 'is', null);
    const balances = {};
    (advances || []).forEach((a) => {
      if (a.settled) return;
      balances[a.employee_id] = (balances[a.employee_id] || 0) + Number(a.amount || 0);
    });

    res.json((employees || []).map((e) => sanitize({ ...e, outstanding_advance: balances[e.id] || 0 }, user.role)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees — create; employee_code is auto-assigned (EMP0001, ...).
// Scoped managers can only onboard into their own department (forced server-side,
// regardless of what's in the request body) with a restricted field set.
router.post('/', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);
    const isScoped = scope !== null;

    const { name, designation, department } = req.body;
    const finalDepartment = scope || department;
    if (!name || !designation || !finalDepartment) return res.status(400).json({ error: "name, designation, and department are required" });

    const { data: last } = await supabase.from('employees').select('employee_code').order('id', { ascending: false }).limit(1).maybeSingle();
    const lastNum = last?.employee_code ? parseInt(String(last.employee_code).replace(/\D/g, ''), 10) || 0 : 0;
    const employee_code = `EMP${String(lastNum + 1).padStart(4, '0')}`;

    const insertRow = { name, designation, department: finalDepartment, employee_code };
    const editable = isScoped ? SCOPED_EDIT_FIELDS.filter((f) => f !== 'name' && f !== 'designation') : FULL_EDIT_FIELDS.filter((f) => f !== 'name' && f !== 'designation' && f !== 'department');
    editable.forEach((f) => { insertRow[f] = req.body[f] !== undefined && req.body[f] !== '' ? req.body[f] : null; });
    if (!isScoped) insertRow.salary_type = req.body.salary_type || 'monthly';

    const { data, error } = await supabase.from('employees').insert(insertRow).select('*').single();
    if (error) throw error;
    res.json(sanitize(data, user.role));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/employees/:id — scoped managers can only touch employees in
// their own department, and only the restricted field set.
router.patch('/:id', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);

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
    res.json(sanitize(data, user.role));
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

// ── GET /api/employees/:id/advances — one employee's advance history
router.get('/:id/advances', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
    if (!user) return;

    const { data: emp } = await supabase.from('employees').select('id, department').eq('id', req.params.id).single();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const scope = scopeForUser(user);
    if (scope && emp.department !== scope) return res.status(403).json({ error: "Not your employee" });

    const { data, error } = await supabase.from('books_ledger')
      .select('*').eq('employee_id', req.params.id).eq('is_advance', true).order('entry_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/attendance — filter by date, employee_id, and/or from/to range
router.get('/attendance', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);
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
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    const { employee_id, date, status, note } = req.body;
    if (!employee_id || !date || !status) return res.status(400).json({ error: 'employee_id, date, and status are required' });
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });

    const scope = scopeForUser(user);
    if (scope) {
      const { data: emp } = await supabase.from('employees').select('department').eq('id', employee_id).single();
      if (!emp || emp.department !== scope) return res.status(403).json({ error: 'Not your employee' });
    }

    const { data, error } = await supabase.from('employee_attendance')
      .upsert({ employee_id, date, status, note: note || null, marked_by: user.name, updated_at: new Date().toISOString() }, { onConflict: 'employee_id,date' })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/employees/attendance/:id — clear a wrongly-marked day
router.delete('/attendance/:id', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    const scope = scopeForUser(user);
    if (scope) {
      const { data: existing } = await supabase.from('employee_attendance').select('employee_id, employees!inner(department)').eq('id', req.params.id).single();
      if (!existing || existing.employees.department !== scope) return res.status(403).json({ error: 'Not your employee' });
    }
    const { error } = await supabase.from('employee_attendance').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
