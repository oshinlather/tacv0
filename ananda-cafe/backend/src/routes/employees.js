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
const { requireRole } = require('./authGuards');

const upload = multer({ storage: multer.memoryStorage() });

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
// Read-only extension of ATTENDANCE_ROLES — outlet_mgr can now VIEW (not mark/edit)
// their own outlet's attendance, for the Performance Dashboard's Discipline score.
// Deliberately not added to ATTENDANCE_ROLES itself, which still gates marking/editing
// (POST/DELETE) — the original "no attendance" restriction for scoped managers stays,
// this only widens the GET.
const ATTENDANCE_READ_ROLES = [...ATTENDANCE_ROLES, 'outlet_mgr'];

const FULL_EDIT_FIELDS = [
  'name', 'designation', 'department', 'phone', 'joining_date', 'notes', 'app_user_id', 'active',
  'salary', 'salary_type', 'leave_allowed', 'shift_start', 'shift_end', 'weekly_off',
  'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id',
];
// What a scoped manager (outlet_mgr/store_mgr/bk_manager) may create/edit — no
// salary, bank/UPI, app-login linking, or department reassignment. 'active' is
// included so an outlet manager can mark a departed staff member inactive
// themselves — otherwise a former employee keeps accumulating 0%s in the
// Performance Dashboard's Discipline score (personRatio scores "not marked" as 0)
// until the owner happens to notice and deactivate them.
const SCOPED_EDIT_FIELDS = ['name', 'designation', 'phone', 'joining_date', 'notes', 'active'];
// Fields stripped out of API responses for scoped managers — payroll/bank data
// isn't their business even read-only.
const SENSITIVE_FIELDS = ['salary', 'salary_type', 'leave_allowed', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id'];

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
  if (user.role === 'outlet_mgr') return user.outlet_id || false;
  if (user.role === 'store_mgr' || user.role === 'bk_manager') return 'bk';
  return false;
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
    if (requireScope(scope, res)) return;

    let query = supabase.from('employees').select('*').order('name');
    if (scope) query = query.eq('department', scope);
    const { data: employees, error } = await query;
    if (error) throw error;

    // status='approved' excludes fines still awaiting owner approval (see
    // 2026_08_12_books_ledger_approval_status.sql) — a pending fine must not drag
    // down outstanding_advance (or payroll's deduction, see payroll.js) until approved.
    const { data: advances } = await supabase.from('books_ledger')
      .select('employee_id, amount, settled, status').eq('is_advance', true).not('employee_id', 'is', null);
    const balances = {};
    (advances || []).forEach((a) => {
      if (a.settled || a.status !== 'approved') return;
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
// and GET /:id handlers above and payroll.js) until an owner approves it via
// PATCH /fines/:id/approve below. Same scoped-manager gating as /advance.
router.post('/:id/fine', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...ALL_EMPLOYEE_ROLES);
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
    const user = await requireRole(req, res, ...ATTENDANCE_ROLES);
    if (!user) return;
    const { employee_id, date, status, note, hours_worked } = req.body;
    if (!employee_id || !date || !status) return res.status(400).json({ error: 'employee_id, date, and status are required' });
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });

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
    const user = await requireRole(req, res, ...OWNER_LEVEL_ROLES);
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

    const scope = scopeForUser(user);
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
    const scope = scopeForUser(user);
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
