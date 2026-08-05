// employees.js — Employee Master: a mini HRMS covering the full staff directory
// (superset of app_users — includes staff who never log into the app), grouped by
// department (an outlet id, 'bk' for Base Kitchen, or 'top_mgmt' for Top
// Management). Covers employee code, salary, shift/roster timing, bank/UPI
// details, and daily attendance. Advances stay tracked in Books Ledger
// (books_ledger.employee_id) rather than a second ledger — this file only reads
// that table to compute each employee's outstanding balance.

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireAuth, requireOwner } = require('./authGuards');

const ATTENDANCE_STATUSES = ['present', 'absent', 'half_day', 'leave', 'holiday'];
const EMPLOYEE_EDITABLE_FIELDS = [
  'name', 'designation', 'department', 'phone', 'joining_date', 'notes', 'app_user_id', 'active',
  'salary', 'salary_type', 'shift_start', 'shift_end', 'weekly_off',
  'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id',
];

// ── GET /api/employees — full directory, each row annotated with its
// outstanding (unsettled) advance balance from Books Ledger
router.get('/', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { data: employees, error } = await supabase.from('employees').select('*').order('name');
    if (error) throw error;

    const { data: advances } = await supabase.from('books_ledger')
      .select('employee_id, amount, settled').eq('is_advance', true).not('employee_id', 'is', null);
    const balances = {};
    (advances || []).forEach((a) => {
      if (a.settled) return;
      balances[a.employee_id] = (balances[a.employee_id] || 0) + Number(a.amount || 0);
    });

    res.json((employees || []).map((e) => ({ ...e, outstanding_advance: balances[e.id] || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees — create; employee_code is auto-assigned (EMP0001, ...)
router.post('/', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const {
      name, designation, department, phone, joining_date, notes, app_user_id,
      salary, salary_type, shift_start, shift_end, weekly_off,
      bank_account_name, bank_account_number, bank_ifsc, upi_id,
    } = req.body;
    if (!name || !designation || !department) return res.status(400).json({ error: "name, designation, and department are required" });

    const { data: last } = await supabase.from('employees').select('employee_code').order('id', { ascending: false }).limit(1).maybeSingle();
    const lastNum = last?.employee_code ? parseInt(String(last.employee_code).replace(/\D/g, ''), 10) || 0 : 0;
    const employee_code = `EMP${String(lastNum + 1).padStart(4, '0')}`;

    const { data, error } = await supabase.from('employees').insert({
      name, designation, department, employee_code,
      phone: phone || null, joining_date: joining_date || null, notes: notes || null, app_user_id: app_user_id || null,
      salary: salary || null, salary_type: salary_type || 'monthly',
      shift_start: shift_start || null, shift_end: shift_end || null, weekly_off: weekly_off || null,
      bank_account_name: bank_account_name || null, bank_account_number: bank_account_number || null,
      bank_ifsc: bank_ifsc || null, upi_id: upi_id || null,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/employees/:id
router.patch('/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const updates = { updated_at: new Date().toISOString() };
    for (const f of EMPLOYEE_EDITABLE_FIELDS) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    const { data, error } = await supabase.from('employees').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/employees/attendance — filter by date, employee_id, and/or from/to range
router.get('/attendance', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { date, employee_id, from, to } = req.query;
    let query = supabase.from('employee_attendance').select('*');
    if (date) query = query.eq('date', date);
    if (employee_id) query = query.eq('employee_id', employee_id);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    const { data, error } = await query.order('date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/employees/attendance — mark/update one employee's status for one
// date (upsert on employee_id+date, so re-tapping a day just overwrites it)
router.post('/attendance', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!['owner', 'store_mgr'].includes(user.role)) return res.status(403).json({ error: 'Owners/Store managers only' });
    const { employee_id, date, status, note } = req.body;
    if (!employee_id || !date || !status) return res.status(400).json({ error: 'employee_id, date, and status are required' });
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });

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
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('employee_attendance').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
