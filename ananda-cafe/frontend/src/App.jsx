import { useState, useMemo, useCallback, useEffect } from "react";
import api from "./api";

/* ═══════════════════════════════════════════════════════════════════════════
   ANANDA CAFE — COMPLETE SYSTEM
   Launcher → Owner Dashboard (COGS + P&L) | Outlet Manager | Store Manager
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── SHARED DATA ────────────────────────────────────────────────────────────
const OUTLETS = [
  { id: "sec23", name: "Sector 23", short: "S-23" },
  { id: "sec31", name: "Sector 31", short: "S-31" },
  { id: "sec56", name: "Sector 56", short: "S-56" },
  { id: "elan", name: "Elan (Franchise)", short: "ELAN" },
];
const today = () => new Date().toISOString().split("T")[0];
const timeNow = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
const fmt = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const pct = (n) => (n || 0).toFixed(1) + "%";

// ─── P&L LINE ITEMS (from user's Excel) ─────────────────────────────────────
const PNL_REVENUE = [
  { id: "effective_sale", label: "Effective Sale", color: "#166534", bg: "#F0FDF4" },
  { id: "total_sale", label: "Total Sale", color: "#B45309", bg: "#FFFBEB" },
  { id: "delivery", label: "Delivery", color: "#1A1A1A", bg: "#fff" },
  { id: "online_commission", label: "Online Commission", color: "#DC2626", bg: "#FEF2F2", negative: true },
];
const PNL_FIXED_EXPENSES = [
  { id: "rent", label: "Rent" },
  { id: "salary", label: "Salary" },
];
const PNL_VARIABLE_EXPENSES = [
  { id: "raw_material", label: "Raw Material", highlight: true },
  { id: "vegetable", label: "Vegetable", highlight: true },
  { id: "dairy", label: "Dairy" },
  { id: "disposal", label: "Disposal", highlight: true },
  { id: "gas", label: "Gas", highlight: true },
  { id: "electricity", label: "Electricity Bill" },
  { id: "water_tanker", label: "Water Tanker" },
  { id: "transport", label: "Transport" },
];
const PNL_OTHER_EXPENSES = [
  { id: "staff_room_rent", label: "Staff Room Rent" },
  { id: "staff_room_elec", label: "Staff Room Electricity" },
  { id: "staff_welfare", label: "Staff Welfare" },
  { id: "mala", label: "Mala" },
  { id: "other", label: "Other" },
  { id: "maintenance", label: "Maintenance" },
  { id: "new_purchase", label: "New Purchase" },
  { id: "vendor_payments", label: "Vendor Payments" },
  { id: "zomato_ads", label: "Zomato Ads" },
  { id: "swiggy_ads", label: "Swiggy Ads" },
  { id: "gst", label: "GST" },
  { id: "profit_tax", label: "Profit Tax" },
];
const ALL_EXPENSES = [...PNL_FIXED_EXPENSES, ...PNL_VARIABLE_EXPENSES, ...PNL_OTHER_EXPENSES];

// Generate sample P&L data
const genPnlData = () => {
  const data = {};
  OUTLETS.forEach((o) => {
    const days = {};
    for (let d = 0; d < 30; d++) {
      const dt = new Date(); dt.setDate(dt.getDate() - d);
      const ds = dt.toISOString().split("T")[0];
      const totalSale = Math.floor(Math.random() * 60000) + 40000;
      const delivery = Math.floor(totalSale * (0.3 + Math.random() * 0.3));
      const onlineComm = Math.floor(delivery * 0.18);
      days[ds] = {
        effective_sale: totalSale - onlineComm,
        total_sale: totalSale,
        delivery,
        online_commission: onlineComm,
        rent: o.id === "sec23" ? 2667 : o.id === "sec31" ? 2333 : 2000,
        salary: o.id === "sec23" ? 4200 : o.id === "sec31" ? 7433 : 5000,
        raw_material: Math.floor(totalSale * (0.18 + Math.random() * 0.08)),
        vegetable: Math.floor(totalSale * (0.03 + Math.random() * 0.03)),
        dairy: Math.floor(totalSale * (0.01 + Math.random() * 0.02)),
        disposal: Math.floor(totalSale * (0.02 + Math.random() * 0.02)),
        gas: Math.floor(totalSale * (0.02 + Math.random() * 0.02)),
        electricity: Math.floor(Math.random() * 500) + 200,
        water_tanker: d % 7 === 0 ? 500 : 0,
        transport: Math.floor(Math.random() * 800) + 200,
        staff_room_rent: o.id === "sec23" ? 533 : o.id === "sec31" ? 617 : 0,
        staff_room_elec: Math.floor(Math.random() * 100),
        staff_welfare: Math.floor(Math.random() * 200),
        mala: 0, other: Math.floor(Math.random() * 300),
        maintenance: d % 10 === 0 ? Math.floor(Math.random() * 2000) : 0,
        new_purchase: 0, vendor_payments: 0,
        zomato_ads: Math.floor(Math.random() * 500),
        swiggy_ads: Math.floor(Math.random() * 500),
        gst: Math.floor(totalSale * 0.05),
        profit_tax: 0,
      };
    }
    data[o.id] = days;
  });
  return data;
};
const PNL_DATA = genPnlData();

// ─── DEMAND / STORE DATA ────────────────────────────────────────────────────
const DEMAND_SECTIONS = [
  { id: "prepared", titleHi: "Prepared Items (from BK)", emoji: "🍲", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A",
    items: [
      { id: "sambhar", name: "Sambhar", unit: "Kg" }, { id: "red_chutney", name: "Red Chutney", unit: "Kg" },
      { id: "dosa_batter", name: "Dosa Batter", unit: "Batch" }, { id: "idli_batter", name: "Idli Batter", unit: "Batch" },
      { id: "vada_batter", name: "Vada Batter", unit: "Batch" }, { id: "rava_mix", name: "Rava Mix", unit: "Kg" },
      { id: "onion_masala", name: "Onion Masala", unit: "Kg" }, { id: "upma_sooji", name: "Upma Sooji", unit: "gm" },
      { id: "garlic_paste", name: "Garlic Paste", unit: "gm" }, { id: "podi_masala", name: "Podi Masala", unit: "Kg" },
      { id: "sugar", name: "Sugar", unit: "Kg" }, { id: "poha", name: "Poha", unit: "gm" },
      { id: "besan", name: "Besan", unit: "Kg" }, { id: "kaju", name: "Kaju", unit: "gm" },
    ]},
  { id: "vegetable", titleHi: "Vegetable & Masala", emoji: "🥬", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0",
    items: [
      { id: "onions", name: "Onions", unit: "Kg" }, { id: "tomatoes", name: "Tomatoes", unit: "Kg" },
      { id: "green_chilli", name: "Green Chilli", unit: "gm" }, { id: "coriander", name: "Coriander Leaves", unit: "gm" },
      { id: "curry_leaves", name: "Curry Leaves", unit: "gm" }, { id: "ginger", name: "Ginger", unit: "gm" },
      { id: "coconut", name: "Coconut", unit: "Pcs" }, { id: "potato", name: "Potato", unit: "Kg" },
      { id: "garlic", name: "Garlic", unit: "gm" }, { id: "lemon", name: "Lemon", unit: "gm" },
      { id: "refined_oil", name: "Refined Oil", unit: "TN" }, { id: "desi_ghee", name: "Desi Ghee", unit: "TN" },
      { id: "chai_patti", name: "Chai Patti", unit: "Pkt" }, { id: "coffee_pow", name: "Coffee Powder", unit: "Pkt" },
    ]},
  { id: "disposal", titleHi: "Packaging / Disposal", emoji: "📦", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE",
    items: [
      { id: "250ml", name: "250ML Container", unit: "Pkt" }, { id: "500ml", name: "500ML Container", unit: "Pkt" },
      { id: "vada_lifafa", name: "Vada Lifafa", unit: "Pcs" }, { id: "dosa_box", name: "Dosa Box", unit: "Pkt" },
      { id: "bio_spoon", name: "Bio Spoon", unit: "Pkt" }, { id: "paper_bowl", name: "Paper Bowl", unit: "Pkt" },
      { id: "garbage_bag", name: "Garbage Bag", unit: "Bundle" }, { id: "printer_roll", name: "Printer Roll", unit: "Pcs" },
    ]},
  { id: "cleaning", titleHi: "Cleaning & Housekeeping", emoji: "🧹", color: "#9333EA", bg: "#FAF5FF", border: "#E9D5FF",
    items: [
      { id: "pochha", name: "Pochha", unit: "Pcs" }, { id: "jhadu", name: "Jhadu", unit: "Pcs" },
      { id: "sarf", name: "Sarf", unit: "Pkt" }, { id: "sabun", name: "Bartan Sabun", unit: "Pcs" },
    ]},
];

const CLOSING_STOCK = [
  { id: "cs_sambhar", name: "Sambhar", unit: "Kg" }, { id: "cs_chutney", name: "Chutney (all)", unit: "Kg" },
  { id: "cs_dosa_batter", name: "Dosa Batter", unit: "Kg" }, { id: "cs_idli_batter", name: "Idli Batter", unit: "Kg" },
  { id: "cs_vada_batter", name: "Vada Batter", unit: "Kg" }, { id: "cs_halwa", name: "Halwa", unit: "Kg" },
  { id: "cs_coffee", name: "Coffee Decoction", unit: "L" }, { id: "cs_oil", name: "Oil", unit: "L" },
  { id: "cs_ghee", name: "Ghee", unit: "Kg" },
];

// ─── STYLES ─────────────────────────────────────────────────────────────────
const FONT = <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />;
const PAGE = { minHeight: "100vh", background: "#FAFAF8", fontFamily: "'Outfit', sans-serif", color: "#1A1A1A" };
const cogsC = (p) => p <= 30 ? "#16A34A" : p <= 38 ? "#B45309" : "#DC2626";

// ─── SMALL COMPONENTS ───────────────────────────────────────────────────────
const BackBtn = ({ onClick }) => (
  <button onClick={onClick} style={{ width: 36, height: 36, borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", cursor: "pointer", fontSize: 17, display: "flex", alignItems: "center", justifyContent: "center", color: "#888", flexShrink: 0, fontFamily: "inherit" }}>←</button>
);

const PhotoUpload = ({ id: secId, emoji, titleHi, color, bg, border, image, onUpload, onRemove }) => {
  const uid = `cam-${secId}`;
  if (image) return (
    <div style={{ borderRadius: 14, overflow: "hidden", border: `2px solid ${color}`, position: "relative" }}>
      <img src={image} alt="" style={{ width: "100%", display: "block" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "28px 12px 10px", background: "linear-gradient(transparent, rgba(0,0,0,0.8))", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✅ {titleHi}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <label htmlFor={uid + "r"} style={{ padding: "5px 12px", borderRadius: 6, background: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>📷 Retake</label>
          <input id={uid + "r"} type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = (ev) => onUpload(ev.target.result); r.readAsDataURL(f); }}} style={{ display: "none" }} />
          <button onClick={onRemove} style={{ padding: "5px 12px", borderRadius: 6, background: "rgba(220,38,38,0.8)", border: "none", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>✕</button>
        </div>
      </div>
    </div>
  );
  return (
    <label htmlFor={uid} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 14, border: `2px dashed ${border}`, background: bg, cursor: "pointer" }}>
      <span style={{ fontSize: 32 }}>{emoji}</span>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>{titleHi}</span>
      <span style={{ padding: "8px 16px", borderRadius: 10, background: color, color: "#fff", fontSize: 12, fontWeight: 800 }}>📷 Photo</span>
      <input id={uid} type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = (ev) => onUpload(ev.target.result); r.readAsDataURL(f); }}} style={{ display: "none" }} />
    </label>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  DAILY P&L (matches user's Excel exactly)
// ═════════════════════════════════════════════════════════════════════════════
const DailyPnL = () => {
  const [selOutlet, setSelOutlet] = useState(null);
  const [selDay, setSelDay] = useState(0);

  const dateStr = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - selDay); return d.toISOString().split("T")[0];
  }, [selDay]);

  const outletIds = selOutlet ? [selOutlet] : OUTLETS.map((o) => o.id);
  const getData = (oid) => PNL_DATA[oid]?.[dateStr] || {};

  const totals = useMemo(() => {
    const t = {};
    [...PNL_REVENUE, ...ALL_EXPENSES].forEach((item) => {
      t[item.id] = outletIds.reduce((sum, oid) => sum + (getData(oid)[item.id] || 0), 0);
    });
    return t;
  }, [dateStr, selOutlet]);

  const totalExpense = ALL_EXPENSES.reduce((s, e) => s + (totals[e.id] || 0), 0);
  const netPnl = totals.effective_sale - totalExpense;
  const pnlPct = totals.effective_sale > 0 ? (netPnl / totals.effective_sale * 100) : 0;
  const rawPct = totals.effective_sale > 0 ? (totals.raw_material / totals.effective_sale * 100) : 0;
  const disposalPct = totals.effective_sale > 0 ? (totals.disposal / totals.effective_sale * 100) : 0;
  const gasPct = totals.effective_sale > 0 ? (totals.gas / totals.effective_sale * 100) : 0;
  const elecPct = totals.effective_sale > 0 ? (totals.electricity / totals.effective_sale * 100) : 0;

  const Row = ({ label, value, bold, color, bg, sub, negative }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: bg || "transparent", borderBottom: "1px solid #F0F0EC" }}>
      <span style={{ fontSize: 13, fontWeight: bold ? 700 : 400, color: color || "#1A1A1A" }}>{label}</span>
      <div style={{ textAlign: "right" }}>
        <span style={{ fontSize: 14, fontWeight: bold ? 800 : 600, fontFamily: "'JetBrains Mono', monospace", color: negative ? "#DC2626" : (color || "#1A1A1A") }}>
          {negative ? "-" : ""}{fmt(Math.abs(value || 0))}
        </span>
        {sub && <div style={{ fontSize: 10, color: "#999" }}>{sub}</div>}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {Array.from({ length: 10 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - i);
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toISOString().split("T")[0].slice(5);
          return (<button key={i} onClick={() => setSelDay(i)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selDay === i ? 700 : 500, border: selDay === i ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selDay === i ? "#1A1A1A" : "#fff", color: selDay === i ? "#fff" : "#888", whiteSpace: "nowrap" }}>{label}</button>);
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        <button onClick={() => setSelOutlet(null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: !selOutlet ? 700 : 500, border: !selOutlet ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selOutlet ? "#1A1A1A" : "#fff", color: !selOutlet ? "#fff" : "#888" }}>All Outlets</button>
        {OUTLETS.map((o) => (<button key={o.id} onClick={() => setSelOutlet(o.id)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selOutlet === o.id ? 700 : 500, border: selOutlet === o.id ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selOutlet === o.id ? "#1A1A1A" : "#fff", color: selOutlet === o.id ? "#fff" : "#888" }}>{o.short}</button>))}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {[{ l: "Effective Sale", v: fmt(totals.effective_sale), c: "#166534" }, { l: "Net P&L", v: (netPnl >= 0 ? "" : "-") + fmt(Math.abs(netPnl)), c: netPnl >= 0 ? "#16A34A" : "#DC2626" }, { l: "P&L %", v: pct(pnlPct), c: pnlPct >= 0 ? "#16A34A" : "#DC2626" }].map((s, i) => (
          <div key={i} style={{ flex: "1 1 120px", background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{s.l}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.c, fontFamily: "'JetBrains Mono', monospace" }}>{s.v}</div>
          </div>
        ))}
      </div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 20 }}>
        <div style={{ padding: "10px 16px", background: "#F0FDF4", borderBottom: "1px solid #BBF7D0", fontSize: 12, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: 0.6 }}>Revenue</div>
        {PNL_REVENUE.map((r) => <Row key={r.id} label={r.label} value={totals[r.id]} bold color={r.color} bg={r.bg} negative={r.negative} />)}
        <div style={{ padding: "10px 16px", background: "#FEF2F2", borderBottom: "1px solid #FECACA", fontSize: 12, fontWeight: 700, color: "#991B1B", textTransform: "uppercase", letterSpacing: 0.6 }}>Fixed Expenses</div>
        {PNL_FIXED_EXPENSES.map((e) => <Row key={e.id} label={e.label} value={totals[e.id]} />)}
        <div style={{ padding: "10px 16px", background: "#FFFBEB", borderBottom: "1px solid #FDE68A", fontSize: 12, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: 0.6 }}>Variable / COGS Expenses</div>
        {PNL_VARIABLE_EXPENSES.map((e) => { const val = totals[e.id] || 0; const p = totals.effective_sale > 0 ? (val / totals.effective_sale * 100) : 0; return <Row key={e.id} label={e.label} value={val} bg={e.highlight ? "#FFFDF5" : undefined} sub={e.highlight ? `${pct(p)} of sale` : undefined} />; })}
        <div style={{ padding: "10px 16px", background: "#F8F8F5", borderBottom: "1px solid #E8E8E4", fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 0.6 }}>Other Expenses</div>
        {PNL_OTHER_EXPENSES.map((e) => <Row key={e.id} label={e.label} value={totals[e.id]} />)}
        <div style={{ borderTop: "2px solid #1A1A1A" }}>
          <Row label="Net Expense" value={totalExpense} bold bg="#F8F8F5" />
          <Row label="Net P&L" value={Math.abs(netPnl)} bold color={netPnl >= 0 ? "#16A34A" : "#DC2626"} bg={netPnl >= 0 ? "#F0FDF4" : "#FEF2F2"} negative={netPnl < 0} />
        </div>
      </div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", background: "#F8F8F5", borderBottom: "1px solid #E8E8E4", fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 0.6 }}>Cost % of Effective Sale</div>
        {[{ l: "Raw Material", v: rawPct, t: 25 }, { l: "Disposal", v: disposalPct, t: 4 }, { l: "Gas", v: gasPct, t: 4 }, { l: "Electricity", v: elecPct, t: 3 }].map((item) => (
          <div key={item.l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #F0F0EC" }}>
            <span style={{ fontSize: 13 }}>{item.l}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 80, height: 6, borderRadius: 3, background: "#EBEBEB", overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 3, background: item.v > item.t ? "#DC2626" : "#16A34A", width: `${Math.min(item.v * 2, 100)}%` }} /></div>
              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: item.v > item.t ? "#DC2626" : "#16A34A", width: 50, textAlign: "right" }}>{pct(item.v)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── BK Items & Recipes (for Base Kitchen & Dispatch) ────────────────────────
const BK_ITEMS = [
  { id: "sambhar", name: "Sambhar", unit: "L" }, { id: "idli_batter", name: "Idli/Dosa Batter", unit: "Kg" },
  { id: "coconut_chutney", name: "Coconut Chutney", unit: "Kg" }, { id: "tomato_chutney", name: "Tomato Chutney", unit: "Kg" },
  { id: "peanut_chutney", name: "Peanut Chutney", unit: "Kg" }, { id: "halwa_mix", name: "Sooji Halwa", unit: "Kg" },
  { id: "medu_vada_mix", name: "Medu Vada Mix", unit: "Kg" }, { id: "upma_mix", name: "Upma Premix", unit: "Kg" },
  { id: "poha_mix", name: "Poha Premix", unit: "Kg" }, { id: "coffee_decoction", name: "Coffee Decoction", unit: "L" },
];
const RAW_MATERIALS = [
  { id: "urad_dal", name: "Urad Dal", unit: "Kg" }, { id: "rice", name: "Idli Rice", unit: "Kg" },
  { id: "toor_dal", name: "Toor Dal", unit: "Kg" }, { id: "coconut", name: "Coconut (Fresh)", unit: "Pcs" },
  { id: "tomato", name: "Tomato", unit: "Kg" }, { id: "peanuts", name: "Peanuts", unit: "Kg" },
  { id: "sooji", name: "Sooji (Rava)", unit: "Kg" }, { id: "sugar_raw", name: "Sugar", unit: "Kg" },
  { id: "ghee", name: "Ghee", unit: "L" }, { id: "oil", name: "Oil (Refined)", unit: "L" },
  { id: "mustard", name: "Mustard Seeds", unit: "Kg" }, { id: "curry_leaves_raw", name: "Curry Leaves", unit: "Bunch" },
  { id: "coffee_powder_raw", name: "Coffee Powder", unit: "Kg" }, { id: "poha_raw_mat", name: "Poha", unit: "Kg" },
  { id: "onion_raw", name: "Onion", unit: "Kg" }, { id: "green_chilli_raw", name: "Green Chilli", unit: "Kg" },
  { id: "tamarind", name: "Tamarind", unit: "Kg" }, { id: "salt_raw", name: "Salt", unit: "Kg" },
];
const RECIPES = {
  sambhar: { name: "Sambhar", yield: "10 L", yieldQty: 10, ingredients: [{ rawId: "toor_dal", qty: 2 }, { rawId: "tomato", qty: 1.5 }, { rawId: "onion_raw", qty: 1 }, { rawId: "tamarind", qty: 0.15 }, { rawId: "oil", qty: 0.3 }, { rawId: "mustard", qty: 0.05 }, { rawId: "curry_leaves_raw", qty: 2 }, { rawId: "salt_raw", qty: 0.15 }] },
  idli_batter: { name: "Idli/Dosa Batter", yield: "10 Kg", yieldQty: 10, ingredients: [{ rawId: "urad_dal", qty: 2.5 }, { rawId: "rice", qty: 7 }, { rawId: "salt_raw", qty: 0.1 }] },
  coconut_chutney: { name: "Coconut Chutney", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "coconut", qty: 10 }, { rawId: "green_chilli_raw", qty: 0.1 }, { rawId: "mustard", qty: 0.02 }, { rawId: "curry_leaves_raw", qty: 1 }, { rawId: "oil", qty: 0.05 }, { rawId: "salt_raw", qty: 0.05 }] },
  tomato_chutney: { name: "Tomato Chutney", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "tomato", qty: 3 }, { rawId: "peanuts", qty: 0.5 }, { rawId: "onion_raw", qty: 0.5 }, { rawId: "oil", qty: 0.15 }, { rawId: "salt_raw", qty: 0.05 }] },
  peanut_chutney: { name: "Peanut Chutney", yield: "3 Kg", yieldQty: 3, ingredients: [{ rawId: "peanuts", qty: 1.5 }, { rawId: "green_chilli_raw", qty: 0.05 }, { rawId: "salt_raw", qty: 0.03 }, { rawId: "oil", qty: 0.05 }] },
  halwa_mix: { name: "Sooji Halwa", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "sooji", qty: 2 }, { rawId: "sugar_raw", qty: 1.5 }, { rawId: "ghee", qty: 0.8 }] },
  medu_vada_mix: { name: "Medu Vada Mix", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "urad_dal", qty: 4.5 }, { rawId: "green_chilli_raw", qty: 0.1 }, { rawId: "curry_leaves_raw", qty: 1 }, { rawId: "salt_raw", qty: 0.08 }] },
  upma_mix: { name: "Upma Premix", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "sooji", qty: 3.5 }, { rawId: "mustard", qty: 0.03 }, { rawId: "curry_leaves_raw", qty: 1 }, { rawId: "onion_raw", qty: 0.5 }, { rawId: "oil", qty: 0.2 }, { rawId: "salt_raw", qty: 0.08 }] },
  poha_mix: { name: "Poha Premix", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "poha_raw_mat", qty: 3 }, { rawId: "onion_raw", qty: 0.8 }, { rawId: "peanuts", qty: 0.3 }, { rawId: "green_chilli_raw", qty: 0.05 }, { rawId: "mustard", qty: 0.02 }, { rawId: "curry_leaves_raw", qty: 1 }, { rawId: "oil", qty: 0.15 }, { rawId: "salt_raw", qty: 0.05 }] },
  coffee_decoction: { name: "Coffee Decoction", yield: "5 L", yieldQty: 5, ingredients: [{ rawId: "coffee_powder_raw", qty: 1.5 }] },
};
const getBk = (id) => BK_ITEMS.find((b) => b.id === id)?.name || id;

// ─── Table styles ───────────────────────────────────────────────────────────
const thS = { padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, borderBottom: "1px solid #E8E8E4" };
const tdS = { padding: "10px 14px" };

// ─── Print helper ───────────────────────────────────────────────────────────
const printSection = (sectionId, title) => {
  const el = document.getElementById(sectionId); if (!el) return;
  const pw = window.open("", "_blank");
  const ds = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
  pw.document.write(`<!DOCTYPE html><html><head><title>${title}</title><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" /><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Outfit',sans-serif;color:#1A1A1A;padding:24px;background:#fff}.print-header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #1A1A1A;padding-bottom:12px;margin-bottom:20px}.print-header h1{font-size:18px;font-weight:800}.print-header span{font-size:12px;color:#888}table{width:100%;border-collapse:collapse;font-size:12px}th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;border-bottom:2px solid #DDD;background:#F8F8F5}td{padding:8px 10px;border-bottom:1px solid #EEE}.no-print,button,input{display:none!important}@media print{body{padding:0}}</style></head><body><div class="print-header"><h1>Ananda Cafe — ${title}</h1><span>${ds}</span></div>${el.innerHTML}</body></html>`);
  pw.document.close(); setTimeout(() => { pw.focus(); pw.print(); }, 400);
};
const PrintBtn = ({ sectionId, title }) => (
  <button className="no-print" onClick={() => printSection(sectionId, title)} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 12, fontWeight: 600, color: "#777", cursor: "pointer", fontFamily: "inherit" }}>🖨️ Print</button>
);

// ─── Generate sample orders ─────────────────────────────────────────────────
const generateOrders = () => {
  const all = [];
  for (let d = 0; d < 7; d++) {
    const dt = new Date(); dt.setDate(dt.getDate() - d); const ds = dt.toISOString().split("T")[0];
    OUTLETS.forEach((o) => {
      const items = {}; BK_ITEMS.forEach((bk) => { items[bk.id] = Math.floor(Math.random() * 8) + 3; });
      all.push({ id: `ORD-${ds}-${o.id}`, date: ds, outlet: o.id, status: d === 0 ? "pending" : "dispatched", items });
    });
  }
  return all;
};

// ═════════════════════════════════════════════════════════════════════════════
//  OUTLET ORDERS (BK ordering challan)
// ═════════════════════════════════════════════════════════════════════════════
const OutletOrders = ({ orders, setOrders }) => {
  const [selO, setSelO] = useState("sec23");
  const [draft, setDraft] = useState({});
  const todayStr = today();
  const existing = orders.find((o) => o.outlet === selO && o.date === todayStr);
  const submit = () => { const o = { id: `ORD-${todayStr}-${selO}`, date: todayStr, outlet: selO, status: "pending", items: { ...draft } }; setOrders((p) => [...p.filter((x) => x.id !== o.id), o]); setDraft({}); };
  return (
    <div id="print-orders">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Outlet Daily Order Challan</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>Fill at closing time for next day's BK requirements</p></div>
        <PrintBtn sectionId="print-orders" title={`Order Challan — ${OUTLETS.find((o) => o.id === selO)?.name}`} />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>{OUTLETS.map((o) => (<button key={o.id} onClick={() => { setSelO(o.id); setDraft({}); }} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", border: selO === o.id ? "none" : "1px solid #E0E0DC", background: selO === o.id ? "#1A1A1A" : "#fff", color: selO === o.id ? "#fff" : "#666", fontFamily: "inherit" }}>{o.name}</button>))}</div>
      {existing ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}><span style={{ padding: "3px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>SUBMITTED</span><span style={{ fontSize: 12, color: "#999" }}>{todayStr}</span></div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>Item</th><th style={thS}>Qty</th><th style={thS}>Unit</th></tr></thead>
          <tbody>{Object.entries(existing.items).filter(([, q]) => q > 0).map(([id, qty]) => { const bk = BK_ITEMS.find((b) => b.id === id); return (<tr key={id} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={tdS}>{bk?.name || id}</td><td style={{ ...tdS, textAlign: "center", fontWeight: 700 }}>{qty}</td><td style={{ ...tdS, textAlign: "center", color: "#999" }}>{bk?.unit}</td></tr>); })}</tbody></table>
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "18px 20px" }}>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 14 }}>Order for <strong style={{ color: "#1A1A1A" }}>{OUTLETS.find((o) => o.id === selO)?.name}</strong> — {todayStr}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>{BK_ITEMS.map((bk) => (<div key={bk.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#FAFAF8", borderRadius: 8, padding: "8px 12px" }}><span style={{ flex: 1, fontSize: 13 }}>{bk.name}</span><input type="number" min="0" placeholder="0" value={draft[bk.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [bk.id]: Math.max(0, Number(e.target.value) || 0) }))} style={{ width: 56, padding: "5px 6px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, textAlign: "center", fontFamily: "inherit" }} /><span style={{ fontSize: 11, color: "#999", width: 22 }}>{bk.unit}</span></div>))}</div>
          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}><button onClick={submit} disabled={Object.values(draft).every((v) => !v)} style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#1A1A1A", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", opacity: Object.values(draft).every((v) => !v) ? 0.3 : 1 }}>✅ Submit Challan</button></div>
        </div>
      )}
      <div style={{ marginTop: 24 }}><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Recent Orders</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #E8E8E4" }}><thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>Date</th><th style={thS}>Status</th><th style={thS}>Items</th></tr></thead>
        <tbody>{orders.filter((o) => o.outlet === selO).slice(0, 7).map((o) => (<tr key={o.id} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={tdS}>{o.date}</td><td style={tdS}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: o.status === "dispatched" ? "#F0FDF4" : "#FFFBEB", color: o.status === "dispatched" ? "#16A34A" : "#B45309" }}>{o.status.toUpperCase()}</span></td><td style={{ ...tdS, color: "#888" }}>{Object.values(o.items).reduce((s, q) => s + q, 0)} total</td></tr>))}</tbody></table>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  BASE KITCHEN (Consolidated Challan + Raw Material Requisition)
// ═════════════════════════════════════════════════════════════════════════════
const BaseKitchen = ({ orders }) => {
  const todayStr = today();
  const todayOrders = orders.filter((o) => o.date === todayStr);
  const consolidated = {}; BK_ITEMS.forEach((bk) => { consolidated[bk.id] = { total: 0, by: {} }; todayOrders.forEach((o) => { const q = o.items[bk.id] || 0; consolidated[bk.id].total += q; consolidated[bk.id].by[o.outlet] = q; }); });
  const rawReq = {}; Object.entries(consolidated).forEach(([bkId, data]) => { const recipe = RECIPES[bkId]; if (!recipe || data.total === 0) return; const batches = data.total / recipe.yieldQty; recipe.ingredients.forEach((ing) => { rawReq[ing.rawId] = (rawReq[ing.rawId] || 0) + ing.qty * batches; }); });
  return (
    <div id="print-kitchen">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Base Kitchen — Consolidated Challan</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>{todayOrders.length} outlet orders received for {todayStr}</p></div>
        <PrintBtn sectionId="print-kitchen" title="BK Consolidated Challan" />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>{[{ l: "Orders", v: todayOrders.length, s: `of ${OUTLETS.length}` }, { l: "BK Items", v: Object.values(consolidated).filter((c) => c.total > 0).length }, { l: "Raw Materials", v: Object.keys(rawReq).length }].map((s, i) => (<div key={i} style={{ flex: 1, background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4", textAlign: "center" }}><div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{s.l}</div><div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{s.v}</div>{s.s && <div style={{ fontSize: 11, color: "#BBB" }}>{s.s}</div>}</div>))}</div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 20 }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #E8E8E4", fontWeight: 700, fontSize: 14 }}>📋 Consolidated Demand</div>
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}><thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>Item</th><th style={thS}>Unit</th>{OUTLETS.map((o) => <th key={o.id} style={thS}>{o.short}</th>)}<th style={{ ...thS, color: "#1A1A1A" }}>TOTAL</th></tr></thead>
        <tbody>{BK_ITEMS.filter((bk) => consolidated[bk.id]?.total > 0).map((bk) => { const d = consolidated[bk.id]; return (<tr key={bk.id} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={{ ...tdS, fontWeight: 600 }}>{bk.name}</td><td style={{ ...tdS, color: "#999" }}>{bk.unit}</td>{OUTLETS.map((o) => <td key={o.id} style={{ ...tdS, textAlign: "center", color: d.by[o.id] ? "#1A1A1A" : "#DDD" }}>{d.by[o.id] || "—"}</td>)}<td style={{ ...tdS, textAlign: "center", fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{d.total}</td></tr>); })}</tbody></table></div>
      </div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #E8E8E4" }}><div style={{ fontWeight: 700, fontSize: 14 }}>🏪 Ration Store — Raw Material Requisition</div><div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>Auto-calculated from standard recipes</div></div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>Raw Material</th><th style={thS}>Required</th><th style={thS}>Unit</th></tr></thead>
        <tbody>{Object.entries(rawReq).sort((a, b) => b[1] - a[1]).map(([id, qty]) => { const raw = RAW_MATERIALS.find((r) => r.id === id); return (<tr key={id} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={{ ...tdS, fontWeight: 600 }}>{raw?.name || id}</td><td style={{ ...tdS, textAlign: "center", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{qty.toFixed(2)}</td><td style={{ ...tdS, textAlign: "center", color: "#999" }}>{raw?.unit}</td></tr>); })}</tbody></table>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  DISPATCH
// ═════════════════════════════════════════════════════════════════════════════
const Dispatch = ({ orders, setOrders }) => {
  const todayStr = today();
  const pending = orders.filter((o) => o.date === todayStr && o.status === "pending");
  const done = orders.filter((o) => o.date === todayStr && o.status === "dispatched");
  const [dq, setDq] = useState({});
  const doDispatch = (id) => { setOrders((p) => p.map((o) => o.id === id ? { ...o, status: "dispatched", dispatchTime: new Date().toLocaleTimeString() } : o)); };
  return (
    <div id="print-dispatch">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Dispatch Challan</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>Verify and dispatch prepared items to outlets</p></div>
        <PrintBtn sectionId="print-dispatch" title="Dispatch Challan" />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1, background: "#FFFBEB", borderRadius: 12, padding: "14px 16px", border: "1px solid #FDE68A", textAlign: "center" }}><div style={{ fontSize: 10, color: "#92400E", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Pending</div><div style={{ fontSize: 24, fontWeight: 800, color: "#B45309" }}>{pending.length}</div></div>
        <div style={{ flex: 1, background: "#F0FDF4", borderRadius: 12, padding: "14px 16px", border: "1px solid #BBF7D0", textAlign: "center" }}><div style={{ fontSize: 10, color: "#166534", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Dispatched</div><div style={{ fontSize: 24, fontWeight: 800, color: "#16A34A" }}>{done.length}</div></div>
      </div>
      {pending.length === 0 && <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "40px 20px", textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 8 }}>✓</div><div style={{ color: "#999" }}>All dispatched for today</div></div>}
      {pending.map((order) => { const outlet = OUTLETS.find((o) => o.id === order.outlet); return (
        <div key={order.id} style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "18px 20px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><strong style={{ fontSize: 15 }}>{outlet?.name}</strong><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#FFFBEB", color: "#B45309" }}>PENDING</span></div><span style={{ fontSize: 11, color: "#BBB" }}>{order.id}</span></div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>Item</th><th style={thS}>Ordered</th><th style={thS}>Dispatching</th><th style={thS}>Diff</th></tr></thead>
          <tbody>{Object.entries(order.items).filter(([, q]) => q > 0).map(([id, qty]) => { const dqty = dq[order.id]?.[id] ?? qty; const diff = dqty - qty; return (<tr key={id} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={tdS}>{getBk(id)}</td><td style={{ ...tdS, textAlign: "center" }}>{qty}</td><td style={{ ...tdS, textAlign: "center" }}><input type="number" value={dqty} onChange={(e) => setDq((p) => ({ ...p, [order.id]: { ...(p[order.id] || order.items), [id]: Number(e.target.value) } }))} style={{ width: 56, padding: "4px 6px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 13, textAlign: "center", fontFamily: "inherit" }} /></td><td style={{ ...tdS, textAlign: "center", fontWeight: 700, color: diff === 0 ? "#16A34A" : diff < 0 ? "#DC2626" : "#B45309" }}>{diff === 0 ? "✓" : diff > 0 ? `+${diff}` : diff}</td></tr>); })}</tbody></table>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}><button onClick={() => doDispatch(order.id)} style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#16A34A", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>✅ Dispatch</button></div>
        </div>
      ); })}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  RECIPES
// ═════════════════════════════════════════════════════════════════════════════
const RecipesPanel = () => {
  const [sel, setSel] = useState("sambhar");
  const recipe = RECIPES[sel];
  return (
    <div id="print-recipes">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Recipe Management</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>Standard recipes for raw material calculations and audit</p></div>
        <PrintBtn sectionId="print-recipes" title={`Recipe — ${recipe.name}`} />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>{Object.keys(RECIPES).map((k) => (<button key={k} onClick={() => setSel(k)} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: sel === k ? "none" : "1px solid #E0E0DC", background: sel === k ? "#1A1A1A" : "#fff", color: sel === k ? "#fff" : "#666", fontFamily: "inherit" }}>{RECIPES[k].name}</button>))}</div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><div><h4 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{recipe.name}</h4><span style={{ fontSize: 13, color: "#888" }}>Yield: <strong style={{ color: "#B45309" }}>{recipe.yield}</strong></span></div><span style={{ padding: "3px 10px", borderRadius: 6, background: "#EFF6FF", color: "#2563EB", fontSize: 11, fontWeight: 700 }}>STANDARD</span></div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>Raw Material</th><th style={thS}>Qty / Batch</th><th style={thS}>Unit</th></tr></thead>
        <tbody>{recipe.ingredients.map((ing) => { const raw = RAW_MATERIALS.find((r) => r.id === ing.rawId); return (<tr key={ing.rawId} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={{ ...tdS, fontWeight: 600 }}>{raw?.name || ing.rawId}</td><td style={{ ...tdS, textAlign: "center", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{ing.qty}</td><td style={{ ...tdS, textAlign: "center", color: "#999" }}>{raw?.unit}</td></tr>); })}</tbody></table>
        <div style={{ marginTop: 14, padding: "10px 14px", background: "#FAFAF8", borderRadius: 8, fontSize: 12, color: "#888" }}>Updating recipes recalculates all audit variances and raw material requisitions automatically.</div>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  COGS DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
const ITEM_COST = { idli: 18, dosa: 20, masala_dosa: 28, medu_vada: 22, upma: 16, poha: 15, set_dosa: 24, sambhar_vada: 25, halwa: 14, filter_coffee: 8, rava_dosa: 26, uttapam: 23 };
const MENU_ITEMS = [
  { id: "idli", name: "Idli (2pc)", price: { d: 60, a: 79 } }, { id: "dosa", name: "Plain Dosa", price: { d: 70, a: 99 } },
  { id: "masala_dosa", name: "Masala Dosa", price: { d: 100, a: 139 } }, { id: "medu_vada", name: "Medu Vada", price: { d: 70, a: 89 } },
  { id: "upma", name: "Upma", price: { d: 60, a: 79 } }, { id: "poha", name: "Poha", price: { d: 60, a: 79 } },
  { id: "set_dosa", name: "Set Dosa", price: { d: 90, a: 119 } }, { id: "sambhar_vada", name: "Sambhar Vada", price: { d: 80, a: 99 } },
  { id: "halwa", name: "Halwa", price: { d: 40, a: 59 } }, { id: "filter_coffee", name: "Filter Coffee", price: { d: 30, a: 49 } },
  { id: "rava_dosa", name: "Rava Dosa", price: { d: 90, a: 119 } }, { id: "uttapam", name: "Uttapam", price: { d: 80, a: 109 } },
];
const genSales = () => { const d = {}; OUTLETS.forEach((o) => { const it = {}; MENU_ITEMS.forEach((m) => { it[m.id] = { d: Math.floor(Math.random() * 25) + 5, a: Math.floor(Math.random() * 18) + 3 }; }); d[o.id] = it; }); return d; };
const SALES = genSales();
const compOutlet = (oid) => { const s = SALES[oid]; let tR = { d: 0, a: 0 }, tC = { d: 0, a: 0 }; const items = []; MENU_ITEMS.forEach((m) => { const q = s[m.id], c = ITEM_COST[m.id]; const dr = q.d * m.price.d, ar = q.a * m.price.a, dc = q.d * c, ac = q.a * c; tR.d += dr; tR.a += ar; tC.d += dc; tC.a += ac; items.push({ id: m.id, name: m.name, dI: { q: q.d, r: dr, c: dc, cogs: dr > 0 ? dc / dr * 100 : 0 }, ag: { q: q.a, r: ar, c: ac, cogs: ar > 0 ? ac / ar * 100 : 0 }, t: { q: q.d + q.a, r: dr + ar, c: dc + ac, cogs: (dr + ar) > 0 ? (dc + ac) / (dr + ar) * 100 : 0 } }); }); const tRev = tR.d + tR.a, tCost = tC.d + tC.a; return { rev: tR, cost: tC, tRev, tCost, cogs: tRev > 0 ? tCost / tRev * 100 : 0, cogsDi: tR.d > 0 ? tC.d / tR.d * 100 : 0, cogsAg: tR.a > 0 ? tC.a / tR.a * 100 : 0, items: items.sort((a, b) => b.t.r - a.t.r) }; };

const CogsDash = () => {
  const [sel, setSel] = useState(null);
  const all = useMemo(() => { const m = {}; OUTLETS.forEach((o) => { m[o.id] = compOutlet(o.id); }); return m; }, []);
  const grand = useMemo(() => { let r = 0, c = 0; Object.values(all).forEach((m) => { r += m.tRev; c += m.tCost; }); return { r, c, cogs: r > 0 ? c / r * 100 : 0 }; }, [all]);
  if (sel) { const sm = all[sel], so = OUTLETS.find((o) => o.id === sel); return (<div>
    <button onClick={() => setSel(null)} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #E0E0DC", background: "#fff", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, color: "#666", cursor: "pointer", marginBottom: 16, fontFamily: "inherit" }}>← All Outlets</button>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}><h3 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>{so.name}</h3><div style={{ marginLeft: "auto", fontSize: 26, fontWeight: 800, color: cogsC(sm.cogs), fontFamily: "'JetBrains Mono'" }}>{pct(sm.cogs)}</div></div>
    <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>{[{ l: "Dine-In", cogs: sm.cogsDi, r: sm.rev.d }, { l: "Swiggy/Zomato", cogs: sm.cogsAg, r: sm.rev.a }].map((ch) => (<div key={ch.l} style={{ flex: 1, background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4" }}><div style={{ fontSize: 12, fontWeight: 600, color: "#888", marginBottom: 8 }}>{ch.l}</div><div style={{ display: "flex", justifyContent: "space-between" }}><div><div style={{ fontSize: 10, color: "#BBB" }}>Revenue</div><div style={{ fontSize: 14, fontWeight: 700, fontFamily: "mono" }}>{fmt(ch.r)}</div></div><div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "#BBB" }}>COGS</div><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: cogsC(ch.cogs) }}>{pct(ch.cogs)}</div></div></div></div>))}</div>
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", padding: "8px 14px", background: "#FAFAF8", borderBottom: "1px solid #E8E8E4", fontSize: 10, fontWeight: 700, color: "#999", textTransform: "uppercase" }}><div>Item</div><div style={{ textAlign: "center" }}>Qty</div><div style={{ textAlign: "center" }}>Dine-In</div><div style={{ textAlign: "center" }}>Aggr.</div><div style={{ textAlign: "center" }}>COGS%</div></div>
      {sm.items.map((it) => (<div key={it.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", padding: "9px 14px", borderBottom: "1px solid #F0F0EC", background: it.t.cogs > 38 ? "#FEF2F2" : "transparent", fontSize: 12.5 }}><div style={{ fontWeight: 600 }}>{it.t.cogs > 38 && "⚑ "}{it.name}</div><div style={{ textAlign: "center", color: "#888", fontFamily: "mono" }}>{it.t.q}</div><div style={{ textAlign: "center", fontFamily: "'JetBrains Mono'", fontWeight: 600, color: cogsC(it.dI.cogs) }}>{it.dI.q > 0 ? pct(it.dI.cogs) : "—"}</div><div style={{ textAlign: "center", fontFamily: "'JetBrains Mono'", fontWeight: 600, color: cogsC(it.ag.cogs) }}>{it.ag.q > 0 ? pct(it.ag.cogs) : "—"}</div><div style={{ textAlign: "center", fontFamily: "'JetBrains Mono'", fontWeight: 700, fontSize: 13, color: cogsC(it.t.cogs) }}>{pct(it.t.cogs)}</div></div>))}
    </div>
  </div>); }
  return (<div>
    <div style={{ display: "flex", gap: 1, borderRadius: 12, overflow: "hidden", marginBottom: 20, background: "#E8E8E4" }}>{[{ l: "Revenue", v: fmt(grand.r) }, { l: "Food Cost", v: fmt(grand.c), c: cogsC(grand.cogs) }, { l: "COGS %", v: pct(grand.cogs), c: cogsC(grand.cogs) }].map((s, i) => (<div key={i} style={{ flex: 1, background: "#fff", padding: "14px", textAlign: "center" }}><div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{s.l}</div><div style={{ fontSize: 22, fontWeight: 800, color: s.c || "#1A1A1A", fontFamily: "'JetBrains Mono'" }}>{s.v}</div></div>))}</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{OUTLETS.map((o) => { const m = all[o.id], c = cogsC(m.cogs); return (<div key={o.id} onClick={() => setSel(o.id)} style={{ background: "#fff", borderRadius: 14, padding: "18px 20px", border: "1px solid #E8E8E4", cursor: "pointer", position: "relative" }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{o.name}</div><div style={{ fontSize: 24, fontWeight: 800, color: c, fontFamily: "'JetBrains Mono'", lineHeight: 1 }}>{pct(m.cogs)}</div></div><div style={{ height: 5, borderRadius: 3, background: "#EBEBEB", marginBottom: 12, overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 3, background: c, width: `${Math.min(m.cogs * 2, 100)}%` }} /></div><div style={{ display: "flex", gap: 8 }}><div style={{ flex: 1, background: "#F8F8F5", borderRadius: 8, padding: "5px 8px" }}><div style={{ fontSize: 9, color: "#999", fontWeight: 600 }}>DINE-IN</div><div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono'", color: cogsC(m.cogsDi) }}>{pct(m.cogsDi)}</div></div><div style={{ flex: 1, background: "#F8F8F5", borderRadius: 8, padding: "5px 8px" }}><div style={{ fontSize: 9, color: "#999", fontWeight: 600 }}>AGGREGATOR</div><div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono'", color: cogsC(m.cogsAg) }}>{pct(m.cogsAg)}</div></div></div><div style={{ position: "absolute", bottom: 6, right: 14, fontSize: 11, color: "#CCC" }}>details →</div></div>); })}</div>
  </div>);
};

// ═════════════════════════════════════════════════════════════════════════════
//  OUTLET MANAGER
// ═════════════════════════════════════════════════════════════════════════════
const OutletMgr = ({ onBack }) => {
  const [outlet, setOutlet] = useState(null); const [screen, setScreen] = useState("pick"); const [images, setImages] = useState({}); const [draft, setDraft] = useState({}); const [closing, setClosing] = useState({}); const [expSec, setExpSec] = useState(null); const [note, setNote] = useState(""); const [subs, setSubs] = useState([]); const [last, setLast] = useState(null); const [saving, setSaving] = useState(false); const [err, setErr] = useState(null);
  const oData = OUTLETS.find((o) => o.id === outlet); const tSubs = subs.filter((s) => s.outlet === outlet && s.date === today()); const reset = () => { setImages({}); setDraft({}); setNote(""); setExpSec(null); setErr(null); };

  const submit = async (type) => {
    setSaving(true); setErr(null);
    try {
      if (type === "closing") {
        const result = await api.submitClosingStock({ outlet_id: outlet, items: closing });
        const e = { ...result, type: "closing", outlet, time: timeNow(), date: today() };
        setSubs((p) => [e, ...p]); setLast(e);
      } else {
        // Create demand record
        const result = await api.createDemand({ outlet_id: outlet, type, items: type === "manual" ? draft : {}, note });
        // Upload photos if photo mode
        if (type === "photo") {
          for (const [section, base64] of Object.entries(images)) {
            if (base64) await api.uploadDemandPhoto(result.id, section, base64);
          }
        }
        const e = { ...result, type, outlet, images: type === "photo" ? { ...images } : {}, time: timeNow(), date: today() };
        setSubs((p) => [e, ...p]); setLast(e);
      }
      reset(); setClosing({}); setScreen("done");
    } catch (error) {
      setErr(error.message || "Failed to submit. Check internet connection.");
    } finally { setSaving(false); }
  };

  const waMsg = (e) => { let m = `📋 *Ananda Cafe — ${e.type === "closing" ? "Closing Stock" : "Demand"}*\n🏪 ${oData?.name}\n📅 ${e.date} | ⏰ ${e.time}\n`; if (e.type === "photo") m += `📷 ${Object.keys(e.images || {}).length} photos\n`; if (e.note) m += `📝 ${e.note}\n`; m += `✅ Sent via App`; window.open(`https://wa.me/?text=${encodeURIComponent(m)}`, "_blank"); };
  const ErrBar = () => err ? <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>❌ {err}</div> : null;
  const SavingOverlay = () => saving ? <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}><div style={{ background: "#fff", borderRadius: 16, padding: "24px 32px", textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div><div style={{ fontSize: 15, fontWeight: 700 }}>Submitting...</div><div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>Please wait</div></div></div> : null;

  if (screen === "pick") return (<div><div style={{ textAlign: "center", marginBottom: 30 }}><div style={{ fontSize: 40, marginBottom: 6 }}>🍽️</div><h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Select Outlet</h2></div>{OUTLETS.map((o) => (<button key={o.id} onClick={() => { setOutlet(o.id); setScreen("home"); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 14, border: "1px solid #E8E8E4", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 12, marginBottom: 8, color: "#1A1A1A" }}><span style={{ fontSize: 24 }}>🏪</span><span style={{ flex: 1 }}>{o.name}</span><span style={{ color: "#CCC" }}>→</span></button>))}<button onClick={onBack} style={{ width: "100%", marginTop: 12, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button></div>);

  if (screen === "done" && last) return (<div style={{ textAlign: "center", padding: "40px 0" }}><div style={{ fontSize: 64, marginBottom: 12 }}>✅</div><h3 style={{ fontSize: 20, fontWeight: 800, color: "#166534", margin: "0 0 4px" }}>{last.type === "closing" ? "Closing Stock Submitted!" : "Demand Submitted!"}</h3><p style={{ color: "#16A34A", margin: "0 0 24px" }}>{oData?.name} — {last.time}</p><button onClick={() => waMsg(last)} style={{ padding: "14px 32px", borderRadius: 14, border: "none", background: "#25D366", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}>💬 Share on WhatsApp</button><br /><button onClick={() => setScreen("home")} style={{ padding: "12px 32px", borderRadius: 14, border: "1px solid #E0E0DC", background: "#fff", color: "#1A1A1A", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }}>← Back to Home</button></div>);

  if (screen === "home") return (<div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}><div><div style={{ fontSize: 16, fontWeight: 800 }}>🏪 {oData?.name}</div><div style={{ fontSize: 11, color: "#999" }}>{today()}</div></div><div style={{ display: "flex", gap: 6 }}>{tSubs.length > 0 && <span style={{ padding: "4px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>✅ {tSubs.length} sent</span>}<button onClick={() => { setOutlet(null); setScreen("pick"); }} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 11, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>Switch</button></div></div>
    {[{ s: "photo", icon: "📷", t: "Demand — Photo Upload", sub: "Take photo of filled challan", tag: "⚡ Fastest", tagC: "#B45309", bg: "linear-gradient(135deg,#FFFBEB,#FFF7ED)", bc: "#FDE68A" }, { s: "manual", icon: "✏️", t: "Demand — Manual Entry", sub: "Enter quantity for each item", bg: "#fff", bc: "#E8E8E4" }, { s: "close", icon: "📊", t: "Closing Stock", sub: "End of day — stock remaining", tag: "⚠️ Must fill daily", tagC: "#991B1B", bg: "linear-gradient(135deg,#FEF2F2,#FFF1F2)", bc: "#FECACA" }].map((opt) => (<button key={opt.s} onClick={() => { reset(); setClosing({}); setScreen(opt.s); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 16, border: `1.5px solid ${opt.bc}`, background: opt.bg, textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}><div style={{ fontSize: 34 }}>{opt.icon}</div><div><div style={{ fontSize: 16, fontWeight: 800 }}>{opt.t}</div><div style={{ fontSize: 12, color: "#888" }}>{opt.sub}</div>{opt.tag && <div style={{ fontSize: 10, fontWeight: 700, color: opt.tagC, marginTop: 3 }}>{opt.tag}</div>}</div></button>))}
    <button onClick={onBack} style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>
  </div>);

  if (screen === "photo") { const uc = Object.values(images).filter(Boolean).length; return (<div><SavingOverlay /><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>📷 Demand Photo</div><span style={{ fontSize: 13, fontWeight: 700, color: uc > 0 ? "#16A34A" : "#CCC" }}>{uc}/{DEMAND_SECTIONS.length}</span></div><div style={{ padding: "10px 14px", borderRadius: 10, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12, color: "#92400E", marginBottom: 14 }}>💡 Place filled challan on table → Take photo → Submit!</div><div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>{DEMAND_SECTIONS.map((s) => <PhotoUpload key={s.id} {...s} image={images[s.id]} onUpload={(img) => setImages((p) => ({ ...p, [s.id]: img }))} onRemove={() => setImages((p) => { const n = { ...p }; delete n[s.id]; return n; })} />)}</div><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any extra note..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 12 }} /><ErrBar /><button onClick={() => submit("photo")} disabled={uc === 0 || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: uc > 0 && !saving ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: uc > 0 && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳ Uploading..." : "✅ Submit Demand"}</button></div>); }

  if (screen === "manual") { const ft = Object.values(draft).filter((v) => v > 0).length; return (<div><SavingOverlay /><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>✏️ Manual Entry</div>{ft > 0 && <span style={{ padding: "3px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>{ft}</span>}</div>{DEMAND_SECTIONS.map((sec) => { const isO = expSec === sec.id, fl = sec.items.filter((i) => draft[i.id] > 0).length; return (<div key={sec.id} style={{ borderRadius: 14, border: `1px solid ${sec.border}`, overflow: "hidden", background: "#fff", marginBottom: 6 }}><div onClick={() => setExpSec(isO ? null : sec.id)} style={{ padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: isO ? sec.bg : "#fff" }}><span style={{ fontSize: 22 }}>{sec.emoji}</span><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{sec.titleHi}</div><div style={{ fontSize: 10, color: "#999" }}>{sec.items.length} items</div></div>{fl > 0 && <span style={{ padding: "2px 8px", borderRadius: 6, background: sec.bg, color: sec.color, fontSize: 11, fontWeight: 800 }}>{fl}</span>}<span style={{ color: "#CCC", transform: isO ? "rotate(180deg)" : "", transition: "0.2s" }}>▾</span></div>{isO && <div style={{ padding: "6px 12px 12px" }}>{sec.items.map((item) => (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: draft[item.id] > 0 ? sec.bg : "#FAFAF8", marginBottom: 3 }}><span style={{ flex: 1, fontSize: 13 }}>{item.name}</span><input type="number" inputMode="numeric" min="0" placeholder="0" value={draft[item.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 56, padding: "6px", borderRadius: 8, border: `1px solid ${sec.border}`, background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} /><span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.unit}</span></div>))}</div>}</div>); })}<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any extra note..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "8px 0 12px" }} /><button onClick={() => submit("manual")} disabled={ft === 0} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: ft > 0 ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: ft > 0 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>✅ Submit ({ft} items)</button></div>); }

  if (screen === "close") { const filled = CLOSING_STOCK.filter((i) => closing[i.id] !== undefined && closing[i.id] !== "").length; const done = filled === CLOSING_STOCK.length; return (<div><SavingOverlay /><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>📊 Closing Stock</div><span style={{ fontSize: 13, fontWeight: 700, color: done ? "#16A34A" : "#B45309" }}>{filled}/{CLOSING_STOCK.length}</span></div><div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 14 }}>⚠️ <strong>Important!</strong> Fill all items. Write 0 if finished.</div><div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 12 }}>{CLOSING_STOCK.map((item, idx) => { const isFilled = closing[item.id] !== undefined && closing[item.id] !== ""; return (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: idx < CLOSING_STOCK.length - 1 ? "1px solid #F0F0EC" : "none", background: isFilled ? "#F0FDF4" : "#fff" }}><span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{item.name}</span><input type="number" inputMode="decimal" min="0" step="0.1" placeholder="—" value={closing[item.id] ?? ""} onChange={(e) => setClosing((p) => ({ ...p, [item.id]: e.target.value === "" ? "" : Math.max(0, +e.target.value || 0) }))} style={{ width: 68, padding: "8px", borderRadius: 10, border: isFilled ? "2px solid #16A34A" : "2px solid #E0E0DC", background: "#fff", fontSize: 17, textAlign: "center", fontFamily: "inherit", fontWeight: 800 }} /><span style={{ fontSize: 12, color: "#999", width: 24 }}>{item.unit}</span></div>); })}</div><button onClick={() => submit("closing")} disabled={!done} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: done ? "#DC2626" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: done ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{done ? "📊 Submit Closing Stock" : `Fill all (${CLOSING_STOCK.length - filled} remaining)`}</button></div>); }
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
//  STORE MANAGER
// ═════════════════════════════════════════════════════════════════════════════
const StoreMgr = ({ onBack }) => {
  const [screen, setScreen] = useState("home");
  // Issuance state
  const [issueTo, setIssueTo] = useState("bk");
  const [issueImages, setIssueImages] = useState({});
  const [issueNote, setIssueNote] = useState("");
  // Purchase state
  const [purchases, setPurchases] = useState([{ item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]);
  const [billImages, setBillImages] = useState({});
  const [purchaseNote, setPurchaseNote] = useState("");
  const [paymentMode, setPaymentMode] = useState("cash");
  // Shared
  const [subs, setSubs] = useState([]);
  const [last, setLast] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const targets = [{ id: "bk", name: "BK Production", emoji: "🏭" }, ...OUTLETS.map((o) => ({ ...o, emoji: "🏪" }))];
  const todaySubs = subs.filter((s) => s.date === today());
  const todayPurchases = todaySubs.filter((s) => s.category === "purchase");
  const todayIssuances = todaySubs.filter((s) => s.category === "issuance");
  const todayPurchaseTotal = todayPurchases.reduce((s, p) => s + (p.totalAmount || 0), 0);

  const resetIssuance = () => { setIssueImages({}); setIssueNote(""); setIssueTo("bk"); setErr(null); };
  const resetPurchase = () => { setPurchases([{ item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]); setBillImages({}); setPurchaseNote(""); setPaymentMode("cash"); setErr(null); };

  const submitIssuance = async () => {
    setSaving(true); setErr(null);
    try {
      const result = await api.createIssuance({ issue_to: issueTo, note: issueNote });
      // Upload photos
      for (const [section, base64] of Object.entries(issueImages)) {
        if (base64) await api.uploadIssuancePhoto(result.id, section, base64);
      }
      const e = { ...result, category: "issuance", issueTo, images: { ...issueImages }, note: issueNote, time: timeNow(), date: today() };
      setSubs((p) => [e, ...p]); setLast(e); resetIssuance(); setScreen("done");
    } catch (error) { setErr(error.message || "Failed to submit"); }
    finally { setSaving(false); }
  };

  const submitPurchase = async () => {
    setSaving(true); setErr(null);
    try {
      const validItems = purchases.filter((p) => p.item.trim() && p.amount);
      const apiItems = validItems.map((i) => ({ item_name: i.item, quantity: Number(i.qty) || null, unit: i.unit, amount: Number(i.amount), vendor: i.vendor }));
      const result = await api.createPurchase({ items: apiItems, payment_mode: paymentMode, note: purchaseNote });
      // Upload bill photos
      for (const [label, base64] of Object.entries(billImages)) {
        if (base64) await api.uploadPurchasePhoto(result.id, base64, label);
      }
      const totalAmt = validItems.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const e = { ...result, category: "purchase", items: validItems, billImages: { ...billImages }, note: purchaseNote, paymentMode, totalAmount: totalAmt, time: timeNow(), date: today() };
      setSubs((p) => [e, ...p]); setLast(e); resetPurchase(); setScreen("done");
    } catch (error) { setErr(error.message || "Failed to submit"); }
    finally { setSaving(false); }
  };

  const SavingOverlay = () => saving ? <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}><div style={{ background: "#fff", borderRadius: 16, padding: "24px 32px", textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div><div style={{ fontSize: 15, fontWeight: 700 }}>Submitting...</div></div></div> : null;
  const ErrBar = () => err ? <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>❌ {err}</div> : null;

  const addPurchaseRow = () => setPurchases((p) => [...p, { item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]);
  const updatePurchase = (idx, field, val) => setPurchases((p) => p.map((r, i) => i === idx ? { ...r, [field]: val } : r));
  const removePurchaseRow = (idx) => setPurchases((p) => p.filter((_, i) => i !== idx));

  // ── SUCCESS ──
  if (screen === "done" && last) return (
    <div style={{ textAlign: "center", padding: "40px 0" }}>
      <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
      <h3 style={{ fontSize: 20, fontWeight: 800, color: "#166534", margin: "0 0 4px" }}>
        {last.category === "purchase" ? "Purchase Recorded!" : "Issuance Recorded!"}
      </h3>
      <p style={{ color: "#16A34A", margin: "0 0 6px" }}>
        {last.category === "purchase" ? `${fmt(last.totalAmount)} — ${last.paymentMode}` : `→ ${targets.find((t) => t.id === last.issueTo)?.name}`} — {last.time}
      </p>
      {last.category === "purchase" && (
        <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 16 }}>
          {last.items.map((it, i) => (
            <span key={i} style={{ padding: "3px 10px", borderRadius: 6, background: "#F0FDF4", fontSize: 12, fontWeight: 600 }}>{it.item}: {fmt(Number(it.amount))}</span>
          ))}
        </div>
      )}
      <div>
        <button onClick={() => {
          const msg = last.category === "purchase"
            ? `🧾 *Ananda Cafe — Daily Purchase*\n📅 ${last.date} | ⏰ ${last.time}\n💳 Payment: ${last.paymentMode}\n\n${last.items.map((it) => `• ${it.item}: ${it.qty} ${it.unit} — ${fmt(Number(it.amount))}${it.vendor ? ` (${it.vendor})` : ""}`).join("\n")}\n\n💰 Total: ${fmt(last.totalAmount)}\n${last.note ? `📝 ${last.note}\n` : ""}📸 ${Object.keys(last.billImages || {}).length} bill photo(s)\n✅ Sent via App`
            : `📋 *Ananda Cafe — Store Issuance*\n📅 ${last.date} | ⏰ ${last.time}\n→ ${targets.find((t) => t.id === last.issueTo)?.name}\n📸 ${Object.keys(last.images || {}).length} photo(s)\n${last.note ? `📝 ${last.note}\n` : ""}✅ Sent via App`;
          window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
        }} style={{ padding: "14px 32px", borderRadius: 14, border: "none", background: "#25D366", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}>💬 Share on WhatsApp</button>
      </div>
      <button onClick={() => setScreen("home")} style={{ padding: "12px 32px", borderRadius: 14, border: "1px solid #E0E0DC", background: "#fff", color: "#1A1A1A", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }}>← Back to Home</button>
    </div>
  );

  // ── HOME ──
  if (screen === "home") return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>🏪 BK Ration Store</div>
          <div style={{ fontSize: 11, color: "#999" }}>{today()}</div>
        </div>
        {todaySubs.length > 0 && <span style={{ padding: "4px 10px", borderRadius: 6, background: "#EFF6FF", color: "#2563EB", fontSize: 11, fontWeight: 700 }}>{todaySubs.length} entries</span>}
      </div>

      {/* Store Issuance */}
      <button onClick={() => { resetIssuance(); setScreen("issuance"); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 16, border: "1.5px solid #BFDBFE", background: "linear-gradient(135deg, #EFF6FF, #F0F9FF)", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 34 }}>📋</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Store Issuance</div>
          <div style={{ fontSize: 12, color: "#888" }}>Record items taken out of store</div>
          {todayIssuances.length > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: "#2563EB", marginTop: 3 }}>✅ {todayIssuances.length} issued today</div>}
        </div>
      </button>

      {/* Daily Purchases */}
      <button onClick={() => { resetPurchase(); setScreen("purchase"); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 16, border: "1.5px solid #FDE68A", background: "linear-gradient(135deg, #FFFBEB, #FFF7ED)", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 34 }}>🧾</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Daily Purchase</div>
          <div style={{ fontSize: 12, color: "#888" }}>Paneer, Mala, urgent items — with bill</div>
          {todayPurchases.length > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: "#B45309", marginTop: 3 }}>🧾 {todayPurchases.length} purchases — {fmt(todayPurchaseTotal)} today</div>}
        </div>
      </button>

      {/* Today's Log */}
      {todaySubs.length > 0 && (
        <button onClick={() => setScreen("log")} style={{ width: "100%", padding: "16px 20px", borderRadius: 16, border: "1px solid #E8E8E4", background: "#fff", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 28 }}>📋</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Today's Log</div>
            <div style={{ fontSize: 12, color: "#999" }}>{todaySubs.length} entries{todayPurchaseTotal > 0 ? ` • ${fmt(todayPurchaseTotal)} purchased` : ""}</div>
          </div>
          <span style={{ marginLeft: "auto", fontSize: 18, color: "#CCC" }}>→</span>
        </button>
      )}

      <button onClick={onBack} style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>
    </div>
  );

  // ── ISSUANCE ──
  if (screen === "issuance") {
    const uc = Object.values(issueImages).filter(Boolean).length;
    return (<div><SavingOverlay />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>📋 Store Issuance</div></div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>Issuing To</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>{targets.map((t) => (<button key={t.id} onClick={() => setIssueTo(t.id)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: issueTo === t.id ? "none" : "1px solid #E0E0DC", background: issueTo === t.id ? "#1A1A1A" : "#fff", color: issueTo === t.id ? "#fff" : "#888", fontFamily: "inherit" }}>{t.emoji} {t.name}</button>))}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Upload Store Issue Photos</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>{[{ id: "s1", titleHi: "Store Issue Sheet 1", emoji: "📋", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" }, { id: "s2", titleHi: "Store Issue Sheet 2", emoji: "📋", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" }, { id: "s3", titleHi: "Extra / Additional", emoji: "📎", color: "#9333EA", bg: "#FAF5FF", border: "#E9D5FF" }].map((s) => (<PhotoUpload key={s.id} {...s} image={issueImages[s.id]} onUpload={(img) => setIssueImages((p) => ({ ...p, [s.id]: img }))} onRemove={() => setIssueImages((p) => { const n = { ...p }; delete n[s.id]; return n; })} />))}</div>
      <input value={issueNote} onChange={(e) => setIssueNote(e.target.value)} placeholder="Issuance note..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 12 }} />
      <ErrBar />
      <button onClick={submitIssuance} disabled={uc === 0 || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: uc > 0 && !saving ? "#16A34A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: uc > 0 && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳ Uploading..." : `🏪 Record Issuance → ${targets.find((t) => t.id === issueTo)?.name}`}</button>
    </div>);
  }

  // ── DAILY PURCHASE ──
  if (screen === "purchase") {
    const validItems = purchases.filter((p) => p.item.trim() && p.amount);
    const totalAmt = validItems.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const billCount = Object.values(billImages).filter(Boolean).length;
    const canSubmit = validItems.length > 0 && billCount > 0;

    return (<div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <BackBtn onClick={() => setScreen("home")} />
        <div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 800 }}>🧾 Daily Purchase</div><div style={{ fontSize: 11, color: "#999" }}>Record with bill photo</div></div>
        {totalAmt > 0 && <span style={{ padding: "4px 12px", borderRadius: 8, background: "#FFFBEB", border: "1px solid #FDE68A", color: "#B45309", fontSize: 13, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(totalAmt)}</span>}
      </div>

      {/* Item rows */}
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Items Purchased</div>
      {purchases.map((row, idx) => (
        <div key={idx} style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "14px 16px", marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input value={row.item} onChange={(e) => updatePurchase(idx, "item", e.target.value)}
              placeholder="Item name (Paneer, Mala...)"
              style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", fontWeight: 600 }} />
            {purchases.length > 1 && (
              <button onClick={() => removePurchaseRow(idx)} style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✕</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Qty</div>
              <input value={row.qty} onChange={(e) => updatePurchase(idx, "qty", e.target.value)}
                type="number" inputMode="decimal" placeholder="0"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", textAlign: "center", fontWeight: 600 }} />
            </div>
            <div style={{ width: 80 }}>
              <div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Unit</div>
              <select value={row.unit} onChange={(e) => updatePurchase(idx, "unit", e.target.value)}
                style={{ width: "100%", padding: "8px 6px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
                {["Kg", "gm", "L", "ml", "Pcs", "Pkt", "Box", "Bundle", "Dozen"].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Amount (₹)</div>
              <input value={row.amount} onChange={(e) => updatePurchase(idx, "amount", e.target.value)}
                type="number" inputMode="numeric" placeholder="₹0"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", textAlign: "center", fontWeight: 700, color: "#B45309" }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Vendor</div>
              <input value={row.vendor} onChange={(e) => updatePurchase(idx, "vendor", e.target.value)}
                placeholder="Shop name"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit" }} />
            </div>
          </div>
        </div>
      ))}
      <button onClick={addPurchaseRow} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "2px dashed #E0E0DC", background: "transparent", fontSize: 14, fontWeight: 700, color: "#999", cursor: "pointer", fontFamily: "inherit", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>+ Add Another Item</button>

      {/* Payment Mode */}
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>Payment Mode</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[{ id: "cash", label: "💵 Cash" }, { id: "upi", label: "📱 UPI / GPay" }, { id: "credit", label: "📒 Credit (Udhar)" }].map((m) => (
          <button key={m.id} onClick={() => setPaymentMode(m.id)} style={{
            flex: 1, padding: "10px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            border: paymentMode === m.id ? "2px solid #B45309" : "1px solid #E0E0DC",
            background: paymentMode === m.id ? "#FFFBEB" : "#fff",
            color: paymentMode === m.id ? "#B45309" : "#888",
          }}>{m.label}</button>
        ))}
      </div>

      {/* Bill Photos */}
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Bill / Receipt Photos</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {[
          { id: "bill1", titleHi: "Bill / Receipt Photo", emoji: "🧾", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
          { id: "bill2", titleHi: "Additional Bill (if any)", emoji: "🧾", color: "#999", bg: "#FAFAF8", border: "#E0E0DC" },
        ].map((s) => (
          <PhotoUpload key={s.id} {...s} image={billImages[s.id]}
            onUpload={(img) => setBillImages((p) => ({ ...p, [s.id]: img }))}
            onRemove={() => setBillImages((p) => { const n = { ...p }; delete n[s.id]; return n; })} />
        ))}
      </div>

      {!billCount && <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>⚠️ Bill photo is required — no purchase without bill!</div>}

      <input value={purchaseNote} onChange={(e) => setPurchaseNote(e.target.value)} placeholder="Purchase note (optional)..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 12 }} />

      {/* Total + Submit */}
      {totalAmt > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderRadius: 12, background: "#FFFBEB", border: "1px solid #FDE68A", marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>Total Purchase</span>
          <span style={{ fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{fmt(totalAmt)}</span>
        </div>
      )}
      <button onClick={submitPurchase} disabled={!canSubmit} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: canSubmit ? "#B45309" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: canSubmit ? "pointer" : "not-allowed", fontFamily: "inherit" }}>🧾 Record Purchase {totalAmt > 0 ? `— ${fmt(totalAmt)}` : ""}</button>
    </div>);
  }

  // ── LOG ──
  if (screen === "log") return (<div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ fontSize: 15, fontWeight: 800 }}>📋 Today's Log</div></div>
    {todayPurchaseTotal > 0 && (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderRadius: 12, background: "#FFFBEB", border: "1px solid #FDE68A", marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>Total Purchases Today</span>
        <span style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{fmt(todayPurchaseTotal)}</span>
      </div>
    )}
    {todaySubs.map((entry) => (
      <div key={entry.id} style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "14px 16px", marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 18 }}>{entry.category === "purchase" ? "🧾" : "📋"}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{entry.category === "purchase" ? "Purchase" : "Store Issuance"}</div>
              <div style={{ fontSize: 11, color: "#999" }}>{entry.time}</div>
            </div>
          </div>
          {entry.category === "purchase" && <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{fmt(entry.totalAmount)}</span>}
          {entry.category === "issuance" && <span style={{ fontSize: 12, color: "#2563EB", fontWeight: 600 }}>→ {targets.find((t) => t.id === entry.issueTo)?.name}</span>}
        </div>
        {entry.category === "purchase" && entry.items && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
            {entry.items.map((it, i) => <span key={i} style={{ padding: "2px 8px", borderRadius: 5, background: "#FFFBEB", fontSize: 11, fontWeight: 600 }}>{it.item}: {fmt(Number(it.amount))}{it.vendor ? ` (${it.vendor})` : ""}</span>)}
          </div>
        )}
        {entry.category === "purchase" && <div style={{ fontSize: 11, color: "#888" }}>💳 {entry.paymentMode === "cash" ? "Cash" : entry.paymentMode === "upi" ? "UPI" : "Credit"}</div>}
        {entry.note && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>📝 {entry.note}</div>}
      </div>
    ))}
  </div>);

  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN — LAUNCHER
