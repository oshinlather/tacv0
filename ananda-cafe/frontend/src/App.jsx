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
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() + 330 - d.getTimezoneOffset()); return d.toISOString().split("T")[0]; };
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

// ─── DEMAND / STORE DATA (from item_list_.xlsx) ─────────────────────────────
const DEMAND_SECTIONS = [
  { id: "food", titleHi: "Food (Prepared in BK)", emoji: "🍲", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A",
    items: [
      { id: "coconut_crush", name: "Coconut Crush" }, { id: "dosa_batter", name: "Dosa Batter" },
      { id: "garlic_paste", name: "Garlic Paste" }, { id: "idli_batter", name: "Idli Batter" },
      { id: "onion_masala", name: "Onion Masala" }, { id: "pineapple_halwa", name: "Pineapple Halwa" },
      { id: "podi_masala", name: "Podi Masala" }, { id: "rasam", name: "Rasam" },
      { id: "rawa_mix", name: "Rawa Mix" }, { id: "red_chutney", name: "Red Chutney" },
      { id: "roasted_karipatta", name: "Roasted Karipatta" }, { id: "roasted_peanuts", name: "Roasted Peanuts" },
      { id: "sambhar", name: "Sambhar" }, { id: "sevya_payasam", name: "Sevya Payasam" },
      { id: "tadka", name: "Tadka" }, { id: "vada_batter", name: "Vada Batter" },
      { id: "white_chutney", name: "White Chutney" },
    ]},
  { id: "vegetable", titleHi: "Vegetables", emoji: "🥬", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0",
    items: [
      { id: "anar", name: "Anar" }, { id: "curry_leaves", name: "Curry Leaves" },
      { id: "green_chillies", name: "Green Chillies" }, { id: "lemon", name: "Lemon" },
      { id: "garlic", name: "Garlic" }, { id: "beans", name: "Beans" },
      { id: "ginger", name: "Ginger" }, { id: "mint", name: "Mint (Pudina)" },
      { id: "potato", name: "Potato" }, { id: "coconut", name: "Coconut" },
      { id: "coriander_leaves", name: "Coriander Leaves" }, { id: "carrot", name: "Carrot" },
      { id: "petha", name: "Petha" }, { id: "staff_veg", name: "Staff Veg" },
      { id: "tomatoes", name: "Tomatoes" }, { id: "onions", name: "Onions" },
      { id: "drumstick", name: "Drumstick" }, { id: "banana_leaves", name: "Banana Leaves" },
      { id: "pineapple", name: "Pineapple" },
    ]},
  { id: "grocery", titleHi: "Grocery", emoji: "🛒", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA",
    items: [
      { id: "kitchen_king", name: "Kitchen King" }, { id: "kesar", name: "Kesar" },
      { id: "ilaychi", name: "Ilaychi" }, { id: "hing_powder", name: "Hing Powder" },
      { id: "deggi_mirch", name: "Deggi Mirch" }, { id: "kali_mirch", name: "Kali Mirch" },
      { id: "kaju", name: "Kaju" }, { id: "desi_ghee", name: "Desi Ghee" },
      { id: "kishmish", name: "Kishmish" }, { id: "whole_red_chilli", name: "Whole Red Chilli" },
      { id: "haldi_powder", name: "Haldi Powder" }, { id: "safed_til", name: "Safed Til" },
      { id: "chai_patti", name: "Chai Patti" }, { id: "fortune_refined", name: "Fortune Refined Oil" },
      { id: "dhaniya_whole", name: "Dhaniya Whole" }, { id: "imli", name: "Imli" },
      { id: "rajma", name: "Rajma" }, { id: "urad_daal_whole", name: "Urad Daal Whole" },
      { id: "chhole", name: "Chhole" }, { id: "staff_dal", name: "Staff Dal" },
      { id: "methi_dana", name: "Methi Dana" }, { id: "mustard_seeds", name: "Mustard Seeds" },
      { id: "semiyan", name: "Semiyan" }, { id: "besan", name: "Besan" },
      { id: "poha", name: "Poha" }, { id: "amchoor_powder", name: "Amchoor Powder" },
      { id: "chana_dal", name: "Chana Dal" }, { id: "rice_powder", name: "Rice Powder" },
      { id: "upma_sooji", name: "Upma Sooji" }, { id: "meetha_soda", name: "Meetha Soda" },
      { id: "gur", name: "Gur" }, { id: "sugar", name: "Sugar" },
      { id: "atta", name: "Atta" }, { id: "salt", name: "Salt" },
      { id: "garam_masala", name: "Garam Masala" }, { id: "achar", name: "Achar" },
      { id: "dhaniya_powder", name: "Dhaniya Powder" }, { id: "filter_coffee_powder", name: "Filter Coffee Powder" },
      { id: "papad_777", name: "777 Papad" }, { id: "sambhar_masala_777", name: "Sambhar Masala 777" },
      { id: "red_chilli_powder", name: "Red Chilli Powder" }, { id: "chat_masala", name: "Chat Masala" },
      { id: "long", name: "Long" }, { id: "sarson_tel", name: "Sarson Tel" },
      { id: "arhar_dal", name: "Arhar Dal" }, { id: "pista", name: "Pista" },
      { id: "almond", name: "Almond" }, { id: "soya_badi", name: "Soya Badi" },
      { id: "jeera", name: "Jeera" }, { id: "peanuts", name: "Peanuts" },
      { id: "roasted_chana", name: "Roasted Chana" }, { id: "golden_sela_rice", name: "Golden Sela Rice" },
      { id: "sona_masoori_rice", name: "Sona Masoori Rice" }, { id: "black_salt", name: "Black Salt" },
      { id: "kasturi_methi", name: "Kasturi Methi" }, { id: "water", name: "Water" },
      { id: "milk", name: "Milk" }, { id: "milkmaid", name: "Milkmaid" },
    ]},
  { id: "packaging", titleHi: "Packaging", emoji: "📦", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE",
    items: [
      { id: "biopoly_16x20", name: "16x20 Biopolythene" }, { id: "bio_garbage_bag", name: "Bio Garbage Bag" },
      { id: "bio_spoon", name: "Bio Spoon" }, { id: "butter_paper", name: "Butter Paper" },
      { id: "chef_cap", name: "Chef Cap" }, { id: "clean_wrap", name: "Clean Wrap" },
      { id: "dosa_box_big", name: "Dosa Box Big" }, { id: "dosa_box_small", name: "Dosa Box Small" },
      { id: "filter_coffee_glass", name: "Filter Coffee Glass" }, { id: "filter_coffee_pkg", name: "Filter Coffee Packaging" },
      { id: "hand_gloves", name: "Hand Gloves" }, { id: "kitchen_wipes", name: "Kitchen Wipes" },
      { id: "chhachh_glass", name: "Masala Chhachh Glass" }, { id: "chhachh_pkg", name: "Masala Chhachh Packaging" },
      { id: "paper_bowl", name: "Paper Bowl" }, { id: "podi_idli_container", name: "Podi Idli Container" },
      { id: "printer_roll", name: "Printer Roll" }, { id: "silver_container", name: "Silver Container" },
      { id: "stirrer", name: "Stirrer" }, { id: "tape", name: "Tape" },
      { id: "tissues", name: "Tissues" }, { id: "vada_lifafa", name: "Vada Lifafa" },
      { id: "wooden_plates", name: "Wooden Plates" }, { id: "container_100ml", name: "100ML Container" },
      { id: "container_50ml", name: "50ML Container" }, { id: "container_250ml", name: "250ML Container" },
      { id: "container_300ml", name: "300ML Container" }, { id: "container_500ml", name: "500ML Container" },
      { id: "rasam_glass", name: "Rasam Glass" }, { id: "biopoly_13x16", name: "13x16 Biopolythene" },
    ]},
  { id: "cleaning", titleHi: "Cleaning", emoji: "🧹", color: "#9333EA", bg: "#FAF5FF", border: "#E9D5FF",
    items: [
      { id: "bartan_sabun", name: "Bartan Sabun" }, { id: "pochha", name: "Pochha" },
      { id: "sarf", name: "Sarf" }, { id: "fool_jhadu", name: "Fool Jhadu" },
      { id: "duster", name: "Duster" }, { id: "seek_jhadu", name: "Seek Jhadu" },
      { id: "wiper", name: "Wiper" }, { id: "phenyl", name: "Phenyl" },
      { id: "sanitizer", name: "Sanitizer" }, { id: "steel_juna", name: "Steel Juna" },
      { id: "supli", name: "Supli" },
    ]},
  { id: "gas", titleHi: "Gas", emoji: "🔥", color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA",
    items: [
      { id: "gas_cylinder", name: "Gas Cylinder" },
    ]},
];

