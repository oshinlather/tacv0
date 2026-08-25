import { useState, useEffect, useRef } from "react";
import api from "./api";
import { DEMAND_SECTIONS } from "./App";

// Store Inventory Module — Stage 5 course-correction: BK's own closing stock + wastage
// submission. New capability — BK never had this before (confirmed with the owner: "we
// are not recording wastage and closing for base kitchen"). Deliberately reuses the
// SAME closing_stocks/demands tables and the SAME item catalog (DEMAND_SECTIONS)
// outlets already submit through — outlet_id='bk' is just another value in those same
// tables, not a new schema. This is what lets computeStockUsageForDate treat BK exactly
// like any other outlet going forward (Opening=Yesterday Closing, +Dispatched,
// -Wastage, -Today Closing = Consumed) instead of the retired bk_closing_stock-based
// special case, which was reading Store's data, not BK's.

const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() + 330); return d.toISOString().slice(0, 10); };
const getCurrentUserName = () => { try { return JSON.parse(localStorage.getItem("ananda_user"))?.name || "BK"; } catch (e) { return "BK"; } };

const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: "none", background: "#1A1A1A", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const inputStyle = { width: 76, padding: "8px 6px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 700 };

export default function BKClosingWastage() {
  const [mode, setMode] = useState("closing"); // "closing" | "wastage"
  const [section, setSection] = useState(DEMAND_SECTIONS[0].id);
  const [draft, setDraft] = useState({}); // item_id -> qty string
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(null);
  const saveTimer = useRef(null);

  const load = () => {
    if (mode === "closing") {
      api.getClosingStock({ outlet_id: "bk", date: todayStr() }).then((rows) => {
        const row = (rows || [])[0];
        setExisting(row || null);
        if (row?.items) {
          const d = {};
          Object.entries(row.items).forEach(([k, v]) => { d[k.replace(/^cs_/, "")] = String(v); });
          setDraft(d);
        } else setDraft({});
      }).catch(() => {});
    } else {
      // GET /api/demands only filters by outlet_id/date, not type — a 'bk' outlet_id
      // could have both this wastage row and a 'bk_demand' row on the same date, so the
      // type match has to happen client-side.
      api.getDemands({ outlet_id: "bk", date: todayStr() }).then((rows) => {
        const row = (Array.isArray(rows) ? rows : []).find((r) => r.type === "wastage") || null;
        setExisting(row);
        if (row?.items) {
          const d = {}; Object.entries(row.items).forEach(([k, v]) => { d[k] = String(v); }); setDraft(d);
        } else setDraft({});
      }).catch(() => {});
    }
  };
  useEffect(load, [mode]);

  const setQty = (itemId, val) => {
    setDraft((p) => ({ ...p, [itemId]: val }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save({ ...draft, [itemId]: val }), 800);
  };

  const save = async (values) => {
    const items = {}; const items_units = {};
    Object.entries(values).forEach(([itemId, v]) => {
      if (v === "" || v == null || isNaN(Number(v))) return;
      const key = mode === "closing" ? `cs_${itemId}` : itemId;
      items[key] = Number(v);
      const found = DEMAND_SECTIONS.flatMap((s) => s.items).find((i) => i.id === itemId);
      if (found) items_units[key] = found.unit;
    });
    if (!Object.keys(items).length) return;
    setSaving(true);
    setError("");
    try {
      if (mode === "closing") {
        // submitted_by deliberately omitted — closing_stocks.submitted_by is a UUID
        // column the real OutletMgr closing-stock screen never populates either
        // (confirmed against real data: always null there); demands.submitted_by below
        // is a plain text column, different from this one despite the similar name.
        await api.submitClosingStock({ outlet_id: "bk", items, items_units, date: todayStr() });
      } else {
        await api.createDemand({ outlet_id: "bk", type: "wastage", items, items_units, submitted_by: getCurrentUserName(), date: todayStr(), status: "submitted" });
      }
      setSavedAt(new Date());
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const sec = DEMAND_SECTIONS.find((s) => s.id === section);
  const filledCount = Object.values(draft).filter((v) => v !== "" && v != null).length;

  return (
    <div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400E" }}>
        🆕 BK's own Closing Stock &amp; Wastage — new capability, part of the Stage 5 migration. This feeds P&amp;L's BK consumption figure the same way outlet closing stock/wastage already does.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setMode("closing")} style={{ flex: 1, padding: "10px", borderRadius: 10, border: mode === "closing" ? "none" : "1px solid #E0E0DC", background: mode === "closing" ? "#1A1A1A" : "#fff", color: mode === "closing" ? "#fff" : "#555", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>📊 Closing Stock</button>
        <button onClick={() => setMode("wastage")} style={{ flex: 1, padding: "10px", borderRadius: 10, border: mode === "wastage" ? "none" : "1px solid #E0E0DC", background: mode === "wastage" ? "#DC2626" : "#fff", color: mode === "wastage" ? "#fff" : "#555", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>🗑️ Wastage</button>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4 }}>
        {DEMAND_SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ padding: "7px 12px", borderRadius: 8, border: section === s.id ? "none" : `1px solid ${s.border}`, background: section === s.id ? s.color : s.bg, color: section === s.id ? "#fff" : s.color, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{s.emoji} {s.titleHi}</button>
        ))}
      </div>

      <div style={{ fontSize: 11, color: saving ? "#B45309" : savedAt ? "#16A34A" : "#999", marginBottom: 8 }}>
        {saving ? "Saving…" : savedAt ? `✓ Saved ${savedAt.toLocaleTimeString()}` : `${filledCount} item(s) entered today`}
      </div>
      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden" }}>
        {sec.items.map((item, idx) => (
          <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: idx === 0 ? "none" : "1px solid #F0F0EE" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name} <span style={{ fontSize: 10, color: "#999", fontWeight: 500 }}>({item.unit})</span></div>
            <input type="number" min="0" step="any" value={draft[item.id] || ""} onChange={(e) => setQty(item.id, e.target.value)} placeholder="0" style={inputStyle} />
          </div>
        ))}
      </div>
    </div>
  );
}