// ═════════════════════════════════════════════════════════════════════════════
export default function AnandaCafe() {
  const [app, setApp] = useState("launcher");
  const [ownerTab, setOwnerTab] = useState("cogs");
  const [orders, setOrders] = useState(() => generateOrders());

  if (app === "launcher") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 440, margin: "0 auto", padding: "40px 20px" }}><div style={{ textAlign: "center", marginBottom: 36 }}><div style={{ fontSize: 48, marginBottom: 8 }}>🍽️</div><h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 4px" }}>Ananda Cafe</h1><p style={{ fontSize: 14, color: "#999", margin: 0 }}>Operations Management System</p></div>
    {[{ id: "owner", icon: "👑", title: "Owner Dashboard", sub: "COGS, Daily P&L, Red Flags", bg: "linear-gradient(135deg, #1A1A1A, #333)", color: "#fff", subC: "rgba(255,255,255,0.6)" }, { id: "outlet", icon: "🏪", title: "Outlet Manager", sub: "Daily demand challan & closing stock", bg: "#fff", color: "#1A1A1A", border: "#E8E8E4", subC: "#888" }, { id: "store", icon: "📦", title: "Store Manager (BK)", sub: "Ration store issuance records", bg: "#fff", color: "#1A1A1A", border: "#E8E8E4", subC: "#888" }].map((a) => (<button key={a.id} onClick={() => setApp(a.id)} style={{ width: "100%", padding: "22px 24px", borderRadius: 18, background: a.bg, border: a.border ? `1px solid ${a.border}` : "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 12, display: "flex", alignItems: "center", gap: 16 }}><div style={{ fontSize: 36 }}>{a.icon}</div><div><div style={{ fontSize: 18, fontWeight: 800, color: a.color }}>{a.title}</div><div style={{ fontSize: 13, color: a.subC }}>{a.sub}</div></div></button>))}
  </div></div>);

  if (app === "owner") return (<div style={PAGE}>{FONT}
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 50 }}><BackBtn onClick={() => setApp("launcher")} /><div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 800 }}>👑 Owner Dashboard</div><div style={{ fontSize: 11, color: "#999" }}>Ananda Cafe</div></div></div>
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "0 18px", display: "flex", gap: 0, position: "sticky", top: 52, zIndex: 49, overflowX: "auto" }}>{[{ id: "cogs", label: "📊 COGS" }, { id: "pnl", label: "💰 P&L" }, { id: "orders", label: "📋 Orders" }, { id: "kitchen", label: "🏭 Base Kitchen" }, { id: "dispatch", label: "🚚 Dispatch" }, { id: "recipes", label: "📖 Recipes" }].map((t) => (<button key={t.id} onClick={() => setOwnerTab(t.id)} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: ownerTab === t.id ? 700 : 500, color: ownerTab === t.id ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: ownerTab === t.id ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>{t.label}</button>))}</div>
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 18px 40px" }}>
      {ownerTab === "cogs" && <CogsDash />}
      {ownerTab === "pnl" && <DailyPnL />}
      {ownerTab === "orders" && <OutletOrders orders={orders} setOrders={setOrders} />}
      {ownerTab === "kitchen" && <BaseKitchen orders={orders} />}
      {ownerTab === "dispatch" && <Dispatch orders={orders} setOrders={setOrders} />}
      {ownerTab === "recipes" && <RecipesPanel />}
    </div>
  </div>);

  if (app === "outlet") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 500, margin: "0 auto", padding: "24px 18px" }}><OutletMgr onBack={() => setApp("launcher")} /></div></div>);
  if (app === "store") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 500, margin: "0 auto", padding: "24px 18px" }}><StoreMgr onBack={() => setApp("launcher")} /></div></div>);
  return null;
}