const CLOSING_STOCK = [
  { id: "cs_sambhar", name: "Sambhar", unit: "Kg" }, { id: "cs_red_chutney", name: "Red Chutney", unit: "Kg" },
  { id: "cs_white_chutney", name: "White Chutney", unit: "Kg" }, { id: "cs_dosa_batter", name: "Dosa Batter", unit: "Kg" },
  { id: "cs_idli_batter", name: "Idli Batter", unit: "Kg" }, { id: "cs_vada_batter", name: "Vada Batter", unit: "Kg" },
  { id: "cs_rasam", name: "Rasam", unit: "L" }, { id: "cs_pineapple_halwa", name: "Pineapple Halwa", unit: "Kg" },
  { id: "cs_coconut_crush", name: "Coconut Crush", unit: "Kg" }, { id: "cs_onion_masala", name: "Onion Masala", unit: "Kg" },
  { id: "cs_oil", name: "Oil", unit: "L" }, { id: "cs_ghee", name: "Ghee", unit: "Kg" },
  { id: "cs_coffee_powder", name: "Filter Coffee Powder", unit: "Kg" },
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
  const [pnlData, setPnlData] = useState([]);
  const [loading, setLoading] = useState(true);

  const dateStr = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - selDay); return d.toISOString().split("T")[0];
  }, [selDay]);

  useEffect(() => { setLoading(true); api.getPnl({ date: dateStr }).then(setPnlData).catch(() => setPnlData([])).finally(() => setLoading(false)); }, [dateStr]);

  const outletIds = selOutlet ? [selOutlet] : OUTLETS.map((o) => o.id);
  const getData = (oid) => pnlData.find((r) => r.outlet_id === oid) || {};

  const totals = useMemo(() => {
    const t = {};
    [...PNL_REVENUE, ...ALL_EXPENSES].forEach((item) => {
      t[item.id] = outletIds.reduce((sum, oid) => sum + (Number(getData(oid)[item.id]) || 0), 0);
    });
    return t;
  }, [dateStr, selOutlet, pnlData]);

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

// ─── BK Items — auto-derived from DEMAND_SECTIONS so they always match ──────
const BK_ITEMS = DEMAND_SECTIONS.flatMap((sec) => sec.items.map((item) => ({ ...item, category: sec.id })));
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
  sambhar: { name: "Sambhar", yield: "10 Kg", yieldQty: 10, ingredients: [{ rawId: "toor_dal", qty: 2 }, { rawId: "tomato", qty: 1.5 }, { rawId: "onion_raw", qty: 1 }, { rawId: "tamarind", qty: 0.15 }, { rawId: "oil", qty: 0.3 }, { rawId: "mustard", qty: 0.05 }, { rawId: "curry_leaves_raw", qty: 2 }, { rawId: "salt_raw", qty: 0.15 }] },
  dosa_batter: { name: "Dosa Batter", yield: "10 Batch", yieldQty: 10, ingredients: [{ rawId: "urad_dal", qty: 2.5 }, { rawId: "rice", qty: 7 }, { rawId: "salt_raw", qty: 0.1 }] },
  idli_batter: { name: "Idli Batter", yield: "10 Batch", yieldQty: 10, ingredients: [{ rawId: "urad_dal", qty: 2.5 }, { rawId: "rice", qty: 7 }, { rawId: "salt_raw", qty: 0.1 }] },
  vada_batter: { name: "Vada Batter", yield: "5 Batch", yieldQty: 5, ingredients: [{ rawId: "urad_dal", qty: 4.5 }, { rawId: "green_chilli_raw", qty: 0.1 }, { rawId: "curry_leaves_raw", qty: 1 }, { rawId: "salt_raw", qty: 0.08 }] },
  red_chutney: { name: "Red Chutney", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "tomato", qty: 3 }, { rawId: "peanuts", qty: 0.5 }, { rawId: "onion_raw", qty: 0.5 }, { rawId: "oil", qty: 0.15 }, { rawId: "salt_raw", qty: 0.05 }] },
  rava_mix: { name: "Rava Mix", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "sooji", qty: 3.5 }, { rawId: "sugar_raw", qty: 1 }, { rawId: "ghee", qty: 0.5 }] },
  onion_masala: { name: "Onion Masala", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "onion_raw", qty: 3 }, { rawId: "tomato", qty: 1 }, { rawId: "oil", qty: 0.3 }, { rawId: "salt_raw", qty: 0.05 }] },
  upma_sooji: { name: "Upma Sooji Premix", yield: "5000 gm", yieldQty: 5000, ingredients: [{ rawId: "sooji", qty: 3500 }, { rawId: "mustard", qty: 30 }, { rawId: "curry_leaves_raw", qty: 50 }, { rawId: "onion_raw", qty: 500 }, { rawId: "oil", qty: 200 }, { rawId: "salt_raw", qty: 80 }] },
  poha: { name: "Poha Premix", yield: "5000 gm", yieldQty: 5000, ingredients: [{ rawId: "poha_raw_mat", qty: 3000 }, { rawId: "onion_raw", qty: 800 }, { rawId: "peanuts", qty: 300 }, { rawId: "green_chilli_raw", qty: 50 }, { rawId: "mustard", qty: 20 }, { rawId: "curry_leaves_raw", qty: 50 }, { rawId: "oil", qty: 150 }, { rawId: "salt_raw", qty: 50 }] },
  podi_masala: { name: "Podi Masala", yield: "5 Kg", yieldQty: 5, ingredients: [{ rawId: "urad_dal", qty: 2 }, { rawId: "green_chilli_raw", qty: 0.5 }, { rawId: "oil", qty: 0.3 }, { rawId: "salt_raw", qty: 0.1 }] },
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

