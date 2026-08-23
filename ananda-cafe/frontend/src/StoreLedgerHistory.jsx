import { useState, useEffect } from "react";
import api from "./api";

// Store Inventory Module — Stage 5 course-correction. Checks the OLD system's own
// Stock In/Stock Out movement log against its own real physical counts (the "BK Closing
// Stock" table — confirmed with the owner this has only ever been Store's real count,
// mislabeled). Finding, from real data, not assumed: across all 19 gaps between
// consecutive real counts (2026-07-16 to 2026-08-22, 2,112 item-days), ZERO had any
// logged Stock In/Out movement — the old ledger has been completely unused this whole
// time. This page exists to make that checkable at a glance rather than take it on
// faith, and to show exactly where the physical counts moved with nothing logged to
// explain it.

const fmtQty = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }); };

export default function StoreLedgerHistory() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [gapIdx, setGapIdx] = useState(null); // null = summary view

  useEffect(() => {
    api.getStoreLedgerHistory().then((d) => { setData(d); setGapIdx(d.gaps.length - 1); }).catch((e) => setError(e.message));
  }, []);

  if (error) return <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>;
  if (!data) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>;

  const totalItemDays = data.gaps.reduce((s, g) => s + g.items.length, 0);
  const totalLogged = data.gaps.reduce((s, g) => s + g.items.filter((i) => i.moved !== 0).length, 0);
  const gap = gapIdx != null ? data.gaps[gapIdx] : null;

  return (
    <div>
      <div style={{ background: totalLogged === 0 ? "#FEF2F2" : "#FFFBEB", border: `1px solid ${totalLogged === 0 ? "#FECACA" : "#FDE68A"}`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 12, color: totalLogged === 0 ? "#991B1B" : "#92400E" }}>
        {totalLogged === 0
          ? <>⚠️ Across all {data.gaps.length} gaps between real counts ({data.count_dates[0]} → {data.count_dates[data.count_dates.length - 1]}, {totalItemDays} item-days), <b>zero</b> had any logged Stock In/Out movement. The old ledger has been unused this whole time — treat the latest real count as ground truth, not the running ledger.</>
          : <>{totalLogged} of {totalItemDays} item-days had a logged movement.</>}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4 }}>
        {data.gaps.map((g, i) => (
          <button key={i} onClick={() => setGapIdx(i)} style={{ padding: "8px 12px", borderRadius: 8, border: gapIdx === i ? "none" : "1px solid #E0E0DC", background: gapIdx === i ? "#1A1A1A" : "#fff", color: gapIdx === i ? "#fff" : "#555", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {g.from_date} → {g.to_date}
          </button>
        ))}
      </div>

      {gap && (
        <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr", gap: 8, padding: "8px 14px", background: "#FAFAF8", fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase" }}>
            <div>Item</div><div style={{ textAlign: "right" }}>Before</div><div style={{ textAlign: "right" }}>Logged Moved</div><div style={{ textAlign: "right" }}>Expected</div><div style={{ textAlign: "right" }}>Actual Count</div><div style={{ textAlign: "right" }}>Variance</div>
          </div>
          {gap.items.map((it, idx) => (
            <div key={it.item_id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr", gap: 8, padding: "8px 14px", borderTop: idx === 0 ? "none" : "1px solid #F0F0EE", fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{it.name} <span style={{ color: "#999", fontWeight: 400 }}>({it.unit})</span></div>
              <div style={{ textAlign: "right", color: "#888" }}>{fmtQty(it.before)}</div>
              <div style={{ textAlign: "right", color: it.moved === 0 ? "#CCC" : "#2563EB" }}>{it.moved === 0 ? "—" : (it.moved > 0 ? "+" : "") + fmtQty(it.moved)}</div>
              <div style={{ textAlign: "right", color: "#888" }}>{fmtQty(it.expected_after)}</div>
              <div style={{ textAlign: "right", fontWeight: 700 }}>{fmtQty(it.actual_after)}</div>
              <div style={{ textAlign: "right", fontWeight: 700, color: Math.abs(it.variance) < 0.01 ? "#16A34A" : it.variance > 0 ? "#DC2626" : "#B45309" }}>{it.variance > 0 ? "+" : ""}{fmtQty(it.variance)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
