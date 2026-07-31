// todos.js — Owner To Do list (Owner Dashboard › ✅ To Do)
//
// Owner-facing task list, initially sourced from the "TAC Managers"
// WhatsApp group (day-end report summary photo + surrounding discussion),
// same pattern as books.js/books_ledger. Owner can also add/edit/complete
// tasks manually from the dashboard.

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireAuth, requireOwner } = require('./authGuards');

const CATEGORIES = ['operational_issue', 'vendor_payment', 'complaint', 'process', 'general'];

// ── GET /api/todos — list tasks, filterable by status/category
router.get('/', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { status, category } = req.query;

    let query = supabase.from('owner_todos').select('*')
      .order('status', { ascending: true })
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);

    const { data, error } = await query;
    if (error) throw error;

    const summary = {
      open: data.filter((r) => r.status === 'open').length,
      done: data.filter((r) => r.status === 'done').length,
      needs_review: data.filter((r) => r.needs_review && r.status === 'open').length,
      open_vendor_amount: data.filter((r) => r.status === 'open' && r.category === 'vendor_payment')
        .reduce((s, r) => s + Number(r.amount || 0), 0),
    };

    res.json({ todos: data, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/todos — create a task manually
router.post('/', async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (user.role !== 'owner') return res.status(403).json({ error: 'Owners only' });
    const { title, category, amount, priority, due_date, notes, source, raw_message } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }

    const { data, error } = await supabase.from('owner_todos').insert({
      title, category: category || 'general', amount: amount != null ? Number(amount) : null,
      priority: priority || 'normal', due_date: due_date || null, notes: notes || null,
      source: source || 'manual', raw_message: raw_message || null, created_by: user.name,
    }).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/todos/:id — edit a task, or mark done/reopen
router.patch('/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const updates = { updated_at: new Date().toISOString() };
    const editable = ['title', 'category', 'amount', 'priority', 'due_date', 'notes', 'status', 'needs_review'];
    for (const key of editable) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.category && !CATEGORIES.includes(updates.category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }
    // Stamp/clear completed_at when status flips
    if (updates.status === 'done') updates.completed_at = new Date().toISOString();
    else if (updates.status === 'open') updates.completed_at = null;

    const { data, error } = await supabase.from('owner_todos').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/todos/:id — remove a task
router.delete('/:id', async (req, res) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { error } = await supabase.from('owner_todos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
