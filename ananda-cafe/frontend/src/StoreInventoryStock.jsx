import { useState, useEffect } from "react";
import api from "./api";

// Store Inventory Module — current-stock view, now the FULL replacement for the old
// Inventory screen's day-to-day job (view stock, see what's running low, issue stock
// with a reason), not just a Stage 1 read-only preview. Stage 6 course-correction: the
// old screen turned out to still be a live, actively-used SECOND ordering/receiving
// path running in parallel with Vendor Challans (own vendor-ordering sub-flow creating
// purchase_orders + old /stock-in, completely separate ledger from this one) — the
// likely real source of "why doesn't this number match" bugs. Closing this screen's
// remaining gaps (reorder thresholds, batch issue) is what lets the old one actually be
// retired instead of silently running alongside this one.
// Kept as its own file per the "don't rewrite App.jsx" rule — App.jsx only imports and
// wires a tab to <StoreInventoryStock />.

const CATEGORIES = ["Food", "Dairy", "Vegetable", "Grocery", "Masala", "Packaging", "Cleaning", "Gas", "Store"];

const fmtQty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};

const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: "none", background: "#1A1A1A", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { padding: "10px 16px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", color: "#555", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };

export default function StoreInventoryStock() {
  const [location, setLocation] = useState("store"); // "" = both, "store", "bk" — Issue/Thresholds need a single location, so default to one rather than "both"
  const [category, setCategory] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [mode, setMode] = useState("view"); // "view" | "issue" | "thresholds"
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    const params = {};
    if (location) params.location = location;
    if (category) params.category = category;
    api.getStoreStock(params).then(setRows).catch((e) => setError(e.message || "Failed to load"));
  };
  useEffect(load, [location, category]);

  const visibleRows = lowOnly ? (rows || []).filter((r) => r.below_threshold) : rows;
  const grouped = {};
  (visibleRows || []).forEach((r) => {
    const cat = r.category || "Other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
  });
  const lowCount = (rows || []).filter((r) => r.below_threshold).length;

  if (mode === "issue" && location) return <BatchIssue rows={rows || []} locationId={location} onDone={() => { setMode("view"); load(); }} onCancel={() => setMode("view")} />;
  if (mode === "thresholds") return <ThresholdEditor rows={rows || []} onDone={() => { setMode("view"); load(); }} onCancel={() => setMode("view")} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["", "store", "bk"].map((loc) => (
            <button key={loc || "all"} onClick={() => setLocation(loc)} style={{ padding: "7px 14px", borderRadius: 8, border: location === loc ? "none" : "1px solid #E0E0DC", background: location === loc ? "#1A1A1A" : "#fff", color: location === loc ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {loc === "" ? "All Locations" : loc === "store" ? "🏬 Store" : "🏭 BK"}
            </button>
          ))}
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }}>
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={() => setLowOnly((v) => !v)} style={{ padding: "7px 14px", borderRadius: 8, border: lowOnly ? "none" : "1px solid #FECACA", background: lowOnly ? "#DC2626" : "#FEF2F2", color: lowOnly ? "#fff" : "#DC2626", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            ⚠️ Low Stock{lowCount > 0 ? ` (${lowCount})` : ""}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setMode("thresholds")} style={btnGhost}>⚙️ Thresholds</button>
          <button onClick={() => setMode("issue")} disabled={!location} title={!location ? "Pick Store or BK first" : ""} style={{ ...btnPrimary, opacity: location ? 1 : 0.5 }}>📤 Issue Stock</button>
        </div>
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>}
      {!error && rows === null && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
      {!error && rows && visibleRows.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No items found.</div>}

      {Object.keys(grouped).sort().map((cat) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#666", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>{cat}</div>
          <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden" }}>
            {grouped[cat].sort((a, b) => a.name.localeCompare(b.name)).map((item, i) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: i === 0 ? "none" : "1px solid #F0F0EE", background: item.below_threshold ? "#FEF2F2" : "transparent" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item.below_threshold && "⚠️ "}{item.name}</div>
                  <div style={{ fontSize: 10, color: "#999" }}>{item.base_unit}{item.reorder_threshold != null ? ` · min ${fmtQty(item.reorder_threshold)}` : ""}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {location ? (
                    <div style={{ fontSize: 14, fontWeight: 700, color: item.below_threshold ? "#DC2626" : "#1A1A1A" }}>{fmtQty(item.current_qty)} <span style={{ fontSize: 10, color: "#999", fontWeight: 500 }}>{item.base_unit}</span></div>
                  ) : (
                    <div style={{ fontSize: 11, color: "#666" }}>
                      Store: <b>{fmtQty(item.store_qty)}</b> · BK: <b>{fmtQty(item.bk_qty)}</b>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Batch Issue — the direct replacement for the old Inventory screen's "Smart Issue"
// Stock Out: pick a qty for as many items as needed, one shared reason, submit in one
// call. No pre-fill from a calculated requisition (the old "from Requisition" mode) —
// RM Audit's own ideal-vs-actual comparison already computes that independently from
// recipes × sales (confirmed in code, not guessed), so this only needs to record what
// actually left the shelf, same as the old screen's plain "Stock Out" mode did.
function BatchIssue({ rows, locationId, onDone, onCancel }) {
  const [qty, setQty] = useState({}); // item_id -> string
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const visible = rows.filter((r) => !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()));
  const entries = Object.entries(qty).filter(([, v]) => Number(v) > 0);

  const submit = async () => {
    setError("");
    if (!entries.length) return setError("Enter a quantity for at least one item.");
    if (!reason.trim()) return setError("A reason is required.");
    setSaving(true);
    try {
      const items = entries.map(([item_id, v]) => ({ item_id, qty: -Math.abs(Number(v)) }));
      const result = await api.adjustStoreStockBatch({ location_id: locationId, reason: reason.trim(), items });
      if (result.went_negative?.length) {
        setError(`Saved, but ${result.went_negative.length} item(s) are now negative — worth a physical check: ${result.went_negative.map((n) => n.item_id).join(", ")}`);
        setTimeout(onDone, 2500);
      } else {
        onDone();
      }
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onCancel} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800 }}>📤 Issue Stock — {locationId === "store" ? "Store" : "BK"}</div>
      </div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#92400E" }}>
        For stock going out that isn't a BK Demand dispatch and isn't a Closing Count variance — breakage, spoilage, samples, given away, etc. Enter what actually left, not what should have.
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Search items…" style={{ ...inputStyle, marginBottom: 10 }} />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required) — e.g. breakage, given to catering" style={{ ...inputStyle, marginBottom: 14 }} />

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        {visible.map((item, i) => (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderTop: i === 0 ? "none" : "1px solid #F0F0EE", background: Number(qty[item.id]) > 0 ? "#FEF2F2" : "transparent" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
              <div style={{ fontSize: 10, color: "#999" }}>On hand: {fmtQty(item.current_qty)} {item.base_unit}</div>
            </div>
            <input type="number" min="0" step="any" placeholder="0" value={qty[item.id] || ""} onChange={(e) => setQty((p) => ({ ...p, [item.id]: e.target.value }))} style={{ width: 70, padding: 8, borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} />
            <span style={{ fontSize: 10, color: "#999", width: 26 }}>{item.base_unit}</span>
          </div>
        ))}
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, position: "sticky", bottom: 0, paddingBottom: 8, background: "linear-gradient(transparent, #FAF9F6 20%)" }}>
        <button onClick={submit} disabled={saving || !entries.length} style={{ ...btnPrimary, flex: 1, opacity: saving || !entries.length ? 0.6 : 1 }}>{saving ? "Saving…" : `Issue ${entries.length} item(s)`}</button>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
      </div>
    </div>
  );
}

// Threshold Editor — direct port of the old Inventory screen's threshold-setting UI
// onto the new items.reorder_threshold column.
function ThresholdEditor({ rows, onDone, onCancel }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(rows.map((r) => [r.id, r.reorder_threshold ?? ""])));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // rows is location-filtered upstream but a threshold is per-item, not per-location —
  // dedupe by item id in case the caller is on "All Locations" (store_qty/bk_qty shape).
  const items = Array.from(new Map(rows.map((r) => [r.id, r])).values());
  const visible = items.filter((r) => !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()));

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const changed = items.filter((r) => String(draft[r.id] ?? "") !== String(r.reorder_threshold ?? "")).map((r) => ({ id: r.id, threshold: draft[r.id] === "" ? null : Number(draft[r.id]) }));
      if (changed.length) await api.saveStoreThresholds(changed);
      onDone();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onCancel} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800 }}>⚙️ Reorder Thresholds</div>
      </div>
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "#1D4ED8", marginBottom: 14 }}>Set the minimum stock level for each item — Store Stock flags anything at or below this. Leave blank for no alert.</div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Search items…" style={{ ...inputStyle, marginBottom: 10 }} />

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        {visible.map((item, i) => (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderTop: i === 0 ? "none" : "1px solid #F0F0EE" }}>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{item.name}</div>
            <input type="number" min="0" step="any" placeholder="none" value={draft[item.id] ?? ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: e.target.value }))} style={{ width: 70, padding: 8, borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} />
            <span style={{ fontSize: 10, color: "#999", width: 26 }}>{item.base_unit}</span>
          </div>
        ))}
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, position: "sticky", bottom: 0, paddingBottom: 8, background: "linear-gradient(transparent, #FAF9F6 20%)" }}>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, flex: 1, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "💾 Save Thresholds"}</button>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
      </div>
    </div>
  );
}