// ═════════════════════════════════════════════════════════════════════════════
//  LIVE ACTIVITY — real-time dashboard from DB
// ═════════════════════════════════════════════════════════════════════════════
const LiveActivity = () => {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [err, setErr] = useState(null);
  const load = () => { setLoading(true); setErr(null); api.getDashboardSummary(today()).then(setData).catch((e) => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(load, []);
  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading activity...</div>;
  if (err) return <div style={{ textAlign: "center", padding: 40 }}><div style={{ color: "#DC2626", fontSize: 14, fontWeight: 700, marginBottom: 8 }}>❌ {err}</div><button onClick={load} style={{ padding: "8px 20px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>🔄 Retry</button></div>;
  if (!data) return null;
  const s = data.summary;
  return (<div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>🔴 Live Activity — {today()}</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>All submissions from outlets & BK</p></div>
      <button onClick={load} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 12, fontWeight: 600, color: "#777", cursor: "pointer", fontFamily: "inherit" }}>🔄 Refresh</button>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 8, marginBottom: 20 }}>
      {[{ l: "Demands", v: s.total_demands, bg: "#F0FDF4", bc: "#BBF7D0", c: "#16A34A" }, { l: "Pending", v: s.pending_dispatch, bg: s.pending_dispatch > 0 ? "#FFFBEB" : "#F0FDF4", bc: s.pending_dispatch > 0 ? "#FDE68A" : "#BBF7D0", c: s.pending_dispatch > 0 ? "#B45309" : "#16A34A" }, { l: "Issuances", v: s.total_issuances, bg: "#EFF6FF", bc: "#BFDBFE", c: "#2563EB" }, { l: "Purchases", v: s.total_purchases, bg: "#FFFBEB", bc: "#FDE68A", c: "#B45309" }, { l: "Purchase ₹", v: fmt(s.purchase_amount), bg: "#FFFBEB", bc: "#FDE68A", c: "#B45309" }].map((card, i) => (
        <div key={i} style={{ background: card.bg, borderRadius: 12, padding: "12px 14px", border: `1px solid ${card.bc}`, textAlign: "center" }}><div style={{ fontSize: 9, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{card.l}</div><div style={{ fontSize: 20, fontWeight: 800, color: card.c, fontFamily: "'JetBrains Mono', monospace" }}>{card.v}</div></div>
      ))}
    </div>
    {data.demands.length > 0 && <div style={{ marginBottom: 16 }}><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>📋 Demands</div>{data.demands.map((d) => (<div key={d.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 14px", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><strong style={{ fontSize: 12 }}>{OUTLETS.find((o) => o.id === d.outlet_id)?.name || d.outlet_id}</strong><span style={{ fontSize: 10, color: "#888" }}>{d.type === "photo" ? "📷" : "✏️"}</span><span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: d.status === "fulfilled" ? "#F0FDF4" : "#FFFBEB", color: d.status === "fulfilled" ? "#16A34A" : "#B45309" }}>{d.status}</span></div><span style={{ fontSize: 11, color: "#999" }}>{new Date(d.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span></div>))}</div>}
    {data.purchases.length > 0 && <div style={{ marginBottom: 16 }}><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🧾 Purchases</div>{data.purchases.map((p) => (<div key={p.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 14px", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 12, fontWeight: 600 }}>💳 {p.payment_mode}</span><span style={{ fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#B45309" }}>{fmt(Number(p.total_amount))}</span></div>))}</div>}
    {data.issuances.length > 0 && <div><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>📋 Issuances</div>{data.issuances.map((iss) => (<div key={iss.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 14px", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 12, fontWeight: 600 }}>→ {iss.issue_to === "bk" ? "BK Production" : OUTLETS.find((o) => o.id === iss.issue_to)?.name || iss.issue_to}</span><span style={{ fontSize: 11, color: "#999" }}>{new Date(iss.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span></div>))}</div>}
    {s.total_demands === 0 && s.total_purchases === 0 && s.total_issuances === 0 && <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "40px 20px", textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 8 }}>📭</div><div style={{ color: "#999" }}>No activity yet today</div></div>}
  </div>);
};

// ═════════════════════════════════════════════════════════════════════════════
//  OUTLET ORDERS — fetches from DB
// ═════════════════════════════════════════════════════════════════════════════
const OutletOrders = () => {
  const [orders, setOrders] = useState([]); const [loading, setLoading] = useState(true);
  useEffect(() => { api.getOrders({ date: today() }).then(setOrders).catch(() => setOrders([])).finally(() => setLoading(false)); }, []);
  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;
  return (
    <div id="print-orders">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Outlet Orders (Live from DB)</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>{orders.length} orders for {today()}</p></div>
        <PrintBtn sectionId="print-orders" title="Outlet Orders" />
      </div>
      {orders.length === 0 ? <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "40px 20px", textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 8 }}>📋</div><div style={{ color: "#999" }}>No orders submitted yet today</div></div> : (
        OUTLETS.map((outlet) => { const oo = orders.filter((d) => d.outlet_id === outlet.id); return (
          <div key={outlet.id} style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "16px 18px", marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <strong style={{ fontSize: 14 }}>{outlet.name}</strong>
              {oo.length === 0 ? <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#FEF2F2", color: "#DC2626" }}>NOT ORDERED</span> : <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#F0FDF4", color: "#16A34A" }}>{oo.length} order(s)</span>}
            </div>
            {oo.map((o) => (<div key={o.id} style={{ padding: "6px 10px", background: "#FAFAF8", borderRadius: 8, marginBottom: 3, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontWeight: 600 }}>{o.type === "photo" ? "📷 Photo" : "✏️ Manual"}</span><span style={{ color: "#999" }}>{new Date(o.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span><span style={{ marginLeft: "auto", padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: o.status === "fulfilled" ? "#F0FDF4" : "#FFFBEB", color: o.status === "fulfilled" ? "#16A34A" : "#B45309" }}>{o.status}</span></div>))}
          </div>); })
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  BASE KITCHEN (Consolidated Challan + Raw Material Requisition)
// ═════════════════════════════════════════════════════════════════════════════
const BaseKitchen = () => {
  const [orders, setOrders] = useState([]); const [loading, setLoading] = useState(true);
  useEffect(() => { api.getOrders({ date: today() }).then((data) => setOrders(data.filter((d) => d.type === "manual" && d.items))).catch(() => setOrders([])).finally(() => setLoading(false)); }, []);
  const consolidated = {}; BK_ITEMS.forEach((bk) => { consolidated[bk.id] = { total: 0, by: {} }; orders.forEach((o) => { const q = o.items?.[bk.id] || 0; consolidated[bk.id].total += q; consolidated[bk.id].by[o.outlet_id] = (consolidated[bk.id].by[o.outlet_id] || 0) + q; }); });
  const rawReq = {}; Object.entries(consolidated).forEach(([bkId, data]) => { const recipe = RECIPES[bkId]; if (!recipe || data.total === 0) return; const batches = data.total / recipe.yieldQty; recipe.ingredients.forEach((ing) => { rawReq[ing.rawId] = (rawReq[ing.rawId] || 0) + ing.qty * batches; }); });
  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;
  return (
    <div id="print-kitchen">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Base Kitchen — Consolidated Challan</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>{orders.length} manual orders for {today()}</p></div>
        <PrintBtn sectionId="print-kitchen" title="BK Consolidated Challan" />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>{[{ l: "Orders", v: orders.length, s: `of ${OUTLETS.length}` }, { l: "BK Items", v: Object.values(consolidated).filter((c) => c.total > 0).length }, { l: "Raw Materials", v: Object.keys(rawReq).length }].map((s, i) => (<div key={i} style={{ flex: 1, background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4", textAlign: "center" }}><div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{s.l}</div><div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{s.v}</div>{s.s && <div style={{ fontSize: 11, color: "#BBB" }}>{s.s}</div>}</div>))}</div>
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
const Dispatch = () => {
  const [orders, setOrders] = useState([]); const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState({});
  const [dispatching, setDispatching] = useState(null);
  const [selOutlet, setSelOutlet] = useState(null); // null = all
  const [expandedCat, setExpandedCat] = useState({}); // { orderId_catId: true }
  const load = () => { setLoading(true); api.getOrders({ date: today() }).then(setOrders).catch(() => setOrders([])).finally(() => setLoading(false)); };
  useEffect(load, []);

  const pending = orders.filter((o) => (o.status === "submitted" || o.status === "received") && (!selOutlet || o.outlet_id === selOutlet));
  const done = orders.filter((o) => o.status === "fulfilled" && (!selOutlet || o.outlet_id === selOutlet));
  const allPending = orders.filter((o) => o.status === "submitted" || o.status === "received");
  const allDone = orders.filter((o) => o.status === "fulfilled");

  const isChecked = (oid, iid) => checked[oid]?.[iid] || false;
  const toggle = (oid, iid) => setChecked((p) => ({ ...p, [oid]: { ...(p[oid] || {}), [iid]: !isChecked(oid, iid) } }));
  const checkAllCat = (oid, items) => { const allDone = items.every(([id]) => isChecked(oid, id)); const v = { ...(checked[oid] || {}) }; items.forEach(([id]) => { v[id] = !allDone; }); setChecked((p) => ({ ...p, [oid]: v })); };
  const toggleCat = (key) => setExpandedCat((p) => ({ ...p, [key]: !p[key] }));

  const doDispatch = async (id) => {
    setDispatching(id);
    try { await api.updateOrderStatus(id, "fulfilled"); load(); } catch (e) { alert("Error: " + e.message); }
    finally { setDispatching(null); }
  };

  // Group items by category from DEMAND_SECTIONS
  const getItemsByCategory = (items) => {
    const grouped = {};
    DEMAND_SECTIONS.forEach((sec) => { grouped[sec.id] = { label: sec.titleHi, emoji: sec.emoji, color: sec.color, bg: sec.bg, border: sec.border, items: [] }; });
    grouped["_other"] = { label: "Other", emoji: "📦", color: "#666", bg: "#FAFAF8", border: "#E0E0DC", items: [] };
    Object.entries(items).filter(([, q]) => q > 0).forEach(([id, qty]) => {
      let found = false;
      DEMAND_SECTIONS.forEach((sec) => { if (sec.items.some((i) => i.id === id)) { grouped[sec.id].items.push([id, qty]); found = true; } });
      if (!found) grouped["_other"].items.push([id, qty]);
    });
    return Object.entries(grouped).filter(([, g]) => g.items.length > 0);
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;

  // Count pending per outlet for pills
  const outletCounts = {};
  OUTLETS.forEach((o) => { outletCounts[o.id] = allPending.filter((d) => d.outlet_id === o.id).length; });

  return (
    <div id="print-dispatch">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Dispatch Verification</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>Tick each item after loading in transport</p></div>
        <div style={{ display: "flex", gap: 6 }}><button onClick={load} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 12, fontWeight: 600, color: "#777", cursor: "pointer", fontFamily: "inherit" }}>🔄</button><PrintBtn sectionId="print-dispatch" title="Dispatch Challan" /></div>
      </div>

      {/* Outlet filter pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => setSelOutlet(null)} style={{ padding: "7px 14px", borderRadius: 20, fontSize: 12, fontWeight: !selOutlet ? 700 : 500, border: !selOutlet ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selOutlet ? "#1A1A1A" : "#fff", color: !selOutlet ? "#fff" : "#888" }}>All ({allPending.length})</button>
        {OUTLETS.map((o) => (<button key={o.id} onClick={() => setSelOutlet(o.id)} style={{ padding: "7px 14px", borderRadius: 20, fontSize: 12, fontWeight: selOutlet === o.id ? 700 : 500, border: selOutlet === o.id ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selOutlet === o.id ? "#1A1A1A" : "#fff", color: selOutlet === o.id ? "#fff" : "#888", display: "flex", alignItems: "center", gap: 4 }}>{o.short} {outletCounts[o.id] > 0 && <span style={{ padding: "1px 6px", borderRadius: 10, background: selOutlet === o.id ? "rgba(255,255,255,0.2)" : "#FFFBEB", color: selOutlet === o.id ? "#fff" : "#B45309", fontSize: 10, fontWeight: 800 }}>{outletCounts[o.id]}</span>}</button>))}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1, background: "#FFFBEB", borderRadius: 12, padding: "14px 16px", border: "1px solid #FDE68A", textAlign: "center" }}><div style={{ fontSize: 10, color: "#92400E", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Pending</div><div style={{ fontSize: 24, fontWeight: 800, color: "#B45309" }}>{pending.length}</div></div>
        <div style={{ flex: 1, background: "#F0FDF4", borderRadius: 12, padding: "14px 16px", border: "1px solid #BBF7D0", textAlign: "center" }}><div style={{ fontSize: 10, color: "#166534", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Dispatched</div><div style={{ fontSize: 24, fontWeight: 800, color: "#16A34A" }}>{done.length}</div></div>
      </div>

      {pending.length === 0 && <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "40px 20px", textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 8 }}>✓</div><div style={{ color: "#999" }}>{selOutlet ? `No pending for ${OUTLETS.find((o) => o.id === selOutlet)?.name}` : "All dispatched for today"}</div></div>}

      {pending.map((order) => {
        const outlet = OUTLETS.find((o) => o.id === order.outlet_id);
        const itemEntries = order.items ? Object.entries(order.items).filter(([, q]) => q > 0) : [];
        const hasItems = itemEntries.length > 0;
        const checkedCount = hasItems ? itemEntries.filter(([id]) => isChecked(order.id, id)).length : 0;
        const allChecked = hasItems && checkedCount === itemEntries.length;
        const categories = hasItems ? getItemsByCategory(order.items) : [];

        return (
          <div key={order.id} style={{ background: "#fff", borderRadius: 14, border: `1px solid ${allChecked ? "#BBF7D0" : "#E8E8E4"}`, marginBottom: 14, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #F0F0EC" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 15 }}>{outlet?.name || order.outlet_id}</strong>
                <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: order.type === "photo" ? "#EFF6FF" : "#FFFBEB", color: order.type === "photo" ? "#2563EB" : "#B45309" }}>{order.type === "photo" ? "📷" : "✏️"}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#BBB" }}>{new Date(order.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div>
                {hasItems && <div style={{ fontSize: 11, fontWeight: 700, color: allChecked ? "#16A34A" : "#B45309" }}>✓ {checkedCount}/{itemEntries.length}</div>}
              </div>
            </div>

            {order.note && <div style={{ padding: "8px 18px", fontSize: 12, color: "#888", borderBottom: "1px solid #F0F0EC" }}>📝 {order.note}</div>}

            {/* Category-wise items */}
            {hasItems ? categories.map(([catId, cat]) => {
              const catKey = `${order.id}_${catId}`;
              const isOpen = expandedCat[catKey] !== false; // default open
              const catChecked = cat.items.filter(([id]) => isChecked(order.id, id)).length;
              const catTotal = cat.items.length;
              return (
                <div key={catKey}>
                  <div onClick={() => toggleCat(catKey)} style={{ padding: "10px 18px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", background: cat.bg, borderBottom: "1px solid #F0F0EC" }}>
                    <span style={{ fontSize: 16 }}>{cat.emoji}</span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: cat.color }}>{cat.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: catChecked === catTotal ? "#16A34A" : "#999" }}>{catChecked}/{catTotal}</span>
                    <button onClick={(e) => { e.stopPropagation(); checkAllCat(order.id, cat.items); }} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #E0E0DC", background: "#fff", fontSize: 10, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>{catChecked === catTotal ? "✕" : "✓ All"}</button>
                    <span style={{ color: "#CCC", transform: isOpen ? "rotate(180deg)" : "", transition: "0.2s", fontSize: 12 }}>▾</span>
                  </div>
                  {isOpen && <div style={{ padding: "4px 14px 8px" }}>
                    {cat.items.map(([id, qty]) => {
                      const isDone = isChecked(order.id, id);
                      const bkItem = BK_ITEMS.find((b) => b.id === id);
                      return (
                        <div key={id} onClick={() => toggle(order.id, id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 8px", borderRadius: 10, marginBottom: 2, cursor: "pointer", background: isDone ? "#F0FDF4" : "transparent", transition: "all 0.15s" }}>
                          <div style={{ width: 22, height: 22, borderRadius: 5, border: isDone ? "2px solid #16A34A" : "2px solid #D0D0CC", background: isDone ? "#16A34A" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            {isDone && <span style={{ color: "#fff", fontSize: 13, fontWeight: 800 }}>✓</span>}
                          </div>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: isDone ? "#16A34A" : "#1A1A1A", textDecoration: isDone ? "line-through" : "none" }}>{bkItem?.name || id}</span>
                          <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: isDone ? "#16A34A" : "#B45309", minWidth: 40, textAlign: "right" }}>{qty}</span>
                        </div>
                      );
                    })}
                  </div>}
                </div>
              );
            }) : <div style={{ padding: "14px 18px", fontSize: 12, color: "#888" }}>📷 Photo order — verify manually.</div>}

            {/* Dispatch button */}
            <div style={{ padding: "12px 18px", borderTop: "1px solid #F0F0EC" }}>
              <button onClick={() => doDispatch(order.id)} disabled={dispatching === order.id || (hasItems && !allChecked)}
                style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: (hasItems && !allChecked) ? "#D0D0CC" : dispatching === order.id ? "#D0D0CC" : "#16A34A", color: "#fff", fontWeight: 800, fontSize: 15, cursor: (hasItems && !allChecked) || dispatching === order.id ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                {dispatching === order.id ? "⏳ Dispatching..." : !hasItems || allChecked ? `🚚 Dispatch to ${outlet?.name || order.outlet_id}` : `Verify ${itemEntries.length - checkedCount} more items`}
              </button>
            </div>
          </div>
        );
      })}

      {done.length > 0 && (<div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "#16A34A" }}>✅ Dispatched Today</div>
        {done.map((order) => { const outlet = OUTLETS.find((o) => o.id === order.outlet_id); return (
          <div key={order.id} style={{ background: "#F0FDF4", borderRadius: 12, border: "1px solid #BBF7D0", padding: "12px 16px", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 12, fontWeight: 700 }}>{outlet?.name || order.outlet_id}</span><span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: "#DCFCE7", color: "#16A34A" }}>DISPATCHED</span></div>
            <span style={{ fontSize: 11, color: "#999" }}>{new Date(order.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        ); })}
      </div>)}
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
const genSales = () => { const d = {}; OUTLETS.forEach((o) => { const it = {}; MENU_ITEMS.forEach((m) => { it[m.id] = { d: 0, a: 0 }; }); d[o.id] = it; }); return d; };
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
  // Purchase state
  const [purchases, setPurchases] = useState([{ item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]);
  const [billImages, setBillImages] = useState({}); const [purchaseNote, setPurchaseNote] = useState(""); const [paymentMode, setPaymentMode] = useState("cash");
  const oData = OUTLETS.find((o) => o.id === outlet); const tSubs = subs.filter((s) => s.outlet === outlet && s.date === today()); const reset = () => { setImages({}); setDraft({}); setNote(""); setExpSec(null); setErr(null); };
  const resetPurchase = () => { setPurchases([{ item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]); setBillImages({}); setPurchaseNote(""); setPaymentMode("cash"); setErr(null); };
  const addPurchaseRow = () => setPurchases((p) => [...p, { item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]);
  const updatePurchase = (idx, field, val) => setPurchases((p) => p.map((r, i) => i === idx ? { ...r, [field]: val } : r));
  const removePurchaseRow = (idx) => setPurchases((p) => p.filter((_, i) => i !== idx));

  const submit = async (type) => {
    setSaving(true); setErr(null);
    try {
      if (type === "closing") {
        const result = await api.submitClosingStock({ outlet_id: outlet, items: closing });
        const e = { ...result, type: "closing", outlet, time: timeNow(), date: today() };
        setSubs((p) => [e, ...p]); setLast(e);
      } else {
        // Create demand record
        const result = await api.createDemand({ outlet_id: outlet, type, items: (type === "manual" || type === "wastage") ? draft : {}, note });
        const e = { ...result, type, outlet, time: timeNow(), date: today() };
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

  if (screen === "pick") return (<div><div style={{ textAlign: "center", marginBottom: 30 }}><div style={{ fontSize: 40, marginBottom: 6 }}>🍽️</div><h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Select Outlet</h2></div>{OUTLETS.map((o) => (<button key={o.id} onClick={() => { setOutlet(o.id); setScreen("home"); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 14, border: "1px solid #E8E8E4", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 12, marginBottom: 8, color: "#1A1A1A" }}><span style={{ fontSize: 24 }}>🏪</span><span style={{ flex: 1 }}>{o.name}</span><span style={{ color: "#CCC" }}>→</span></button>))}{onBack && <button onClick={onBack} style={{ width: "100%", marginTop: 12, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button></div>);

  if (screen === "done" && last) return (<div style={{ textAlign: "center", padding: "40px 0" }}><div style={{ fontSize: 64, marginBottom: 12 }}>✅</div><h3 style={{ fontSize: 20, fontWeight: 800, color: "#166534", margin: "0 0 4px" }}>{last.type === "closing" ? "Closing Stock Submitted!" : last.type === "wastage" ? "Wastage Recorded!" : last.type === "purchase" ? "Purchase Recorded!" : "Demand Submitted!"}</h3><p style={{ color: "#16A34A", margin: "0 0 24px" }}>{oData?.name} — {last.time}</p><button onClick={() => waMsg(last)} style={{ padding: "14px 32px", borderRadius: 14, border: "none", background: "#25D366", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}>💬 Share on WhatsApp</button><br /><button onClick={() => setScreen("home")} style={{ padding: "12px 32px", borderRadius: 14, border: "1px solid #E0E0DC", background: "#fff", color: "#1A1A1A", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }}>← Back to Home</button></div>);

  if (screen === "home") return (<div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}><div><div style={{ fontSize: 16, fontWeight: 800 }}>🏪 {oData?.name}</div><div style={{ fontSize: 11, color: "#999" }}>{today()}</div></div><div style={{ display: "flex", gap: 6 }}>{tSubs.length > 0 && <span style={{ padding: "4px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>✅ {tSubs.length} sent</span>}<button onClick={() => { setOutlet(null); setScreen("pick"); }} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 11, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>Switch</button></div></div>
    {[{ s: "manual", icon: "✏️", t: "Demand — Manual Entry", sub: "Enter quantity for each item", tag: "⚡ Daily", tagC: "#B45309", bg: "linear-gradient(135deg,#FFFBEB,#FFF7ED)", bc: "#FDE68A" }, { s: "purchase", icon: "🧾", t: "Cash Purchase", sub: "Record local purchase with bill", bg: "linear-gradient(135deg,#FFF7ED,#FFFBEB)", bc: "#FED7AA" }, { s: "wastage", icon: "🗑️", t: "Wastage / Disposal", sub: "Record expired or disposed items", tag: "⚠️ Audit trail", tagC: "#991B1B", bg: "linear-gradient(135deg,#FEF2F2,#FFF1F2)", bc: "#FECACA" }, { s: "close", icon: "📊", t: "Closing Stock", sub: "End of day — stock remaining", tag: "⚠️ Must fill daily", tagC: "#991B1B", bg: "linear-gradient(135deg,#EFF6FF,#F0F9FF)", bc: "#BFDBFE" }].map((opt) => (<button key={opt.s} onClick={() => { reset(); resetPurchase(); setClosing({}); setScreen(opt.s); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 16, border: `1.5px solid ${opt.bc}`, background: opt.bg, textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}><div style={{ fontSize: 34 }}>{opt.icon}</div><div><div style={{ fontSize: 16, fontWeight: 800 }}>{opt.t}</div><div style={{ fontSize: 12, color: "#888" }}>{opt.sub}</div>{opt.tag && <div style={{ fontSize: 10, fontWeight: 700, color: opt.tagC, marginTop: 3 }}>{opt.tag}</div>}</div></button>))}
    {onBack && <button onClick={onBack} style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>
  </div>);

  if (screen === "wastage") { const ft = Object.values(draft).filter((v) => v > 0).length; return (<div><SavingOverlay />
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>🗑️ Wastage / Disposal</div>{ft > 0 && <span style={{ padding: "3px 10px", borderRadius: 6, background: "#FEF2F2", color: "#DC2626", fontSize: 11, fontWeight: 700 }}>{ft} items</span>}</div>
    <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 14 }}>⚠️ Record every item that was thrown away, expired, or disposed. This is tracked for audit.</div>
    {DEMAND_SECTIONS.filter((sec) => sec.id === "food" || sec.id === "vegetable" || sec.id === "grocery").map((sec) => { const isO = expSec === sec.id, fl = sec.items.filter((i) => draft[i.id] > 0).length; return (<div key={sec.id} style={{ borderRadius: 14, border: `1px solid ${sec.border}`, overflow: "hidden", background: "#fff", marginBottom: 6 }}><div onClick={() => setExpSec(isO ? null : sec.id)} style={{ padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: isO ? sec.bg : "#fff" }}><span style={{ fontSize: 22 }}>{sec.emoji}</span><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{sec.titleHi}</div><div style={{ fontSize: 10, color: "#999" }}>{sec.items.length} items</div></div>{fl > 0 && <span style={{ padding: "2px 8px", borderRadius: 6, background: "#FEF2F2", color: "#DC2626", fontSize: 11, fontWeight: 800 }}>{fl}</span>}<span style={{ color: "#CCC", transform: isO ? "rotate(180deg)" : "", transition: "0.2s" }}>▾</span></div>{isO && <div style={{ padding: "6px 12px 12px" }}>{sec.items.map((item) => (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: draft[item.id] > 0 ? "#FEF2F2" : "#FAFAF8", marginBottom: 3 }}><span style={{ flex: 1, fontSize: 13 }}>{item.name}</span><input type="number" inputMode="numeric" min="0" placeholder="0" value={draft[item.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 56, padding: "6px", borderRadius: 8, border: `1px solid ${draft[item.id] > 0 ? "#FECACA" : sec.border}`, background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} /></div>))}</div>}</div>); })}
    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for wastage (expired, dropped, etc.)..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "8px 0 12px" }} />
    <ErrBar />
    <button onClick={() => submit("wastage")} disabled={ft === 0 || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: ft > 0 && !saving ? "#DC2626" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: ft > 0 && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳ Submitting..." : `🗑️ Record Wastage (${ft} items)`}</button>
  </div>); }

  if (screen === "manual") { const ft = Object.values(draft).filter((v) => v > 0).length; return (<div><SavingOverlay /><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>✏️ Manual Entry</div>{ft > 0 && <span style={{ padding: "3px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>{ft}</span>}</div>{DEMAND_SECTIONS.map((sec) => { const isO = expSec === sec.id, fl = sec.items.filter((i) => draft[i.id] > 0).length; return (<div key={sec.id} style={{ borderRadius: 14, border: `1px solid ${sec.border}`, overflow: "hidden", background: "#fff", marginBottom: 6 }}><div onClick={() => setExpSec(isO ? null : sec.id)} style={{ padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: isO ? sec.bg : "#fff" }}><span style={{ fontSize: 22 }}>{sec.emoji}</span><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{sec.titleHi}</div><div style={{ fontSize: 10, color: "#999" }}>{sec.items.length} items</div></div>{fl > 0 && <span style={{ padding: "2px 8px", borderRadius: 6, background: sec.bg, color: sec.color, fontSize: 11, fontWeight: 800 }}>{fl}</span>}<span style={{ color: "#CCC", transform: isO ? "rotate(180deg)" : "", transition: "0.2s" }}>▾</span></div>{isO && <div style={{ padding: "6px 12px 12px" }}>{sec.items.map((item) => (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: draft[item.id] > 0 ? sec.bg : "#FAFAF8", marginBottom: 3 }}><span style={{ flex: 1, fontSize: 13 }}>{item.name}</span><input type="number" inputMode="numeric" min="0" placeholder="0" value={draft[item.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 56, padding: "6px", borderRadius: 8, border: `1px solid ${sec.border}`, background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} /><span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.unit}</span></div>))}</div>}</div>); })}<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any extra note..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "8px 0 12px" }} /><button onClick={() => submit("manual")} disabled={ft === 0} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: ft > 0 ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: ft > 0 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>✅ Submit ({ft} items)</button></div>); }

  if (screen === "purchase") {
    const validItems = purchases.filter((p) => p.item.trim() && p.amount);
    const totalAmt = validItems.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const billCount = Object.values(billImages).filter(Boolean).length;
    const canSubmit = validItems.length > 0 && billCount > 0;
    const submitPurchase = async () => {
      setSaving(true); setErr(null);
      try {
        const apiItems = validItems.map((i) => ({ item_name: i.item, quantity: Number(i.qty) || null, unit: i.unit, amount: Number(i.amount), vendor: i.vendor }));
        const result = await api.createPurchase({ items: apiItems, payment_mode: paymentMode, note: purchaseNote });
        for (const [label, base64] of Object.entries(billImages)) { if (base64) await api.uploadPurchasePhoto(result.id, base64, label); }
        const e = { ...result, type: "purchase", outlet, totalAmount: totalAmt, paymentMode, time: timeNow(), date: today() };
        setSubs((p) => [e, ...p]); setLast(e); resetPurchase(); setScreen("done");
      } catch (error) { setErr(error.message); } finally { setSaving(false); }
    };
    return (<div><SavingOverlay />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>🧾 Cash Purchase</div>{totalAmt > 0 && <span style={{ padding: "4px 12px", borderRadius: 8, background: "#FFFBEB", border: "1px solid #FDE68A", color: "#B45309", fontSize: 13, fontWeight: 800, fontFamily: "'JetBrains Mono'" }}>{fmt(totalAmt)}</span>}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Items Purchased</div>
      {purchases.map((row, idx) => (<div key={idx} style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "12px 14px", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}><input value={row.item} onChange={(e) => updatePurchase(idx, "item", e.target.value)} placeholder="Item name" style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", fontWeight: 600 }} />{purchases.length > 1 && <button onClick={() => removePurchaseRow(idx)} style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 16, cursor: "pointer" }}>✕</button>}</div>
        <div style={{ display: "flex", gap: 8 }}><div style={{ flex: 1 }}><div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Qty</div><input value={row.qty} onChange={(e) => updatePurchase(idx, "qty", e.target.value)} type="number" inputMode="decimal" placeholder="0" style={{ width: "100%", padding: "8px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 600 }} /></div><div style={{ flex: 1 }}><div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Amount (₹)</div><input value={row.amount} onChange={(e) => updatePurchase(idx, "amount", e.target.value)} type="number" inputMode="numeric" placeholder="₹0" style={{ width: "100%", padding: "8px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 700, color: "#B45309" }} /></div><div style={{ flex: 1 }}><div style={{ fontSize: 10, color: "#999", marginBottom: 3 }}>Vendor</div><input value={row.vendor} onChange={(e) => updatePurchase(idx, "vendor", e.target.value)} placeholder="Shop" style={{ width: "100%", padding: "8px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit" }} /></div></div>
      </div>))}
      <button onClick={addPurchaseRow} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "2px dashed #E0E0DC", background: "transparent", fontSize: 14, fontWeight: 700, color: "#999", cursor: "pointer", fontFamily: "inherit", marginBottom: 14 }}>+ Add Item</button>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>Payment</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{[{ id: "cash", label: "💵 Cash" }, { id: "upi", label: "📱 UPI" }, { id: "credit", label: "📒 Udhar" }].map((m) => (<button key={m.id} onClick={() => setPaymentMode(m.id)} style={{ flex: 1, padding: "10px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", border: paymentMode === m.id ? "2px solid #B45309" : "1px solid #E0E0DC", background: paymentMode === m.id ? "#FFFBEB" : "#fff", color: paymentMode === m.id ? "#B45309" : "#888" }}>{m.label}</button>))}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Bill Photo (required)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>{[{ id: "bill1", titleHi: "Bill Photo", emoji: "🧾", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" }].map((s) => (<PhotoUpload key={s.id} {...s} image={billImages[s.id]} onUpload={(img) => setBillImages((p) => ({ ...p, [s.id]: img }))} onRemove={() => setBillImages((p) => { const n = { ...p }; delete n[s.id]; return n; })} />))}</div>
      {!billCount && <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>⚠️ Bill photo is required!</div>}
      <ErrBar />
      {totalAmt > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderRadius: 12, background: "#FFFBEB", border: "1px solid #FDE68A", marginBottom: 12 }}><span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>Total</span><span style={{ fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#B45309" }}>{fmt(totalAmt)}</span></div>}
      <button onClick={submitPurchase} disabled={!canSubmit || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: canSubmit && !saving ? "#B45309" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: canSubmit && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳ Submitting..." : `🧾 Record Purchase ${totalAmt > 0 ? `— ${fmt(totalAmt)}` : ""}`}</button>
    </div>);
  }

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

      {onBack && <button onClick={onBack} style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>
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
  // Check URL for role parameter: ?role=outlet or ?role=store or ?role=owner
  const urlRole = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const role = params.get("role");
    if (role === "outlet" || role === "store" || role === "owner") return role;
    return null;
  }, []);

  const [app, setApp] = useState(urlRole || "launcher");
  const [ownerTab, setOwnerTab] = useState("activity");
  const [storeView, setStoreView] = useState("actions");

  if (app === "launcher") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 440, margin: "0 auto", padding: "40px 20px" }}><div style={{ textAlign: "center", marginBottom: 36 }}><div style={{ fontSize: 48, marginBottom: 8 }}>🍽️</div><h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 4px" }}>Ananda Cafe</h1><p style={{ fontSize: 14, color: "#999", margin: 0 }}>Operations Management System</p></div>
    {[{ id: "owner", icon: "👑", title: "Owner Dashboard", sub: "COGS, Daily P&L, Red Flags", bg: "linear-gradient(135deg, #1A1A1A, #333)", color: "#fff", subC: "rgba(255,255,255,0.6)" }, { id: "outlet", icon: "🏪", title: "Outlet Manager", sub: "Daily demand challan & closing stock", bg: "#fff", color: "#1A1A1A", border: "#E8E8E4", subC: "#888" }, { id: "store", icon: "📦", title: "Store Manager (BK)", sub: "Ration store issuance records", bg: "#fff", color: "#1A1A1A", border: "#E8E8E4", subC: "#888" }].map((a) => (<button key={a.id} onClick={() => setApp(a.id)} style={{ width: "100%", padding: "22px 24px", borderRadius: 18, background: a.bg, border: a.border ? `1px solid ${a.border}` : "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 12, display: "flex", alignItems: "center", gap: 16 }}><div style={{ fontSize: 36 }}>{a.icon}</div><div><div style={{ fontSize: 18, fontWeight: 800, color: a.color }}>{a.title}</div><div style={{ fontSize: 13, color: a.subC }}>{a.sub}</div></div></button>))}
  </div></div>);

  if (app === "owner") return (<div style={PAGE}>{FONT}
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 50 }}>{!urlRole && <BackBtn onClick={() => setApp("launcher")} />}<div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 800 }}>👑 Owner Dashboard</div><div style={{ fontSize: 11, color: "#999" }}>Ananda Cafe</div></div></div>
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "0 18px", display: "flex", gap: 0, position: "sticky", top: 52, zIndex: 49, overflowX: "auto" }}>{[{ id: "activity", label: "🔴 Live" }, { id: "cogs", label: "📊 COGS" }, { id: "pnl", label: "💰 P&L" }, { id: "orders", label: "📋 Orders" }, { id: "kitchen", label: "🏭 BK" }, { id: "dispatch", label: "🚚 Dispatch" }, { id: "recipes", label: "📖 Recipes" }].map((t) => (<button key={t.id} onClick={() => setOwnerTab(t.id)} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: ownerTab === t.id ? 700 : 500, color: ownerTab === t.id ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: ownerTab === t.id ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>{t.label}</button>))}</div>
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 18px 40px" }}>
      {ownerTab === "activity" && <LiveActivity />}
      {ownerTab === "cogs" && <CogsDash />}
      {ownerTab === "pnl" && <DailyPnL />}
      {ownerTab === "orders" && <OutletOrders />}
      {ownerTab === "kitchen" && <BaseKitchen />}
      {ownerTab === "dispatch" && <Dispatch />}
      {ownerTab === "recipes" && <RecipesPanel />}
    </div>
  </div>);

  if (app === "outlet") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 500, margin: "0 auto", padding: "24px 18px" }}><OutletMgr onBack={urlRole ? null : () => setApp("launcher")} /></div></div>);
  if (app === "store") return (<div style={PAGE}>{FONT}
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 50 }}>{!urlRole && <BackBtn onClick={() => setApp("launcher")} />}<div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 800 }}>📦 Store Manager (BK)</div><div style={{ fontSize: 11, color: "#999" }}>Ananda Cafe</div></div></div>
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "0 18px", display: "flex", gap: 0, position: "sticky", top: 52, zIndex: 49, overflowX: "auto" }}>{[{ id: "actions", label: "📋 Actions" }, { id: "live", label: "🔴 Live" }, { id: "orders", label: "📋 Orders" }, { id: "bk", label: "🏭 BK" }, { id: "dispatch", label: "🚚 Dispatch" }].map((t) => (<button key={t.id} onClick={() => setStoreView(t.id)} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: storeView === t.id ? 700 : 500, color: storeView === t.id ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: storeView === t.id ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>{t.label}</button>))}</div>
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 18px 40px" }}>
      {storeView === "actions" && <StoreMgr onBack={urlRole ? null : () => setApp("launcher")} />}
      {storeView === "live" && <LiveActivity />}
      {storeView === "orders" && <OutletOrders />}
      {storeView === "bk" && <BaseKitchen />}
      {storeView === "dispatch" && <Dispatch />}
    </div>
  </div>);
  return null;
}
