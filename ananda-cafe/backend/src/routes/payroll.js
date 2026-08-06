// payroll.js — Monthly Payroll. Replicates the owner's existing salary-sheet
// formulas (see 2026_08_06_employee_payroll.sql for the full derivation):
//
//   Leaves Cash-in  = Leave Allowed − Leaves Taken        (can go negative)
//   OT Days         = OT Hours ÷ 10
//   Working Days    = Month Days + Leaves Cash-in + OT Days
//   Prorated Salary = (Working Days ÷ Month Days) × Base Salary
//   Net Payable     = Prorated Salary − outstanding advances
//
// "Leaves Taken" is computed live from employee_attendance: absent/leave = 1
// day, half_day = 0.5, present/holiday = 0. OT hours are a manual monthly
// entry per employee for now (see employee_monthly_ot) — PetPooja isn't
// connected yet, this is a placeholder for an eventual auto-fill.
//
// A month is "draft" (computed live from current attendance/OT/advances) until
// finalized. Finalizing snapshots the numbers into employee_payroll_runs (so a
// later attendance edit doesn't silently change what was already paid) and
// settles whatever advances were outstanding for that employee at that moment.
//
// Salary is sensitive payroll data — same access tier as the full Employee
// Master panel (owner/avp/head_chef only, no scoped-manager access here).

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireRole } = require('./authGuards');

const PAYROLL_ROLES = ['owner', 'avp', 'head_chef'];

// Every column in the payroll sheet except OT Hours (which already has its own
// override path via employee_monthly_ot / POST /ot) can be manually corrected
// per employee per month — see employee_payroll_overrides.
const OVERRIDE_FIELDS = ['base_salary', 'leave_allowed', 'leaves_taken', 'leaves_cashin', 'ot_days', 'working_days', 'prorated_salary', 'advances_deducted', 'net_payable'];

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const monthDays = new Date(y, m, 0).getDate();
  return { monthDays, from: `${month}-01`, to: `${month}-${String(monthDays).padStart(2, '0')}` };
}

function leavesFromAttendance(rows) {
  const byEmp = {};
  (rows || []).forEach((r) => {
    const inc = r.status === 'half_day' ? 0.5 : (r.status === 'absent' || r.status === 'leave') ? 1 : 0;
    if (inc) byEmp[r.employee_id] = (byEmp[r.employee_id] || 0) + inc;
  });
  return byEmp;
}

// `overrides` (a row from employee_payroll_overrides, or {}) layers manual
// corrections on top of the formula: each field falls back to its computed
// value when the override column is null, and a downstream field (e.g.
// working_days) still recomputes off an upstream override (e.g. leave_allowed)
// unless that downstream field ALSO has its own explicit override, which wins.
function computeRow(emp, { leavesTaken, otHours, advancesDeducted, monthDays, overrides = {} }) {
  const ov = (field, fallback) => (overrides[field] != null ? Number(overrides[field]) : fallback);
  const baseSalary = ov('base_salary', Number(emp.salary || 0));
  const leaveAllowed = ov('leave_allowed', Number(emp.leave_allowed || 0));
  const leavesTakenFinal = ov('leaves_taken', leavesTaken);
  const leavesCashin = ov('leaves_cashin', leaveAllowed - leavesTakenFinal);
  const otDays = ov('ot_days', otHours / 10);
  const workingDays = ov('working_days', monthDays + leavesCashin + otDays);
  const proratedSalary = ov('prorated_salary', monthDays > 0 ? (workingDays / monthDays) * baseSalary : 0);
  const advancesDeductedFinal = ov('advances_deducted', advancesDeducted);
  const netPayable = ov('net_payable', proratedSalary - advancesDeductedFinal);
  return {
    base_salary: baseSalary, leave_allowed: leaveAllowed, leaves_taken: leavesTakenFinal, ot_hours: otHours,
    month_days: monthDays, leaves_cashin: leavesCashin, ot_days: otDays, working_days: workingDays,
    prorated_salary: proratedSalary, advances_deducted: advancesDeductedFinal, net_payable: netPayable,
  };
}

