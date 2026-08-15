import { useState, useEffect } from "react";
import api from "./api";

// Store Inventory Module — Stage 1: read-only current-stock view.
// New, separate item master (items/item_units/stock_movements/store_stock_balances),
// backfilled from the existing inventory_items/inventory_stock/bk_closing_stock data.
// Deliberately minimal per the Stage 1 scope — no editing here yet; Stage 2 (receipts)
// and Stage 3 (dispatch) will add the write flows that actually move these numbers.
// Kept as its own file per the "don't rewrite App.jsx" rule — App.jsx only imports and
// wires a tab to <StoreInventoryStock />.

const CATEGORIES = ["Food", "Dairy", "Vegetable", "Grocery", "Masala", "Packaging", "Cleaning", "Gas", "Store"];

const fmtQty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};

export default function StoreInventoryStock() {
  const [location, setLocation] = useState(""); // "" = both, "store", "bk"
  const [category, setCategory] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError("");
    const params = {};
    if (location) params.location = location;
    if (category) params.category = category;
    api.getStoreStock(params)
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setError(e.message || "Failed to load"); });
    return () => { cancelled = true; };
  }, [location, category]);

  const grouped = {};
  (rows || []).forEach((r) => {
    const cat = r.category || "Other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
  });

  return (
    <div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400E" }}>
        🆕 New Store Inventory Module — Stage 1 (read-only). Backfilled from the existing Inventory data. Stock-in / stock-out flows land in later stages.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {["", "store", "bk"].map((loc) => (
            <button key={loc || "all"} onClick={() => setLocation(loc)} style={{ padding: "7px 14px", borderRadius: 8, border: location === loc ? "none" : "1px solid #E0E0DC", background: location === loc ? "#1A1A1A" : "#fff", color: location === loc ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {loc === "" ? "All Locations" : loc === "store" ? "🏬 Store" : "🏭 BK"}
            </button>
          ))}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }}>
          <option value="">All Categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>}
      {!error && rows === null && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
      {!error && rows && rows.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No items found.</div>}

      {Object.keys(grouped).sort().map((cat) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#666", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>{cat}</div>
          <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, overflow: "hidden" }}>
            {grouped[cat].sort((a, b) => a.name.localeCompare(b.name)).map((item, i) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: i === 0 ? "none" : "1px solid #F0F0EE" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                  <div style={{ fontSize: 10, color: "#999" }}>{item.base_unit}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {location ? (
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{fmtQty(item.current_qty)} <span style={{ fontSize: 10, color: "#999", fontWeight: 500 }}>{item.base_unit}</span></div>
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
