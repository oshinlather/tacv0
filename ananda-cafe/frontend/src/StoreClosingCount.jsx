import { useState, useEffect, useMemo, useRef } from "react";
import api from "./api";

// Store Inventory Module — Stage 4: blind closing count -> audit/variance -> owner
// rollup. New, separate file per the "don't rewrite App.jsx" rule.
//
// "Blind": the counting screen never fetches or shows system/expected quantity — it
// only ever calls saveStockCountItems (write) until Submit, at which point the backend
// computes variance server-side. The variance/audit view is a genuinely different
// screen (CountDetail after submit, and the VarianceRollup tab), not a toggle on the
// same one — so there's no client-side flag to accidentally flip mid-count.

const fmtQty = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }); };
const fmtMoney = (n) => `${Number(n) < 0 ? "-" : ""}₹${Math.abs(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() + 330); return d.toISOString().slice(0, 10); };

const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: "none", background: "#1A1A1A", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { padding: "10px 16px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", color: "#555", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };

const STATUS_COLORS = {
  in_progress: { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E", label: "🔵 In Progress" },
  submitted: { bg: "#F0FDF4", border: "#BBF7D0", text: "#166534", label: "✅ Submitted" },
  cancelled: { bg: "#FEF2F2", border: "#FECACA", text: "#991B1B", label: "🚫 Cancelled" },
};

export default function StoreClosingCount() {
  const [screen, setScreen] = useState("list"); // "list" | "count" | "detail" | "rollup"
  const [activeId, setActiveId] = useState(null);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setScreen("list")} style={{ flex: 1, padding: "10px", borderRadius: 10, border: screen === "list" || screen === "count" || screen === "detail" ? "none" : "1px solid #E0E0DC", background: screen === "list" || screen === "count" || screen === "detail" ? "#1A1A1A" : "#fff", color: screen === "list" || screen === "count" || screen === "detail" ? "#fff" : "#555", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>📋 Counts</button>
        <button onClick={() => setScreen("rollup")} style={{ flex: 1, padding: "10px", borderRadius: 10, border: screen === "rollup" ? "none" : "1px solid #E0E0DC", background: screen === "rollup" ? "#1A1A1A" : "#fff", color: screen === "rollup" ? "#fff" : "#555", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>📊 Variance Rollup</button>
      </div>
      {screen === "list" && <CountList onOpen={(id, status) => { setActiveId(id); setScreen(status === "in_progress" ? "count" : "detail"); }} />}
      {screen === "count" && activeId && <CountEntry id={activeId} onSubmitted={() => setScreen("detail")} onBack={() => setScreen("list")} />}
      {screen === "detail" && activeId && <CountDetail id={activeId} onBack={() => setScreen("list")} />}
      {screen === "rollup" && <VarianceRollup />}
    </div>
  );
}

function CountList({ onOpen }) {
  const [location, setLocation] = useState("");
  const [counts, setCounts] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const load = () => { const params = { from: todayStrMinus(30) }; if (location) params.location = location; api.getStockCounts(params).then(setCounts).catch((e) => setError(e.message)); };
  useEffect(load, [location]);

  const start = (loc) => {
    setStarting(true);
    api.startStockCount({ location_id: loc, count_date: todayStr() }).then((c) => onOpen(c.id, c.status)).catch((e) => setError(e.message)).finally(() => setStarting(false));
  };

  return (
    <div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400E" }}>
        🆕 New Store Inventory Module — Stage 4 (Beta). Counts are blind — you won't see the system quantity while counting; variance shows only after you submit.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => start("store")} disabled={starting} style={{ ...btnPrimary, flex: 1, opacity: starting ? 0.6 : 1 }}>🏬 Start Store Count</button>
        <button onClick={() => start("bk")} disabled={starting} style={{ ...btnPrimary, flex: 1, opacity: starting ? 0.6 : 1 }}>🏭 Start BK Count</button>
      </div>
      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {["", "store", "bk"].map((loc) => (
          <button key={loc || "all"} onClick={() => setLocation(loc)} style={{ padding: "6px 12px", borderRadius: 8, border: location === loc ? "none" : "1px solid #E0E0DC", background: location === loc ? "#1A1A1A" : "#fff", color: location === loc ? "#fff" : "#555", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{loc === "" ? "All" : loc === "store" ? "Store" : "BK"}</button>
        ))}
      </div>

      {counts === null && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
      {counts && counts.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No counts in the last 30 days.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(counts || []).map((c) => {
          const s = STATUS_COLORS[c.status] || STATUS_COLORS.in_progress;
          return (
            <div key={c.id} onClick={() => onOpen(c.id, c.status)} style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{c.location_id === "store" ? "🏬 Store" : "🏭 BK"} Count</div>
                <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{c.count_date} · by {c.counted_by || c.created_by}</div>
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: s.text, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: "2px 6px" }}>{s.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function todayStrMinus(n) { const d = new Date(); d.setMinutes(d.getMinutes() + 330); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

function CountEntry({ id, onSubmitted, onBack }) {
  const [count, setCount] = useState(null);
  const [items, setItems] = useState([]);
  const [entered, setEntered] = useState({}); // item_id -> qty string
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    api.getStockCount(id).then((c) => {
      setCount(c);
      const pre = {};
      (c.items || []).forEach((i) => { pre[i.item_id] = String(i.qty_entered ?? i.counted_qty); });
      setEntered(pre);
    }).catch((e) => setError(e.message));
    api.getStoreItems().then(setItems).catch(() => {});
  }, [id]);

  const categories = useMemo(() => Array.from(new Set(items.map((i) => i.category))).sort(), [items]);
  const visibleItems = useMemo(() => (category ? items.filter((i) => i.category === category) : items), [items, category]);
  const countedN = Object.values(entered).filter((v) => v !== "" && v != null).length;

  const setQty = (itemId, val) => {
    setEntered((e) => ({ ...e, [itemId]: val }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveOne(itemId, val), 700);
  };

  const saveOne = (itemId, val) => {
    if (val === "" || val == null || isNaN(Number(val))) return;
    const item = items.find((i) => i.id === itemId);
    setSaving(true);
    api.saveStockCountItems(id, { [itemId]: { qty: Number(val), unit: item?.base_unit } }).catch((e) => setError(e.message)).finally(() => setSaving(false));
  };

  const submit = () => {
    setError("");
    if (!countedN) return setError("Count at least one item before submitting.");
    setSubmitting(true);
    api.submitStockCount(id).then(() => onSubmitted()).catch((e) => setError(e.message)).finally(() => setSubmitting(false));
  };

  if (!count) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>{error || "Loading…"}</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onBack} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{count.location_id === "store" ? "🏬 Store" : "🏭 BK"} Count — {count.count_date}</div>
        <div style={{ fontSize: 11, color: saving ? "#B45309" : "#16A34A" }}>{saving ? "Saving…" : "✓ Saved"}</div>
      </div>
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "8px 14px", marginBottom: 12, fontSize: 11, color: "#1D4ED8" }}>
        👁️‍🗨️ Blind count — enter what you physically see, not what you expect. {countedN} of {items.length} items counted.
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, overflowX: "auto", paddingBottom: 4 }}>
        <button onClick={() => setCategory("")} style={{ padding: "6px 12px", borderRadius: 8, border: category === "" ? "none" : "1px solid #E0E0DC", background: category === "" ? "#1A1A1A" : "#fff", color: category === "" ? "#fff" : "#555", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>All</button>
        {categories.map((c) => (
          <button key={c} onClick={() => setCategory(c)} style={{ padding: "6px 12px", borderRadius: 8, border: category === c ? "none" : "1px solid #E0E0DC", background: category === c ? "#1A1A1A" : "#fff", color: category === c ? "#fff" : "#555", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{c}</button>
        ))}
      </div>

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        {visibleItems.map((it, idx) => (
          <div key={it.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: idx === 0 ? "none" : "1px solid #F0F0EE" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{it.name} <span style={{ fontSize: 10, color: "#999", fontWeight: 500 }}>({it.base_unit})</span></div>
            <input type="number" min="0" step="any" value={entered[it.id] || ""} onChange={(e) => setQty(it.id, e.target.value)} placeholder="0" style={{ ...inputStyle, width: 90, textAlign: "right" }} />
          </div>
        ))}
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={submitting} style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}>{submitting ? "Submitting…" : "✅ Submit Count"}</button>
      </div>
    </div>
  );
}

function CountDetail({ id, onBack }) {
  const [count, setCount] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { api.getStockCount(id).then(setCount).catch((e) => setError(e.message)); }, [id]);

  if (error) return <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>;
  if (!count) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>;

  const isSubmitted = count.status === "submitted";
  const items = (count.items || []).slice().sort((a, b) => Math.abs(b.variance_value || 0) - Math.abs(a.variance_value || 0));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onBack} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{count.location_id === "store" ? "🏬 Store" : "🏭 BK"} Count — {count.count_date}</div>
      </div>
      {!isSubmitted && <div style={{ color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 12 }}>This count isn't submitted yet — no variance to show.</div>}
      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden" }}>
        {items.map((it, idx) => (
          <div key={it.id} style={{ padding: "10px 14px", borderTop: idx === 0 ? "none" : "1px solid #F0F0EE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}>
              <div>{it.item_name}</div>
              {isSubmitted && <div style={{ color: Math.abs(it.variance_qty) < 1e-9 ? "#16A34A" : it.variance_qty < 0 ? "#DC2626" : "#B45309" }}>{it.variance_qty > 0 ? "+" : ""}{fmtQty(it.variance_qty)} {it.base_unit}</div>}
            </div>
            <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>
              Counted: {fmtQty(it.counted_qty)} {it.base_unit}
              {isSubmitted && <> · System: {fmtQty(it.system_qty_at_submit)} {it.base_unit}{it.variance_value != null && <> · {fmtMoney(it.variance_value)}</>}</>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VarianceRollup() {
  const [from, setFrom] = useState(todayStrMinus(30));
  const [location, setLocation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = { from }; if (location) params.location = location;
    api.getVarianceRollup(params).then(setData).catch((e) => setError(e.message));
  }, [from, location]);

  const totalValue = (data?.items || []).reduce((s, i) => s + (i.variance_value || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        {["", "store", "bk"].map((loc) => (
          <button key={loc || "all"} onClick={() => setLocation(loc)} style={{ padding: "9px 14px", borderRadius: 8, border: location === loc ? "none" : "1px solid #E0E0DC", background: location === loc ? "#1A1A1A" : "#fff", color: location === loc ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{loc === "" ? "All" : loc === "store" ? "Store" : "BK"}</button>
        ))}
      </div>
      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {data && (
        <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, padding: "12px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "#666" }}>{data.counts.length} submitted count{data.counts.length === 1 ? "" : "s"} · {data.items.length} item{data.items.length === 1 ? "" : "s"} with variance</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: totalValue < 0 ? "#DC2626" : totalValue > 0 ? "#16A34A" : "#555" }}>Net: {fmtMoney(totalValue)}</div>
        </div>
      )}
      {data && data.items.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No variance in this range.</div>}
      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden" }}>
        {(data?.items || []).map((it, idx) => (
          <div key={it.item_id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderTop: idx === 0 ? "none" : "1px solid #F0F0EE" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{it.item_name}</div>
              <div style={{ fontSize: 10, color: "#999" }}>{it.category} · {it.occurrences} count{it.occurrences === 1 ? "" : "s"}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: it.variance_qty < 0 ? "#DC2626" : it.variance_qty > 0 ? "#16A34A" : "#555" }}>{it.variance_qty > 0 ? "+" : ""}{fmtQty(it.variance_qty)} {it.base_unit}</div>
              {it.variance_value != null && <div style={{ fontSize: 11, color: "#999" }}>{fmtMoney(it.variance_value)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
