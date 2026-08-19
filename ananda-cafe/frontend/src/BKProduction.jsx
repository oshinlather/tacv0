import { useState, useEffect } from "react";
import api from "./api";

// Store Inventory Module — Stage 5: BK Production stock-in. Records "BK cooked a batch
// of X" as a real ledger event (consumes ingredients, produces the output), fixing the
// gap the migration-comparison tool found — BK-prepared items had no stock-in path at
// all before this, only Vendor Challans (external purchases). New, separate file per
// the "don't rewrite App.jsx" rule.

const fmtQty = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 3 }); };
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() + 330); return d.toISOString().slice(0, 10); };
const todayStrMinus = (n) => { const d = new Date(); d.setMinutes(d.getMinutes() + 330); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: "none", background: "#1A1A1A", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { padding: "10px 16px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", color: "#555", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };

export default function BKProduction() {
  const [screen, setScreen] = useState("list"); // "list" | "new"
  if (screen === "new") return <NewRun onDone={() => setScreen("list")} onCancel={() => setScreen("list")} />;
  return <RunList onNew={() => setScreen("new")} />;
}

function RunList({ onNew }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { api.getProductionRuns({ from: todayStrMinus(30) }).then(setRuns).catch((e) => setError(e.message)); }, []);

  return (
    <div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400E" }}>
        🆕 New Store Inventory Module — Stage 5 (Beta). Records BK-prepared batches (sambhar, batters, chutneys) as real stock-in — the gap between "dispatched out" and "never replenished" this fixes.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button onClick={onNew} style={{ ...btnPrimary, background: "#B45309" }}>🏭 Record a Batch</button>
      </div>
      {error && <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>}
      {!error && runs === null && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
      {!error && runs && runs.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No production runs in the last 30 days.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(runs || []).map((r) => (
          <div key={r.id} style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{r.output_item_name}</div>
              <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{r.produced_date} · {r.batches} batch{Number(r.batches) === 1 ? "" : "es"} · by {r.produced_by}</div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#16A34A" }}>+{fmtQty(r.yield_qty)} {r.output_base_unit || r.yield_unit}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewRun({ onDone, onCancel }) {
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recipeId, setRecipeId] = useState("");
  const [batches, setBatches] = useState("1");
  const [yieldOverride, setYieldOverride] = useState("");
  const [producedDate, setProducedDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.getProductionRecipes().then((r) => { setRecipes(r); setLoading(false); }).catch((e) => { setError(e.message); setLoading(false); }); }, []);

  const recipe = recipes.find((r) => r.recipe_id === recipeId);
  const batchNum = Number(batches) || 0;
  const computedYield = recipe ? Number(recipe.yield_qty) * batchNum : 0;
  const actualYield = yieldOverride ? Number(yieldOverride) : computedYield;

  const submit = async () => {
    setError("");
    if (!recipe) return setError("Pick a recipe.");
    if (!(batchNum > 0)) return setError("Batches must be a positive number.");
    setSaving(true);
    try {
      await api.recordProduction({ recipe_id: recipeId, batches: batchNum, yield_qty: yieldOverride ? Number(yieldOverride) : undefined, produced_date: producedDate, notes: notes || undefined });
      onDone();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  if (loading) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onCancel} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800 }}>🏭 Record a Batch</div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: "#888", marginBottom: 6, display: "block" }}>What did you make?</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {recipes.map((r) => (
            <button key={r.recipe_id} onClick={() => setRecipeId(r.recipe_id)} disabled={!r.fully_resolved}
              style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, border: recipeId === r.recipe_id ? "2px solid #B45309" : "1px solid #E0E0DC", background: recipeId === r.recipe_id ? "#FFFBEB" : r.fully_resolved ? "#fff" : "#FAFAF8", cursor: r.fully_resolved ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: r.fully_resolved ? 1 : 0.6 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{r.name}</div>
              <div style={{ fontSize: 10, color: "#999" }}>Yields {r.yield_qty} {r.yield_unit} per batch · {r.ingredients.length} ingredients</div>
              {!r.fully_resolved && <div style={{ fontSize: 10, color: "#DC2626", marginTop: 2 }}>⚠️ Missing item mapping for: {r.unresolved.join(", ")} — fix in raw_materials first</div>}
            </button>
          ))}
        </div>
      </div>

      {recipe && (
        <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#888", marginBottom: 4, display: "block" }}>Batches</label>
              <input type="number" min="0" step="any" value={batches} onChange={(e) => setBatches(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#888", marginBottom: 4, display: "block" }}>Date</label>
              <input type="date" value={producedDate} onChange={(e) => setProducedDate(e.target.value)} style={inputStyle} />
            </div>
          </div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#888", marginBottom: 4, display: "block" }}>Actual yield (optional — defaults to {fmtQty(computedYield)} {recipe.yield_unit})</label>
          <input type="number" min="0" step="any" value={yieldOverride} onChange={(e) => setYieldOverride(e.target.value)} placeholder={String(computedYield)} style={inputStyle} />

          <div style={{ marginTop: 14, padding: "10px 12px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#166534", marginBottom: 6 }}>Will produce: +{fmtQty(actualYield)} {recipe.yield_unit}</div>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>Will consume from BK stock:</div>
            {recipe.ingredients.map((ing) => (
              <div key={ing.item_id} style={{ fontSize: 11, color: "#888", display: "flex", justifyContent: "space-between" }}>
                <span>{ing.item_id}</span><span>−{fmtQty(ing.qty_per_batch * batchNum)}</span>
              </div>
            ))}
          </div>

          <label style={{ fontSize: 11, fontWeight: 700, color: "#888", marginTop: 12, marginBottom: 4, display: "block" }}>Notes (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, minHeight: 44, resize: "vertical" }} />
        </div>
      )}

      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={!recipe || saving} style={{ ...btnPrimary, background: "#B45309", opacity: recipe && !saving ? 1 : 0.5 }}>{saving ? "Saving…" : "✅ Record Batch → Stock In"}</button>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
      </div>
    </div>
  );
}
