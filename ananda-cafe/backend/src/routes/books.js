// books.js — Books Ledger (Payments › Books)
//
// Owner-facing bookkeeping ledger, sourced from the "TAC - Books" WhatsApp
// group (staff drop a one-line expense or a UPI/Paytm screenshot in there
// all day) plus manual entries. Every expense carries an accounting
// category; advances to staff/vendors are tracked as outstanding until
// explicitly marked settled — same idea as the existing Custodian Ledger
// (cash_handovers) but for personal/vendor advances rather than cash-
// collection custody.

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireOwner } = require('./authGuards');

const CATEGORIES = [
  'cogs_dairy', 'cogs_vegetables', 'cogs_other',
  'utilities_electric', 'utilities_gas', 'utilities_water',
  'repairs_maintenance', 'labor_porter', 'staff_advance',
  'vendor_payment', 'uncategorized',
];

// ── GET /api/books — list entries, filterable by date range / category / advance status
router.get('/', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { from, to, category, is_advance, settled, outlet_id } = req.query;

    let query = supabase.from('books_ledger').select('*').order('entry_date', { ascending: false }).order('entry_time', { ascending: false });
    if (from) query = query.gte('entry_date', from);
    if (to) query = query.lte('entry_date', to);
    if (category) query = query.eq('category', category);
    if (is_advance !== undefined) query = query.eq('is_advance', is_advance === 'true');
    if (settled !== undefined) query = query.eq('settled', settled === 'true');
    if (outlet_id) query = query.eq('outlet_id', outlet_id);

    const { data, error } = await query;
    if (error) throw error;

    const summary = {
      total: data.reduce((s, r) => s + Number(r.amount || 0), 0),
      by_category: {},
      outstanding_advances: data.filter(r => r.is_advance && !r.settled).reduce((s, r) => s + Number(r.amount || 0), 0),
      needs_review_count: data.filter(r => r.needs_review).length,
    };
    data.forEach(r => {
      summary.by_category[r.category] = (summary.by_category[r.category] || 0) + Number(r.amount || 0);
    });

    res.json({ entries: data, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/books/advances — outstanding advances only, grouped by person
router.get('/advances', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { data, error } = await supabase.from('books_ledger')
      .select('*').eq('is_advance', true).order('entry_date', { ascending: false });
    if (error) throw error;

    const byPerson = {};
    data.forEach(r => {
      const key = r.advance_to || 'Unknown';
      if (!byPerson[key]) byPerson[key] = { person: key, outstanding: 0, settled: 0, entries: [] };
      byPerson[key][r.settled ? 'settled' : 'outstanding'] += Number(r.amount || 0);
      byPerson[key].entries.push(r);
    });

    res.json(Object.values(byPerson).sort((a, b) => b.outstanding - a.outstanding));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/books — create a manual entry
router.post('/', async (req, res) => {
  try {
    const user = await requireOwner(req, res);
    if (!user) return;
    const {
      entry_date, entry_time, submitted_by, description, category, amount,
      payment_mode, vendor_or_recipient, is_advance, advance_to, outlet_id, raw_message,
    } = req.body;

    if (!entry_date || !description || !category || amount === undefined) {
      return res.status(400).json({ error: 'entry_date, description, category and amount are required' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }

    const { data, error } = await supabase.from('books_ledger').insert({
      entry_date, entry_time: entry_time || null, submitted_by: submitted_by || user.name,
      description, category, amount: Number(amount),
      payment_mode: payment_mode || null, vendor_or_recipient: vendor_or_recipient || null,
      is_advance: !!is_advance, advance_to: is_advance ? (advance_to || null) : null,
      outlet_id: outlet_id || null, source: 'manual', raw_message: raw_message || null,
      created_by: user.id,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/books/:id — edit an entry, or mark an advance settled
router.patch('/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const updates = {};
    const editable = [
      'entry_date', 'entry_time', 'submitted_by', 'description', 'category', 'amount',
      'payment_mode', 'vendor_or_recipient', 'is_advance', 'advance_to', 'outlet_id',
      'needs_review', 'settled', 'settled_date', 'settled_note',
    ];
    for (const key of editable) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.category && !CATEGORIES.includes(updates.category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }
    // Settling an advance: stamp today's date if the caller didn't supply one
    if (updates.settled === true && !updates.settled_date) {
      updates.settled_date = new Date().toISOString().slice(0, 10);
    }

    const { data, error } = await supabase.from('books_ledger').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/books/:id — remove a wrongly-entered row (owner-only)
router.delete('/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('books_ledger').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
