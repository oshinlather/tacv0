// ── POST /api/inventory/items — Add new inventory item
router.post('/inventory/items', async (req, res) => {
  try {
    const { id, name, category, unit, threshold } = req.body;
    const { error } = await supabase.from('inventory_items').insert({ id, name, category, unit, threshold: threshold || 0 });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/inventory/items/:id — Delete inventory item
router.delete('/inventory/items/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('inventory_items').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