// ── GET /api/payroll?month=YYYY-MM — every active employee's payroll for that
// month. Finalized employees return their frozen snapshot; everyone else is
// computed live.
router.get('/', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...PAYROLL_ROLES);
    if (!user) return;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const { monthDays, from, to } = monthRange(month);

    const { data: employees, error: empErr } = await supabase.from('employees').select('*').eq('active', true).order('name');
    if (empErr) throw empErr;
    if (!employees || employees.length === 0) return res.json({ month, rows: [] });
    const empIds = employees.map((e) => e.id);

    const [{ data: attendance }, { data: otRows }, { data: advances }, { data: runs }, { data: overrideRows }] = await Promise.all([
      supabase.from('employee_attendance').select('employee_id, status').in('employee_id', empIds).gte('date', from).lte('date', to),
      supabase.from('employee_monthly_ot').select('*').in('employee_id', empIds).eq('month', month),
      supabase.from('books_ledger').select('employee_id, amount, settled').eq('is_advance', true).not('employee_id', 'is', null).in('employee_id', empIds),
      supabase.from('employee_payroll_runs').select('*').in('employee_id', empIds).eq('month', month),
      supabase.from('employee_payroll_overrides').select('*').in('employee_id', empIds).eq('month', month),
    ]);

    const leavesByEmp = leavesFromAttendance(attendance);
    const otByEmp = {};
    (otRows || []).forEach((r) => { otByEmp[r.employee_id] = Number(r.ot_hours || 0); });
    const advByEmp = {};
    (advances || []).forEach((a) => { if (!a.settled) advByEmp[a.employee_id] = (advByEmp[a.employee_id] || 0) + Number(a.amount || 0); });
    const runByEmp = {};
    (runs || []).forEach((r) => { runByEmp[r.employee_id] = r; });
    const overridesByEmp = {};
    (overrideRows || []).forEach((r) => { overridesByEmp[r.employee_id] = r; });

    const rows = employees.map((e) => {
      const base = { employee_id: e.id, name: e.name, employee_code: e.employee_code, designation: e.designation, department: e.department };
      const finalized = runByEmp[e.id];
      if (finalized) {
        return {
          ...base,
          base_salary: finalized.base_salary, leave_allowed: finalized.leave_allowed, leaves_taken: finalized.leaves_taken,
          ot_hours: finalized.ot_hours, month_days: finalized.month_days, leaves_cashin: finalized.leaves_cashin,
          ot_days: finalized.ot_days, working_days: finalized.working_days, prorated_salary: finalized.prorated_salary,
          advances_deducted: finalized.advances_deducted, net_payable: finalized.net_payable,
          status: 'finalized', finalized_at: finalized.finalized_at, finalized_by: finalized.finalized_by,
        };
      }
      const computed = computeRow(e, {
        leavesTaken: leavesByEmp[e.id] || 0, otHours: otByEmp[e.id] || 0,
        advancesDeducted: advByEmp[e.id] || 0, monthDays, overrides: overridesByEmp[e.id] || {},
      });
      return { ...base, ...computed, status: 'draft', has_overrides: !!overridesByEmp[e.id] };
    });

    res.json({ month, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/payroll/ot — set one employee's OT hours for a month (draft only)
router.post('/ot', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...PAYROLL_ROLES);
    if (!user) return;
    const { employee_id, month, ot_hours } = req.body;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month are required' });

    const { data, error } = await supabase.from('employee_monthly_ot')
      .upsert({ employee_id, month, ot_hours: Number(ot_hours || 0), updated_by: user.name, updated_at: new Date().toISOString() }, { onConflict: 'employee_id,month' })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/payroll/override — manually correct one cell of one employee's
// draft month (any column except OT Hours, which uses POST /ot instead).
// Blocked once the month is finalized — reopen it first, same as every other
// edit path on this sheet. Sending an empty value clears the override, which
// reverts that cell back to the live formula.
router.patch('/override', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...PAYROLL_ROLES);
    if (!user) return;
    const { employee_id, month, field, value } = req.body;
    if (!employee_id || !month || !field) return res.status(400).json({ error: 'employee_id, month, and field are required' });
    if (!OVERRIDE_FIELDS.includes(field)) return res.status(400).json({ error: `field must be one of: ${OVERRIDE_FIELDS.join(', ')}` });

    const { data: existingRun } = await supabase.from('employee_payroll_runs').select('employee_id').eq('employee_id', employee_id).eq('month', month).maybeSingle();
    if (existingRun) return res.status(400).json({ error: 'This month is already finalized — reopen it before editing' });

    const { data: existing } = await supabase.from('employee_payroll_overrides').select('*').eq('employee_id', employee_id).eq('month', month).maybeSingle();
    const row = {
      ...(existing || { employee_id, month }),
      [field]: value === '' || value === null || value === undefined ? null : Number(value),
      updated_by: user.name, updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('employee_payroll_overrides').upsert(row, { onConflict: 'employee_id,month' }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/payroll/finalize — snapshot one employee's month and settle
// whatever advances are outstanding for them right now.
router.post('/finalize', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...PAYROLL_ROLES);
    if (!user) return;
    const { employee_id, month } = req.body;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month are required' });

    const { data: emp, error: empErr } = await supabase.from('employees').select('*').eq('id', employee_id).single();
    if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

    const { monthDays, from, to } = monthRange(month);
    const [{ data: attendance }, { data: otRow }, { data: outstandingAdvances }, { data: overrideRow }] = await Promise.all([
      supabase.from('employee_attendance').select('employee_id, status').eq('employee_id', employee_id).gte('date', from).lte('date', to),
      supabase.from('employee_monthly_ot').select('ot_hours').eq('employee_id', employee_id).eq('month', month).maybeSingle(),
      supabase.from('books_ledger').select('id, amount').eq('employee_id', employee_id).eq('is_advance', true).eq('settled', false),
      supabase.from('employee_payroll_overrides').select('*').eq('employee_id', employee_id).eq('month', month).maybeSingle(),
    ]);

    const leavesTaken = (leavesFromAttendance(attendance))[employee_id] || 0;
    const otHours = Number(otRow?.ot_hours || 0);
    const advancesDeducted = (outstandingAdvances || []).reduce((s, a) => s + Number(a.amount || 0), 0);
    const computed = computeRow(emp, { leavesTaken, otHours, advancesDeducted, monthDays, overrides: overrideRow || {} });

    const { data: run, error: runErr } = await supabase.from('employee_payroll_runs')
      .upsert({ employee_id, month, ...computed, finalized_by: user.name, finalized_at: new Date().toISOString() }, { onConflict: 'employee_id,month' })
      .select('*').single();
    if (runErr) throw runErr;

    if (outstandingAdvances && outstandingAdvances.length > 0) {
      await supabase.from('books_ledger')
        .update({ settled: true, settled_date: new Date().toISOString().slice(0, 10), settled_note: `Deducted from ${month} payroll` })
        .in('id', outstandingAdvances.map((a) => a.id));
    }

    res.json(run);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/payroll/reopen — drop the frozen snapshot, back to draft/live.
// Does NOT un-settle advances already deducted — that's a manual Books Ledger
// action if truly needed, not something to silently reverse here.
router.post('/reopen', async (req, res) => {
  try {
    const user = await requireRole(req, res, ...PAYROLL_ROLES);
    if (!user) return;
    const { employee_id, month } = req.body;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month are required' });
    const { error } = await supabase.from('employee_payroll_runs').delete().eq('employee_id', employee_id).eq('month', month);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
