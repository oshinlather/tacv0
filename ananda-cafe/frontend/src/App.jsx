import { useState, useMemo, useCallback, useEffect } from "react";
import api from "./api";

/* ═══════════════════════════════════════════════════════════════════════════
   ANANDA CAFE — COMPLETE SYSTEM
   Launcher → Owner Dashboard (COGS + P&L) | Outlet Manager | Store Manager
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── SHARED DATA ────────────────────────────────────────────────────────────
// Global user ref — set by AnandaCafe on login, read by child components
let _currentUser = null;
const getCurrentUser = () => _currentUser;

const OUTLETS = [
  { id: "sec23", name: "Sector 23", short: "S-23" },
  { id: "sec31", name: "Sector 31", short: "S-31" },
  { id: "sec56", name: "Sector 56", short: "S-56" },
  { id: "elan", name: "Elan (Franchise)", short: "ELAN" },
];
const today = () => { const d = new Date(); const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000); return ist.toISOString().split("T")[0]; };
const istNow = () => { const d = new Date(); return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000); };
const istDateAgo = (days) => { const ist = istNow(); ist.setDate(ist.getDate() - days); return ist.toISOString().split("T")[0]; };
const istHour = () => { const d = new Date(); const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000); return ist.getHours(); };
// Demand windows: Night (9PM-1AM) and Day (11AM-4PM)
const getDemandWindow = () => {
  const h = istHour();
  if (h >= 21 || h < 1) return { id: "night", label: "🌙 Night Order", active: true };
  if (h >= 11 && h < 16) return { id: "day", label: "☀️ Day Order", active: true };
  return { id: "anytime", label: "📋 Manual Entry", active: true };
};
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
      { id: "sambhar", name: "Sambhar", unit: "Kg" },
      { id: "red_chutney", name: "Red Chutney", unit: "Kg" },
      { id: "coconut_crush", name: "Coconut Crush", unit: "Kg" },
      { id: "pineapple_halwa", name: "Pineapple Halwa", unit: "Kg" },
      { id: "podi_masala", name: "Podi Masala", unit: "Kg" },
      { id: "vada_batter", name: "Vada Batter", unit: "Kg" },
      { id: "rawa_mix", name: "Rawa Mix", unit: "Kg" },
      { id: "roasted_peanuts", name: "Roasted Peanuts", unit: "Kg" },
      { id: "sevya_payasam", name: "Sevya Payasam", unit: "Kg" },
      { id: "rasam", name: "Rasam", unit: "Kg" },
      { id: "onion_masala", name: "Onion Masala", unit: "Kg" },
      { id: "dosa_batter", name: "Dosa Batter", unit: "Batch" },
      { id: "roasted_chana", name: "Roasted Chana", unit: "Kg" },
      { id: "garlic_paste", name: "Garlic Paste", unit: "Kg" },
      { id: "idli_batter", name: "Idli Batter", unit: "Batch" },
      { id: "sona_masoori_rice", name: "Sona Masoori Rice", unit: "Kg" },
      { id: "white_chutney", name: "White Chutney", unit: "Kg" },
      { id: "tadka", name: "Tadka", unit: "Kg" },
      { id: "roasted_karipatta", name: "Roasted Karipatta", unit: "Kg" },
    ]},
  { id: "vegetable", titleHi: "Vegetables", emoji: "🥬", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0",
    items: [
      { id: "onions", name: "Onions", unit: "Kg" },
      { id: "tomatoes", name: "Tomatoes", unit: "Kg" },
      { id: "green_chillies", name: "Green Chillies (Hari Mirch)", unit: "Gm" },
      { id: "coriander_leaves", name: "Coriander Leaves (Dhaniya Patta)", unit: "Gm" },
      { id: "curry_leaves", name: "Curry Leaves (Kari Patta)", unit: "Gm" },
      { id: "banana_leaves", name: "Banana Leaves", unit: "Pcs" },
      { id: "ginger", name: "Ginger", unit: "Gm" },
      { id: "coconut", name: "Coconut", unit: "Pcs" },
      { id: "carrot", name: "Carrot", unit: "Gm" },
      { id: "beans", name: "Beans", unit: "Gm" },
      { id: "potato", name: "Potato (Aloo)", unit: "Kg" },
      { id: "garlic", name: "Garlic", unit: "Gm" },
      { id: "mint", name: "Mint (Pudina)", unit: "Gm" },
      { id: "lemon", name: "Lemon", unit: "Gm" },
      { id: "staff_veg", name: "Staff Veg", unit: "Kg" },
      { id: "anar", name: "Anar", unit: "Pcs" },
      { id: "drumstick", name: "Drumstick", unit: "Kg" },
      { id: "pineapple", name: "Pineapple", unit: "Pcs" },
      { id: "petha", name: "Petha", unit: "Kg" },
    ]},
  { id: "masala", titleHi: "Masala & Spices", emoji: "🌶️", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA",
    items: [
      { id: "deggi_mirch", name: "Deggi Mirch", unit: "Kg" },
      { id: "garam_masala", name: "Garam Masala", unit: "Kg" },
      { id: "hing_powder", name: "Hing Powder", unit: "Kg" },
      { id: "dhaniya_powder", name: "Dhaniya Powder", unit: "Pkt" },
      { id: "kitchen_king", name: "Kitchen King", unit: "Pkt" },
      { id: "chat_masala", name: "Chat Masala", unit: "Pkt" },
      { id: "haldi_powder", name: "Haldi Powder", unit: "Pkt" },
      { id: "ilaychi", name: "Hari Ilaychi", unit: "Gm" },
      { id: "salt", name: "Tata Salt", unit: "Kg" },
      { id: "black_salt", name: "Black Salt", unit: "Gm" },
      { id: "red_chilli_powder", name: "Red Chilli Powder", unit: "Kg" },
      { id: "sambhar_masala_777", name: "Sambhar Masala 777", unit: "Pkt" },
      { id: "amchoor_powder", name: "Amchoor Powder", unit: "Kg" },
      { id: "long", name: "Long (Clove)", unit: "Gm" },
      { id: "kasturi_methi", name: "Kasturi Methi", unit: "Pkt" },
      { id: "kesar", name: "Kesar", unit: "Gm" },
      { id: "methi_dana", name: "Methi Dana", unit: "Gm" },
    ]},
  { id: "grocery", titleHi: "Grocery & Staples", emoji: "🛒", color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA",
    items: [
      { id: "dhaniya_whole", name: "Dhaniya Whole", unit: "Gm" },
      { id: "golden_sela_rice", name: "Rice (Golden Sela)", unit: "Kg" },
      { id: "atta", name: "Atta", unit: "Kg" },
      { id: "fortune_refined", name: "Fortune Refined Oil", unit: "Tin" },
      { id: "desi_ghee", name: "Desi Ghee", unit: "Tin" },
      { id: "staff_dal", name: "Staff Dal", unit: "Kg" },
      { id: "whole_red_chilli", name: "Whole Red Chilli", unit: "Gm" },
      { id: "achar", name: "Achar", unit: "Box" },
      { id: "chhole", name: "Chhole", unit: "Kg" },
      { id: "rajma", name: "Rajma", unit: "Kg" },
      { id: "chana_dal", name: "Chana Dal", unit: "Kg" },
      { id: "sarson_tel", name: "Sarson Tel", unit: "Kg" },
      { id: "meetha_soda", name: "Meetha Soda", unit: "Gm" },
      { id: "soya_badi", name: "Soya Badi", unit: "Kg" },
      { id: "filter_coffee_powder", name: "Filter Coffee Powder", unit: "Pkt" },
      { id: "chai_patti", name: "Chai Patti", unit: "Pkt" },
      { id: "arhar_dal", name: "Arhar Dal", unit: "Kg" },
      { id: "urad_daal_whole", name: "Urad Daal Whole", unit: "Kg" },
      { id: "peanuts", name: "Peanuts (Raw)", unit: "Kg" },
      { id: "semiyan", name: "Semiyan", unit: "Kg" },
      { id: "rice_powder", name: "Rice Powder", unit: "Kg" },
      { id: "safed_til", name: "Safed Til", unit: "Kg" },
      { id: "imli", name: "Imli", unit: "Kg" },
      { id: "gur", name: "Gur", unit: "Kg" },
      { id: "pista", name: "Pista", unit: "Gm" },
      { id: "almond", name: "Almond", unit: "Gm" },
      { id: "kishmish", name: "Kishmish", unit: "Gm" },
      { id: "papad_777", name: "777 Papad", unit: "Pkt" },
      { id: "water", name: "Water", unit: "Ltr" },
      { id: "milk", name: "Milk", unit: "Ltr" },
      { id: "milkmaid", name: "Milkmaid", unit: "Kg" },
    ]},
  { id: "packaging", titleHi: "Packaging & Disposal", emoji: "📦", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE",
    items: [
      { id: "container_50ml", name: "50ML Container", unit: "Pkt" },
      { id: "container_100ml", name: "100ML Container", unit: "Pkt" },
      { id: "container_250ml", name: "250ML Container", unit: "Pkt" },
      { id: "container_300ml", name: "300ML Container", unit: "Pkt" },
      { id: "container_500ml", name: "500ML Container", unit: "Pkt" },
      { id: "podi_idli_container", name: "Podi Idli Container", unit: "Pkt" },
      { id: "silver_container", name: "Silver Container", unit: "Pkt" },
      { id: "vada_lifafa", name: "Vada Lifafa", unit: "Pcs" },
      { id: "dosa_box_small", name: "Dosa Box Small", unit: "Pkt" },
      { id: "dosa_box_big", name: "Dosa Box Big", unit: "Pkt" },
      { id: "biopoly_16x20", name: "16*20 Biopolythene", unit: "Pkt" },
      { id: "biopoly_13x16", name: "13*16 Biopolythene", unit: "Pkt" },
      { id: "bio_garbage_bag", name: "Bio Garbage Bag Big Size", unit: "Kg" },
      { id: "printer_roll", name: "Printer Roll", unit: "Pcs" },
      { id: "bio_spoon", name: "Bio Spoon", unit: "Pkt" },
      { id: "wooden_plates", name: "Wooden Plates", unit: "Pcs" },
      { id: "paper_bowl", name: "Paper Bowl", unit: "Pkt" },
      { id: "filter_coffee_glass", name: "Filter Coffee Glass", unit: "Pkt" },
      { id: "chhachh_glass", name: "Masala Chhachh Glass", unit: "Pkt" },
      { id: "filter_coffee_pkg", name: "Filter Coffee Packaging", unit: "Pkt" },
      { id: "chhachh_pkg", name: "Masala Chhachh Packaging", unit: "Pkt" },
      { id: "stirrer", name: "Stirrer", unit: "Pkt" },
      { id: "clean_wrap", name: "Clean Wrap", unit: "Bundle" },
      { id: "tissues", name: "Tissues", unit: "Pkt" },
      { id: "chef_cap", name: "Chef Cap", unit: "Pkt" },
      { id: "butter_paper", name: "Butter Paper", unit: "Pkt" },
      { id: "tape", name: "Tape", unit: "Bundle" },
      { id: "hand_gloves", name: "Hand Gloves", unit: "Pkt" },
      { id: "kitchen_wipes", name: "Kitchen Wipes", unit: "Pkt" },
      { id: "rasam_glass", name: "Rasam Glass", unit: "Pkt" },
    ]},
  { id: "cleaning", titleHi: "Cleaning", emoji: "🧹", color: "#9333EA", bg: "#FAF5FF", border: "#E9D5FF",
    items: [
      { id: "pochha", name: "Pochha", unit: "Pcs" },
      { id: "duster", name: "Duster", unit: "Pcs" },
      { id: "seek_jhadu", name: "Seek Jhadu", unit: "Pcs" },
      { id: "wiper", name: "Wiper", unit: "Pcs" },
      { id: "sarf", name: "Surf", unit: "Pkt" },
      { id: "bartan_sabun", name: "Bartan Dhone Sabun", unit: "Pcs" },
      { id: "steel_juna", name: "Steel Juna", unit: "Pcs" },
      { id: "fool_jhadu", name: "Fool Jhadu", unit: "Pcs" },
      { id: "phenyl", name: "Phenyl", unit: "Can" },
      { id: "sanitizer", name: "Sanitizer", unit: "Can" },
      { id: "hand_wash", name: "Hand Wash", unit: "Can" },
      { id: "supli", name: "Supli", unit: "Pcs" },
    ]},
  { id: "gas", titleHi: "Gas", emoji: "🔥", color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA",
    items: [
      { id: "gas_cylinder", name: "Gas Cylinder", unit: "Pcs" },
    ]},
];

// Closing stock = all demand items (dynamic from master data)
const CLOSING_HIDDEN = new Set(["plain_idli", "butter_idli", "podi_idli", "dosa", "rawa_mix_item", "vada", "upma", "boiled_rice", "lemon_rice", "tomato_rice", "curd_rice"]);
const CLOSING_STOCK = DEMAND_SECTIONS.flatMap((sec) => sec.items.filter((i) => !CLOSING_HIDDEN.has(i.id)).map((i) => ({ id: `cs_${i.id}`, name: i.name, unit: i.unit, section: sec.id, sectionName: sec.titleHi })));

// ─── STYLES ─────────────────────────────────────────────────────────────────
const FONT = <><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" /><style dangerouslySetInnerHTML={{ __html: "input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield;appearance:textfield}" }} /></>;
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
// ═════════════════════════════════════════════════════════════════════════════
//  ORDER & DISPATCH HISTORY — Last 30 days
// ═════════════════════════════════════════════════════════════════════════════
const OrderDispatchHistory = () => {
  const [historyTab, setHistoryTab] = useState("demands"); // demands, orders, dispatches
  const [challans, setChallans] = useState([]);
  const [demands, setDemands] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const outletName = (id) => OUTLETS.find(o => o.id === id)?.name || id;
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const itemLabel = (id) => id.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  const toIST = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
    const h = ist.getHours(), m = ist.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  useEffect(() => {
    setLoading(true);
    const thirtyDaysAgo = istDateAgo(30);
    Promise.all([
      api.getChallanHistory().catch(() => []),
      api.getDispatchHistory().catch(() => []),
      api.getOrders({ from: thirtyDaysAgo }).catch(() => []),
    ]).then(([c, disp, dem]) => {
      setChallans(c || []);
      setDispatches(disp || []);
      // Filter demands: manual type, submitted/issued/fulfilled, last 30 days
      setDemands((dem || []).filter(d => d.type === "manual" && d.status !== "draft").sort((a, b) => (b.submitted_at || b.date || "").localeCompare(a.submitted_at || a.date || "")));
    }).finally(() => setLoading(false));
  }, []);

  const downloadCSV = (rows, filename) => {
    const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const exportDemandCSV = () => {
    const rows = [["Date", "Outlet", "Slot", "Status", "Item", "Qty"]];
    demands.forEach(d => {
      Object.entries(d.items || {}).forEach(([id, qty]) => {
        if (qty > 0) rows.push([d.date, outletName(d.outlet_id), d.demand_slot || "", d.status, itemLabel(id), r2(qty)]);
      });
    });
    downloadCSV(rows, "demand_challans_history.csv");
  };

  const exportChallanCSV = () => {
    const rows = [["Order #", "Date", "Status", "Vendor", "Item", "Unit", "Req", "Stock", "Order Qty"]];
    challans.forEach(po => {
      Object.entries(po.items || {}).forEach(([id, item]) => {
        rows.push([po.order_number, po.date, po.status, po.notes || "", item.name, item.unit, item.rm_qty, item.current_stock, r2(item.order_qty)]);
      });
    });
    downloadCSV(rows, "order_challans_history.csv");
  };

  const exportDispatchCSV = () => {
    const rows = [["Date", "Outlet", "Slot", "Status", "Item", "Qty"]];
    dispatches.forEach(d => {
      const items = d.dispatch_items || d.items || {};
      Object.entries(items).forEach(([id, qty]) => {
        if (qty > 0) rows.push([d.date, outletName(d.outlet_id), d.demand_slot || "", d.status, itemLabel(id), r2(qty)]);
      });
    });
    downloadCSV(rows, "dispatch_challans_history.csv");
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading history...</div>;

  const tabs = [
    { id: "demands", label: "📋 Demand", count: demands.length },
    { id: "orders", label: "🛒 Order", count: challans.length },
    { id: "dispatches", label: "🚚 Dispatch", count: dispatches.length },
  ];
  const exportFn = historyTab === "demands" ? exportDemandCSV : historyTab === "orders" ? exportChallanCSV : exportDispatchCSV;
  const exportLabel = historyTab === "demands" ? "Demand Challans" : historyTab === "orders" ? "Order Challans" : "Dispatch Challans";

  return (<div>
    <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 14px" }}>📜 Order & Dispatch History (30 days)</h3>
    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => { setHistoryTab(t.id); setExpandedId(null); }} style={{ flex: 1, padding: "10px 6px", borderRadius: 10, border: historyTab === t.id ? "none" : "1px solid #E0E0DC", background: historyTab === t.id ? "#1A1A1A" : "#fff", color: historyTab === t.id ? "#fff" : "#888", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>{t.label} ({t.count})</button>
      ))}
    </div>

    <button onClick={exportFn} style={{ width: "100%", padding: "10px", borderRadius: 10, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", marginBottom: 14 }}>
      📥 Export CSV — {exportLabel}
    </button>

    {/* ── DEMAND CHALLANS (outlet manual demands) ── */}
    {historyTab === "demands" && (<>
      {demands.length === 0 && <div style={{ textAlign: "center", padding: 30, color: "#999" }}>No demands in last 30 days</div>}
      {demands.map(d => {
        const isExp = expandedId === d.id;
        const itemList = Object.entries(d.items || {}).filter(([, q]) => q > 0);
        const statusColor = d.status === "submitted" ? "#B45309" : d.status === "issued" ? "#2563EB" : d.status === "fulfilled" ? "#16A34A" : "#888";
        const statusBg = d.status === "submitted" ? "#FFFBEB" : d.status === "issued" ? "#EFF6FF" : d.status === "fulfilled" ? "#F0FDF4" : "#F5F5F3";
        return (<div key={d.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", marginBottom: 8, overflow: "hidden" }}>
          <div onClick={() => setExpandedId(isExp ? null : d.id)} style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{outletName(d.outlet_id)}</div>
              <div style={{ fontSize: 11, color: "#999" }}>{d.date} · {d.demand_slot === "morning" ? "🌅 Morning" : d.demand_slot === "evening" ? "🌇 Evening" : "—"} · {itemList.length} items</div>
              <div style={{ fontSize: 10, color: "#BBB", marginTop: 2 }}>
                📤 {toIST(d.submitted_at)}{d.submitted_by && <span> by <strong style={{ color: "#888" }}>{d.submitted_by}</strong></span>}
                {d.dispatched_at && <span> · 🚚 {toIST(d.dispatched_at)}{d.dispatched_by && <span> by <strong style={{ color: "#888" }}>{d.dispatched_by}</strong></span>}</span>}
              </div>
            </div>
            <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: statusBg, color: statusColor }}>{d.status}</span>
            <span style={{ color: "#CCC" }}>{isExp ? "▲" : "▼"}</span>
          </div>
          {isExp && <div style={{ padding: "0 14px 12px", borderTop: "1px solid #F0F0EC" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, color: "#888", fontSize: 10 }}>Item</th>
                <th style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#2563EB", fontSize: 10 }}>Qty</th>
              </tr></thead>
              <tbody>{itemList.sort((a, b) => a[0].localeCompare(b[0])).map(([id, qty]) => (
                <tr key={id} style={{ borderBottom: "1px solid #F5F5F3" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>{itemLabel(id)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#2563EB" }}>{r2(qty)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>}
        </div>);
      })}
    </>)}

    {/* ── ORDER CHALLANS (purchase orders for inventory) ── */}
    {historyTab === "orders" && (<>
      {challans.length === 0 && <div style={{ textAlign: "center", padding: 30, color: "#999" }}>No order challans in last 30 days</div>}
      {challans.map(po => {
        const isExp = expandedId === po.id;
        const itemList = Object.entries(po.items || {});
        return (<div key={po.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", marginBottom: 8, overflow: "hidden" }}>
          <div onClick={() => setExpandedId(isExp ? null : po.id)} style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{po.order_number}</div>
              <div style={{ fontSize: 11, color: "#999" }}>{po.date} · {po.notes || ""} · {po.total_items} items</div>
              <div style={{ fontSize: 10, color: "#BBB", marginTop: 2 }}>📝 {toIST(po.created_at)}{po.created_by && <span> by <strong style={{ color: "#888" }}>{po.created_by}</strong></span>}{po.received_at && <span> · 📥 {toIST(po.received_at)}{po.received_by && <span> by <strong style={{ color: "#888" }}>{po.received_by}</strong></span>}</span>}</div>
            </div>
            <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: po.status === "pending" ? "#FFFBEB" : po.status === "received" ? "#F0FDF4" : "#F5F5F3", color: po.status === "pending" ? "#B45309" : po.status === "received" ? "#16A34A" : "#888" }}>{po.status}</span>
            <span style={{ color: "#CCC" }}>{isExp ? "▲" : "▼"}</span>
          </div>
          {isExp && <div style={{ padding: "0 14px 12px", borderTop: "1px solid #F0F0EC" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, color: "#888", fontSize: 10 }}>Item</th>
                <th style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#888", fontSize: 10 }}>Stock</th>
                <th style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#888", fontSize: 10 }}>Req</th>
                <th style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#2563EB", fontSize: 10 }}>Order Qty</th>
              </tr></thead>
              <tbody>{itemList.sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, item]) => (
                <tr key={id} style={{ borderBottom: "1px solid #F5F5F3" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>{item.name}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center", color: "#888" }}>{r2(item.current_stock)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center", color: "#888" }}>{item.rm_qty}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#2563EB" }}>{r2(item.order_qty)} {item.unit}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>}
        </div>);
      })}
    </>)}

    {/* ── DISPATCH CHALLANS ── */}
    {historyTab === "dispatches" && (<>
      {dispatches.length === 0 && <div style={{ textAlign: "center", padding: 30, color: "#999" }}>No dispatches in last 30 days</div>}
      {dispatches.map(d => {
        const isExp = expandedId === d.id;
        const items = d.dispatch_items || d.items || {};
        const itemList = Object.entries(items).filter(([, q]) => q > 0);
        return (<div key={d.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", marginBottom: 8, overflow: "hidden" }}>
          <div onClick={() => setExpandedId(isExp ? null : d.id)} style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{outletName(d.outlet_id)}</div>
              <div style={{ fontSize: 11, color: "#999" }}>{d.date} · {d.demand_slot === "morning" ? "🌅 Morning" : d.demand_slot === "evening" ? "🌇 Evening" : "—"} · {itemList.length} items</div>
            </div>
            <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "#F0FDF4", color: "#16A34A" }}>✅ Dispatched</span>
            <span style={{ color: "#CCC" }}>{isExp ? "▲" : "▼"}</span>
          </div>
          {isExp && <div style={{ padding: "0 14px 12px", borderTop: "1px solid #F0F0EC" }}>
            <div style={{ fontSize: 10, color: "#999", marginTop: 6, marginBottom: 4 }}>📤 {toIST(d.submitted_at)}{d.submitted_by && <span> by <strong>{d.submitted_by}</strong></span>} · 🚚 {toIST(d.dispatched_at)}{d.dispatched_by && <span> by <strong>{d.dispatched_by}</strong></span>}</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, color: "#888", fontSize: 10 }}>Item</th>
                <th style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#2563EB", fontSize: 10 }}>Qty</th>
              </tr></thead>
              <tbody>{itemList.sort((a, b) => a[0].localeCompare(b[0])).map(([id, qty]) => (
                <tr key={id} style={{ borderBottom: "1px solid #F5F5F3" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>{itemLabel(id)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, color: "#2563EB" }}>{r2(qty)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>}
        </div>);
      })}
    </>)}
  </div>);
};

// ═════════════════════════════════════════════════════════════════════════════
//  USERS MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════
const UsersPanel = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newRole, setNewRole] = useState("outlet_mgr");
  const [newOutlet, setNewOutlet] = useState("");
  const [saving, setSaving] = useState(false);
  const [editPinId, setEditPinId] = useState(null);
  const [editPinVal, setEditPinVal] = useState("");

  const load = () => { api.getUsers().then(setUsers).catch(() => {}).finally(() => setLoading(false)); };
  useEffect(load, []);

  const addUser = async () => {
    if (!newName || !newPhone) { alert("Name and phone required"); return; }
    setSaving(true);
    try {
      await api.createUser({ name: newName, phone: newPhone, role: newRole, outlet_id: newOutlet || null });
      setNewName(""); setNewPhone(""); setNewRole("outlet_mgr"); setNewOutlet(""); setShowAdd(false);
      load();
    } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const savePin = async (id) => {
    if (editPinVal.length !== 4) { alert("PIN must be 4 digits"); return; }
    try {
      await api.updateUser(id, { reset_pin: false, pin: editPinVal });
      setEditPinId(null); setEditPinVal("");
      load();
    } catch (e) { alert("Error: " + e.message); }
  };

  const toggleActive = async (id, active) => {
    try { await api.updateUser(id, { active: !active }); load(); } catch (e) { alert("Error: " + e.message); }
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;

  const roleLabel = (r) => r === "owner" ? "👑 Owner" : r === "store_mgr" ? "📦 Store" : "🏪 Outlet";
  const outletLabel = (id) => OUTLETS.find(o => o.id === id)?.name || id || "—";

  return (<div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0, flex: 1 }}>👥 Users ({users.length})</h3>
      <button onClick={() => setShowAdd(!showAdd)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#1A1A1A", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>+ Add User</button>
    </div>

    {showAdd && <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "16px", marginBottom: 16 }}>
      <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", marginBottom: 8, boxSizing: "border-box" }} />
      <input type="tel" placeholder="Phone (10 digits)" value={newPhone} onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", marginBottom: 8, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {[{ v: "outlet_mgr", l: "🏪 Outlet" }, { v: "store_mgr", l: "📦 Store" }, { v: "owner", l: "👑 Owner" }].map(r => (
          <button key={r.v} onClick={() => setNewRole(r.v)} style={{ flex: 1, padding: "8px", borderRadius: 8, border: newRole === r.v ? "none" : "1px solid #E0E0DC", background: newRole === r.v ? "#1A1A1A" : "#fff", color: newRole === r.v ? "#fff" : "#888", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>{r.l}</button>
        ))}
      </div>
      {newRole === "outlet_mgr" && <select value={newOutlet} onChange={(e) => setNewOutlet(e.target.value)} style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 14, fontFamily: "inherit", marginBottom: 8, boxSizing: "border-box" }}>
        <option value="">Select Outlet</option>
        {OUTLETS.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>}
      <button onClick={addUser} disabled={saving} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: "#16A34A", color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>{saving ? "⏳..." : "✅ Create User (PIN auto-generated)"}</button>
    </div>}

    {users.map(u => (
      <div key={u.id} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", padding: "14px 16px", marginBottom: 8, opacity: u.active ? 1 : 0.5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{u.name}</div>
            <div style={{ fontSize: 12, color: "#888" }}>{u.phone} · {roleLabel(u.role)}</div>
          </div>
          {editPinId === u.id ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="tel" inputMode="numeric" value={editPinVal} onChange={(e) => setEditPinVal(e.target.value.replace(/\D/g, "").slice(0, 4))} autoFocus
                style={{ width: 70, fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", textAlign: "center", letterSpacing: 4, padding: "4px", borderRadius: 6, border: "2px solid #2563EB", color: "#2563EB" }} />
              <button onClick={() => savePin(u.id)} disabled={editPinVal.length !== 4} style={{ padding: "4px 8px", borderRadius: 6, border: "none", background: editPinVal.length === 4 ? "#16A34A" : "#D0D0CC", color: "#fff", fontWeight: 700, fontSize: 11, cursor: editPinVal.length === 4 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>✓</button>
              <button onClick={() => { setEditPinId(null); setEditPinVal(""); }} style={{ padding: "4px 8px", borderRadius: 6, border: "none", background: "#F5F5F3", color: "#888", fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
            </div>
          ) : (
            <span onClick={() => { setEditPinId(u.id); setEditPinVal(u.pin); }} style={{ fontFamily: "'JetBrains Mono'", fontSize: 18, fontWeight: 800, color: "#2563EB", letterSpacing: 4, cursor: "pointer" }} title="Tap to edit PIN">{u.pin}</span>
          )}
        </div>
        {/* Outlet assignment for outlet managers */}
        {u.role === "outlet_mgr" && (
          <div style={{ marginTop: 8 }}>
            <select value={u.outlet_id || ""} onChange={async (e) => { try { await api.updateUser(u.id, { outlet_id: e.target.value || null }); load(); } catch (err) { alert("Error: " + err.message); } }}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit", color: u.outlet_id ? "#1A1A1A" : "#999", fontWeight: 600 }}>
              <option value="">No outlet assigned</option>
              {OUTLETS.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={() => { setEditPinId(u.id); setEditPinVal(u.pin); }} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #BFDBFE", background: "#EFF6FF", color: "#2563EB", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>✏️ Change PIN</button>
          <button onClick={() => toggleActive(u.id, u.active)} style={{ flex: 1, padding: "6px", borderRadius: 6, border: `1px solid ${u.active ? "#FECACA" : "#BBF7D0"}`, background: u.active ? "#FEF2F2" : "#F0FDF4", color: u.active ? "#DC2626" : "#16A34A", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>{u.active ? "🚫 Disable" : "✅ Enable"}</button>
        </div>
      </div>
    ))}
  </div>);
};

const DailyPnL = () => {
  const [selOutlet, setSelOutlet] = useState(null);
  const [selDay, setSelDay] = useState(0);
  const [pnlData, setPnlData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandSection, setExpandSection] = useState(null); // 'variable', 'fixed', 'purchase'

  const dateStr = useMemo(() => {
    return istDateAgo(selDay);
  }, [selDay]);

  const [stockData, setStockData] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getLivePnl(dateStr).catch(() => null),
      api.getStockUsage(dateStr).catch(() => null),
    ]).then(([pnl, stock]) => {
      // Merge stock-based variable cost into P&L data
      if (pnl?.pnl && stock?.outlets) {
        pnl.pnl.forEach(p => {
          const su = stock.outlets.find(s => s.outlet_id === p.outlet_id);
          if (su) {
            p.has_prev_closing = su.has_prev_closing;
            p.has_today_closing = su.has_today_closing;
            // Only override variable cost when BOTH prev closing and today closing exist
            // Otherwise the stock usage data is incomplete and P&L from dispatched items is more accurate
            if (su.has_prev_closing && su.has_today_closing) {
              p.stock_variable_cost = su.total_used_cost;
              p.stock_cost_by_category = su.variable_cost_by_category;
              p.variable_cost = su.total_used_cost;
              p.variable_by_category = su.variable_cost_by_category;
              p.total_expense = su.total_used_cost + (p.daily_fixed_cost || 0) + (p.bk_share || 0) + (p.daily_purchases || 0);
              p.net_profit = (p.effective_sale || 0) - p.total_expense;
              p.margin = p.effective_sale > 0 ? Math.round(p.net_profit / p.effective_sale * 1000) / 10 : 0;
            }
          }
        });
      }
      setPnlData(pnl);
      setStockData(stock);
    }).finally(() => setLoading(false));
  }, [dateStr]);

  const allPnl = pnlData?.pnl || [];
  const currentData = selOutlet
    ? allPnl.find((r) => r.outlet_id === selOutlet)
    : allPnl.find((r) => r.outlet_id === "all");
  const d = currentData || {};

  const Row = ({ label, value, bold, color, bg, sub, negative, indent }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: indent ? "7px 16px 7px 32px" : "10px 16px", background: bg || "transparent", borderBottom: "1px solid #F0F0EC" }}>
      <span style={{ fontSize: indent ? 12 : 13, fontWeight: bold ? 700 : 400, color: color || (indent ? "#777" : "#1A1A1A") }}>{label}</span>
      <div style={{ textAlign: "right" }}>
        <span style={{ fontSize: indent ? 13 : 14, fontWeight: bold ? 800 : 600, fontFamily: "'JetBrains Mono', monospace", color: negative ? "#DC2626" : (color || "#1A1A1A") }}>
          {negative ? "−" : ""}{fmt(Math.abs(value || 0))}
        </span>
        {sub && <div style={{ fontSize: 10, color: "#999" }}>{sub}</div>}
      </div>
    </div>
  );

  const SectionHeader = ({ label, bg, borderColor, color, icon, expandKey, count }) => (
    <div onClick={() => expandKey && setExpandSection(expandSection === expandKey ? null : expandKey)}
      style={{ padding: "10px 16px", background: bg, borderBottom: `1px solid ${borderColor}`, fontSize: 12, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.6, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: expandKey ? "pointer" : "default" }}>
      <span>{icon} {label}</span>
      {expandKey && <span style={{ fontSize: 10, color: "#999" }}>{expandSection === expandKey ? "▲ collapse" : `▼ ${count || "details"}`}</span>}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>💰 Daily P&L</h3>
        <p style={{ fontSize: 12, color: "#888", margin: 0 }}>Live from dispatched items × rate card + fixed costs + purchases</p>
      </div>

      {/* Date pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, overflowX: "auto", paddingBottom: 4 }}>
        {Array.from({ length: 10 }, (_, i) => {
          const dd = istNow(); dd.setDate(dd.getDate() - i);
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : dd.toISOString().split("T")[0].slice(5);
          return (<button key={i} onClick={() => setSelDay(i)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selDay === i ? 700 : 500, border: selDay === i ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selDay === i ? "#1A1A1A" : "#fff", color: selDay === i ? "#fff" : "#888", whiteSpace: "nowrap" }}>{label}</button>);
        })}
      </div>

      {/* Outlet pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        <button onClick={() => setSelOutlet(null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: !selOutlet ? 700 : 500, border: !selOutlet ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selOutlet ? "#1A1A1A" : "#fff", color: !selOutlet ? "#fff" : "#888" }}>All Outlets</button>
        {OUTLETS.map((o) => (<button key={o.id} onClick={() => setSelOutlet(o.id)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selOutlet === o.id ? 700 : 500, border: selOutlet === o.id ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selOutlet === o.id ? "#1A1A1A" : "#fff", color: selOutlet === o.id ? "#fff" : "#888" }}>{o.short}</button>))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Computing P&L...</div>}

      {!loading && !currentData && <div style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 36, marginBottom: 8 }}>📊</div><div style={{ color: "#999" }}>No data for {dateStr}</div></div>}

      {!loading && currentData && (<>
        {/* Stock data warnings */}
        {d.has_prev_closing === false && (
          <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>
            ⚠️ Previous day closing stock missing — variable cost may be inaccurate
          </div>
        )}
        {d.has_today_closing === false && (
          <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12, color: "#92400E", marginBottom: 12 }}>
            ⏳ Today's closing stock not submitted — variable cost is estimated from dispatched items only
          </div>
        )}
        {/* Summary Cards */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          {[
            { l: "Effective Sale", v: d.effective_sale, c: "#166534", bg: "#F0FDF4", bc: "#BBF7D0" },
            { l: "Total Expense", v: d.total_expense, c: "#991B1B", bg: "#FEF2F2", bc: "#FECACA" },
            { l: "Net P&L", v: d.net_profit, c: d.net_profit >= 0 ? "#16A34A" : "#DC2626", bg: d.net_profit >= 0 ? "#F0FDF4" : "#FEF2F2", bc: d.net_profit >= 0 ? "#BBF7D0" : "#FECACA" },
            { l: "Margin", v: null, display: (d.margin || 0) + "%", c: d.margin >= 0 ? "#16A34A" : "#DC2626", bg: "#fff", bc: "#E8E8E4" },
          ].map((s, i) => (
            <div key={i} style={{ flex: "1 1 100px", background: s.bg, borderRadius: 12, padding: "14px 16px", border: `1px solid ${s.bc}`, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{s.l}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.c, fontFamily: "'JetBrains Mono', monospace" }}>{s.display || fmt(s.v || 0)}</div>
            </div>
          ))}
        </div>

        {/* Per-outlet mini cards (when All Outlets selected) */}
        {!selOutlet && allPnl.filter((r) => r.outlet_id !== "all").length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, marginBottom: 20 }}>
            {allPnl.filter((r) => r.outlet_id !== "all").map((r) => {
              const oName = OUTLETS.find((o) => o.id === r.outlet_id)?.short || r.outlet_id;
              return (
                <div key={r.outlet_id} onClick={() => setSelOutlet(r.outlet_id)} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 12px", cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{oName}</div>
                  <div style={{ fontSize: 9, color: "#888" }}>Sale: <strong style={{ color: "#166534" }}>{fmt(r.effective_sale)}</strong></div>
                  <div style={{ fontSize: 9, color: "#888" }}>Expense: <strong style={{ color: "#991B1B" }}>{fmt(r.total_expense)}</strong></div>
                  <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: r.net_profit >= 0 ? "#16A34A" : "#DC2626", marginTop: 4 }}>
                    {r.net_profit >= 0 ? "" : "−"}{fmt(Math.abs(r.net_profit))}
                  </div>
                  <div style={{ fontSize: 10, color: r.margin >= 0 ? "#16A34A" : "#DC2626", fontWeight: 600 }}>{r.margin}%</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Detailed P&L Table */}
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 20 }}>
          {/* REVENUE */}
          <SectionHeader label="Revenue" bg="#F0FDF4" borderColor="#BBF7D0" color="#166534" icon="📈" />
          <Row label="Total Sale (Billing)" value={d.total_sale} bold color="#166534" bg="#F0FDF4" />
          <Row label="Delivery (Swiggy + Zomato + Other)" value={d.delivery_sale} indent />
          {d.delivery_commission > 0 && <Row label="− Platform Commission (40%)" value={d.delivery_commission} negative indent />}
          {d.net_delivery_sale > 0 && <Row label="Net Delivery Revenue (60%)" value={d.net_delivery_sale} indent color="#2563EB" />}
          <Row label="Store Sale" value={d.store_sale} indent />
          {(d.cancelled_orders > 0 || d.complimentary > 0) && <>
            {d.cancelled_orders > 0 && <Row label="− Cancelled Orders" value={d.cancelled_orders} negative indent />}
            {d.complimentary > 0 && <Row label="− Complimentary" value={d.complimentary} negative indent />}
          </>}
          <Row label="Effective Sale" value={d.effective_sale} bold color="#166534" bg="#ECFDF5" sub="Store + Net Delivery − Cancelled − Complimentary" />

          {/* VARIABLE COST */}
          <SectionHeader label={d.has_today_closing === true && d.has_prev_closing === true ? "Variable Cost (Used Stock × Rate)" : "Variable Cost (Dispatched × Rate)"} bg="#FFFBEB" borderColor="#FDE68A" color="#92400E" icon="📦" expandKey="variable" count={d.item_breakdown?.length ? d.item_breakdown.length + " items" : "details"} />
          <Row label="Material Cost" value={d.variable_cost} bold color="#B45309" bg="#FFFDF5" sub={d.has_today_closing === true && d.has_prev_closing === true ? "Opening − Closing = Used" : "from dispatched items"} />
          {expandSection === "variable" && d.variable_by_category && Object.entries(d.variable_by_category).sort((a, b) => b[1] - a[1]).map(([cat, cost]) => (
            <Row key={cat} label={cat} value={cost} indent sub={d.effective_sale > 0 ? pct(cost / d.effective_sale * 100) + " of sale" : ""} />
          ))}
          {expandSection === "variable" && d.item_breakdown && d.item_breakdown.length > 0 && (
            <div style={{ padding: "8px 12px", background: "#FAFAF8", borderBottom: "1px solid #F0F0EC" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Item-wise Breakdown</div>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {d.item_breakdown.sort((a, b) => b.cost - a.cost).map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", fontSize: 11, borderBottom: "1px solid #F5F5F3" }}>
                    <span style={{ color: "#555" }}>{item.name} <span style={{ color: "#BBB" }}>({item.qty} {item.unit} × ₹{item.rate})</span></span>
                    <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 600, color: "#B45309" }}>{fmt(item.cost)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DAILY PURCHASES */}
          <SectionHeader label="Daily Purchases" bg="#EFF6FF" borderColor="#BFDBFE" color="#1D4ED8" icon="🧾" />
          <Row label="Cash Purchases" value={d.daily_purchases} bold color="#2563EB" />

          {/* FIXED COSTS */}
          <SectionHeader label={"Fixed Costs (Monthly ÷ " + (d.days_in_month || 30) + " days)"} bg="#F5F3FF" borderColor="#DDD6FE" color="#6D28D9" icon="🏢" expandKey="fixed" count={d.fixed_breakdown?.length + " heads"} />
          <Row label="Daily Fixed Cost" value={d.daily_fixed_cost} bold color="#7C3AED" />
          <Row label="BK Share (¼ of Base Kitchen)" value={d.bk_share} indent />
          {expandSection === "fixed" && d.fixed_breakdown && d.fixed_breakdown.map((f) => (
            <Row key={f.cost_head} label={f.label} value={f.daily} indent sub={`₹${f.monthly.toLocaleString("en-IN")}/month`} />
          ))}

          {/* TOTALS */}
          <div style={{ borderTop: "2px solid #1A1A1A" }}>
            <Row label="Total Expense" value={d.total_expense} bold bg="#F8F8F5" />
            <Row label="Net P&L" value={Math.abs(d.net_profit || 0)} bold
              color={d.net_profit >= 0 ? "#16A34A" : "#DC2626"}
              bg={d.net_profit >= 0 ? "#F0FDF4" : "#FEF2F2"}
              negative={d.net_profit < 0}
              sub={`${d.margin || 0}% margin`} />
          </div>
        </div>

        {/* Cost Breakdown Bars */}
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
          <div style={{ padding: "10px 16px", background: "#F8F8F5", borderBottom: "1px solid #E8E8E4", fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 0.6 }}>Cost as % of Sale</div>
          {[
            { l: "Variable (Materials)", v: d.effective_sale > 0 ? (d.variable_cost || 0) / d.effective_sale * 100 : 0, t: 35 },
            { l: "Fixed Costs", v: d.effective_sale > 0 ? ((d.daily_fixed_cost || 0) + (d.bk_share || 0)) / d.effective_sale * 100 : 0, t: 25 },
            { l: "Purchases", v: d.effective_sale > 0 ? (d.daily_purchases || 0) / d.effective_sale * 100 : 0, t: 5 },
            { l: "Total Expense", v: d.effective_sale > 0 ? (d.total_expense || 0) / d.effective_sale * 100 : 0, t: 70 },
          ].map((item) => (
            <div key={item.l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #F0F0EC" }}>
              <span style={{ fontSize: 13 }}>{item.l}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 80, height: 6, borderRadius: 3, background: "#EBEBEB", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 3, background: item.v > item.t ? "#DC2626" : "#16A34A", width: `${Math.min(item.v, 100)}%` }} />
                </div>
                <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: item.v > item.t ? "#DC2626" : "#16A34A", width: 50, textAlign: "right" }}>{pct(item.v)}</span>
              </div>
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  DAILY STOCK USAGE — Opening, Used, Closing per outlet
// ═════════════════════════════════════════════════════════════════════════════
const DailyStockUsage = () => {
  const [selOutlet, setSelOutlet] = useState(null);
  const [selDay, setSelDay] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandCat, setExpandCat] = useState(null);

  const dateStr = useMemo(() => {
    return istDateAgo(selDay);
  }, [selDay]);

  useEffect(() => {
    setLoading(true);
    api.getStockUsage(dateStr).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [dateStr]);

  const allOutlets = data?.outlets || [];
  const current = selOutlet
    ? allOutlets.find((r) => r.outlet_id === selOutlet)
    : allOutlets.find((r) => r.outlet_id === "all");
  const d = current || {};

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>📦 Daily Stock Usage</h3>
        <p style={{ fontSize: 12, color: "#888", margin: 0 }}>Opening = (Prev Closing − Wastage) + Dispatched · Used = Opening − Closing</p>
      </div>

      {/* Date pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, overflowX: "auto", paddingBottom: 4 }}>
        {Array.from({ length: 10 }, (_, i) => {
          const dd = istNow(); dd.setDate(dd.getDate() - i);
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : dd.toISOString().split("T")[0].slice(5);
          return (<button key={i} onClick={() => setSelDay(i)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selDay === i ? 700 : 500, border: selDay === i ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selDay === i ? "#1A1A1A" : "#fff", color: selDay === i ? "#fff" : "#888", whiteSpace: "nowrap" }}>{label}</button>);
        })}
      </div>

      {/* Outlet pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        <button onClick={() => setSelOutlet(null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: !selOutlet ? 700 : 500, border: !selOutlet ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selOutlet ? "#1A1A1A" : "#fff", color: !selOutlet ? "#fff" : "#888" }}>All Outlets</button>
        {OUTLETS.map((o) => (<button key={o.id} onClick={() => setSelOutlet(o.id)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selOutlet === o.id ? 700 : 500, border: selOutlet === o.id ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selOutlet === o.id ? "#1A1A1A" : "#fff", color: selOutlet === o.id ? "#fff" : "#888" }}>{o.short}</button>))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Computing stock usage...</div>}

      {!loading && !current && <div style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 36, marginBottom: 8 }}>📦</div><div style={{ color: "#999" }}>No data for {dateStr}</div></div>}

      {!loading && current && (<>
        {/* Warnings */}
        {!d.has_prev_closing && (
          <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>
            ⚠️ Previous day closing stock not submitted — opening stock may be inaccurate
          </div>
        )}
        {!d.has_today_closing && (
          <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12, color: "#92400E", marginBottom: 12 }}>
            ⏳ Today's closing stock not submitted yet — "Used" calculation is pending
          </div>
        )}

        {/* Summary card */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 140px", background: "#FFFBEB", borderRadius: 12, padding: "14px 16px", border: "1px solid #FDE68A", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#92400E", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Total Used Cost</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#B45309", fontFamily: "'JetBrains Mono', monospace" }}>{fmt(d.total_used_cost || 0)}</div>
          </div>
        </div>

        {/* Per-outlet mini cards */}
        {!selOutlet && allOutlets.filter((r) => r.outlet_id !== "all").length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginBottom: 20 }}>
            {allOutlets.filter((r) => r.outlet_id !== "all").map((r) => {
              const oName = OUTLETS.find((o) => o.id === r.outlet_id)?.short || r.outlet_id;
              return (
                <div key={r.outlet_id} onClick={() => setSelOutlet(r.outlet_id)} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 12px", cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{oName}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#B45309" }}>{fmt(r.total_used_cost)}</div>
                  {!r.has_today_closing && <div style={{ fontSize: 9, color: "#B45309" }}>⏳ closing pending</div>}
                  {!r.has_prev_closing && <div style={{ fontSize: 9, color: "#DC2626" }}>⚠ no prev closing</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* Category-wise cost breakdown */}
        {d.variable_cost_by_category && Object.keys(d.variable_cost_by_category).length > 0 && (
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 20 }}>
            <div style={{ padding: "10px 16px", background: "#FFFBEB", borderBottom: "1px solid #FDE68A", fontSize: 12, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: 0.6 }}>📊 Variable Cost by Category</div>
            {Object.entries(d.variable_cost_by_category).sort((a, b) => b[1] - a[1]).map(([cat, cost]) => (
              <div key={cat} onClick={() => setExpandCat(expandCat === cat ? null : cat)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #F0F0EC", cursor: selOutlet ? "pointer" : "default" }}>
                <span style={{ fontSize: 13 }}>{cat}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{fmt(cost)}</span>
                  {selOutlet && <span style={{ fontSize: 10, color: "#CCC" }}>▼</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Item-level table (when specific outlet selected) */}
        {selOutlet && d.items && d.items.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", background: "#F8F8F5", borderBottom: "1px solid #E8E8E4", fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 0.6 }}>
              📋 Item-wise Stock ({d.items.length} items)
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: "#FAFAF8" }}>
                  <th style={thS}>Item</th>
                  <th style={{ ...thS, textAlign: "center", fontSize: 9 }}>Prev Close</th>
                  <th style={{ ...thS, textAlign: "center", fontSize: 9 }}>−Wastage</th>
                  <th style={{ ...thS, textAlign: "center", fontSize: 9 }}>+Dispatched</th>
                  <th style={{ ...thS, textAlign: "center", fontSize: 9, color: "#2563EB" }}>Opening</th>
                  <th style={{ ...thS, textAlign: "center", fontSize: 9, color: "#DC2626" }}>Closing</th>
                  <th style={{ ...thS, textAlign: "center", fontSize: 9, color: "#B45309", fontWeight: 800 }}>Used</th>
                  <th style={{ ...thS, textAlign: "right", fontSize: 9 }}>Rate</th>
                  <th style={{ ...thS, textAlign: "right", fontSize: 9, color: "#B45309" }}>Cost</th>
                </tr></thead>
                <tbody>
                  {(expandCat ? d.items.filter((i) => i.category === expandCat) : d.items).map((item) => (
                    <tr key={item.item_id} style={{ borderBottom: "1px solid #F0F0EC", background: item.used > 0 ? "transparent" : "#FAFAF8" }}>
                      <td style={{ ...tdS, fontWeight: 600, whiteSpace: "nowrap" }}>{item.name}<div style={{ fontSize: 9, color: "#999" }}>{item.category} · {item.unit}</div></td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono'", fontSize: 11 }}>{item.prev_closing || "—"}</td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono'", fontSize: 11, color: item.wastage > 0 ? "#DC2626" : "#CCC" }}>{item.wastage > 0 ? `-${item.wastage}` : "—"}</td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono'", fontSize: 11, color: item.dispatched > 0 ? "#16A34A" : "#CCC" }}>{item.dispatched > 0 ? `+${item.dispatched}` : "—"}</td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 700, color: "#2563EB" }}>{item.opening}</td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 700, color: "#DC2626" }}>{item.closing}</td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono'", fontSize: 13, fontWeight: 800, color: "#B45309" }}>{item.used}</td>
                      <td style={{ ...tdS, textAlign: "right", fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#999" }}>₹{item.rate}</td>
                      <td style={{ ...tdS, textAlign: "right", fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 700, color: "#B45309" }}>{fmt(item.used_cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={{ background: "#FFFBEB", borderTop: "2px solid #FDE68A" }}>
                  <td colSpan={8} style={{ ...tdS, fontWeight: 800, fontSize: 13 }}>Total Variable Cost</td>
                  <td style={{ ...tdS, textAlign: "right", fontWeight: 800, fontSize: 14, fontFamily: "'JetBrains Mono'", color: "#B45309" }}>{fmt(d.total_used_cost)}</td>
                </tr></tfoot>
              </table>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
};

// ─── BK Items — auto-derived from DEMAND_SECTIONS so they always match ──────
const BK_ITEMS = DEMAND_SECTIONS.flatMap((sec) => sec.items.map((item) => ({ ...item, category: sec.id })));
let RAW_MATERIALS = [
  { id: "besan", name: "Besan", unit: "Kg" },
  { id: "golden_sela_rice", name: "Golden Sela Rice", unit: "Kg" },
  { id: "poha_raw", name: "Poha", unit: "Kg" },
  { id: "sona_masoori_raw", name: "Sona Masoori Rice", unit: "Kg" },
  { id: "salt_raw", name: "Salt", unit: "Kg" },
  { id: "sugar_raw", name: "Sugar", unit: "Kg" },
  { id: "urad_daal", name: "Urad Daal Whole", unit: "Kg" },
  { id: "deggi_mirch_raw", name: "Deggi Mirch", unit: "Kg" },
  { id: "jeera_raw", name: "Jeera", unit: "Kg" },
  { id: "kali_mirch_raw", name: "Kali Mirch", unit: "Kg" },
  { id: "red_chilli_powder_raw", name: "Red Chilli Powder", unit: "Kg" },
  { id: "onions_raw", name: "Onions", unit: "Kg" },
  { id: "fortune_refined_raw", name: "Fortune Refined Oil", unit: "Tin" },
  { id: "tomatoes_raw", name: "Tomatoes", unit: "Kg" },
  { id: "chana_dal_raw", name: "Chana Dal", unit: "Kg" },
  { id: "haldi_raw", name: "Haldi Powder", unit: "Kg" },
  { id: "curry_leaves_raw", name: "Curry Leaves", unit: "Kg" },
  { id: "mustard_raw", name: "Mustard Seeds", unit: "Kg" },
  { id: "ginger_raw", name: "Ginger", unit: "Kg" },
  { id: "green_chilli_raw", name: "Green Chillies", unit: "Kg" },
  { id: "amchoor_raw", name: "Amchoor Powder", unit: "Kg" },
  { id: "dhaniya_whole_raw", name: "Dhaniya Whole", unit: "Kg" },
  { id: "hing_raw", name: "Hing Powder", unit: "Kg" },
  { id: "methi_dana_raw", name: "Methi Dana", unit: "Kg" },
  { id: "roasted_chana_raw", name: "Roasted Chana", unit: "Kg" },
  { id: "roasted_peanuts_raw", name: "Roasted Peanuts", unit: "Kg" },
  { id: "roasted_karipatta_raw", name: "Roasted Karipatta", unit: "Kg" },
  { id: "safed_til_raw", name: "Safed Til", unit: "Kg" },
  { id: "rice_powder_raw", name: "Rice Powder", unit: "Kg" },
  { id: "upma_sooji_raw", name: "Upma Sooji", unit: "Kg" },
  { id: "kaju_raw", name: "Kaju", unit: "Kg" },
  { id: "coconut_crush_raw", name: "Coconut Crush", unit: "Kg" },
  { id: "coriander_raw", name: "Coriander Leaves", unit: "Kg" },
  { id: "garlic_raw", name: "Garlic", unit: "Kg" },
  { id: "mint_raw", name: "Mint (Pudina)", unit: "Kg" },
  { id: "arhar_dal_raw", name: "Arhar Dal", unit: "Kg" },
  { id: "drumstick_raw", name: "Drumstick", unit: "Kg" },
  { id: "desi_ghee_raw", name: "Desi Ghee", unit: "Tin" },
  { id: "gur_raw", name: "Gur", unit: "Kg" },
  { id: "imli_raw", name: "Imli", unit: "Kg" },
  { id: "petha_raw", name: "Petha", unit: "Kg" },
  { id: "sambhar_masala_raw", name: "Sambhar Masala 777", unit: "Kg" },
  { id: "peanuts_raw", name: "Peanuts (Raw)", unit: "Kg" },
  { id: "meetha_soda_raw", name: "Meetha Soda", unit: "Kg" },
  { id: "coconut_raw", name: "Coconut (Fresh)", unit: "Pcs" },
  { id: "pineapple_raw", name: "Pineapple", unit: "Pcs" },
  { id: "milk_raw", name: "Milk", unit: "Ltr" },
  { id: "kishmish_raw", name: "Kishmish", unit: "Kg" },
  { id: "kesar_raw", name: "Kesar", unit: "Kg" },
  { id: "whole_red_chilli_raw", name: "Whole Red Chilli", unit: "Kg" },
  { id: "tadka_raw", name: "Tadka", unit: "Kg" },
  { id: "garam_masala_raw", name: "Garam Masala", unit: "Kg" },
  { id: "semiyan_raw", name: "Semiyan", unit: "Kg" },
  { id: "milkmaid_raw", name: "Milkmaid", unit: "Kg" },
  { id: "ilaychi_raw", name: "Ilaychi", unit: "Kg" },
];

let RECIPES = {
  dosa_batter: { name: "Dosa Batter", yield: "18 Kg (1 Batch)", yieldQty: 18, ingredients: [{ rawId: "besan", qty: 0.36 }, { rawId: "golden_sela_rice", qty: 1.0 }, { rawId: "poha_raw", qty: 0.3 }, { rawId: "sona_masoori_raw", qty: 5.0 }, { rawId: "salt_raw", qty: 0.36 }, { rawId: "sugar_raw", qty: 0.324 }, { rawId: "urad_daal", qty: 1.4 }] },
  garlic_paste: { name: "Garlic Paste", yield: "1.5 Kg", yieldQty: 1.5, ingredients: [{ rawId: "deggi_mirch_raw", qty: 0.03 }, { rawId: "jeera_raw", qty: 0.018 }, { rawId: "kali_mirch_raw", qty: 0.018 }, { rawId: "red_chilli_powder_raw", qty: 0.03 }, { rawId: "onions_raw", qty: 0.5 }, { rawId: "fortune_refined_raw", qty: 0.033 }, { rawId: "salt_raw", qty: 0.03 }, { rawId: "tomatoes_raw", qty: 0.5 }] },
  idli_batter: { name: "Idli Batter", yield: "16 Kg (1 Batch)", yieldQty: 16, ingredients: [{ rawId: "poha_raw", qty: 0.5 }, { rawId: "salt_raw", qty: 0.27 }, { rawId: "sona_masoori_raw", qty: 5.0 }, { rawId: "urad_daal", qty: 1.4 }] },
  onion_masala: { name: "Onion Masala", yield: "2 Kg", yieldQty: 2, ingredients: [{ rawId: "chana_dal_raw", qty: 0.05 }, { rawId: "haldi_raw", qty: 0.02 }, { rawId: "curry_leaves_raw", qty: 0.03 }, { rawId: "mustard_raw", qty: 0.03 }, { rawId: "salt_raw", qty: 0.1 }, { rawId: "onions_raw", qty: 1.0 }, { rawId: "fortune_refined_raw", qty: 0.047 }, { rawId: "ginger_raw", qty: 0.02 }, { rawId: "green_chilli_raw", qty: 0.02 }] },
  podi_masala: { name: "Podi Masala", yield: "4 Kg", yieldQty: 4, ingredients: [{ rawId: "amchoor_raw", qty: 0.15 }, { rawId: "chana_dal_raw", qty: 1.5 }, { rawId: "deggi_mirch_raw", qty: 0.4 }, { rawId: "dhaniya_whole_raw", qty: 0.03 }, { rawId: "hing_raw", qty: 0.075 }, { rawId: "jeera_raw", qty: 0.05 }, { rawId: "kali_mirch_raw", qty: 0.05 }, { rawId: "curry_leaves_raw", qty: 0.05 }, { rawId: "methi_dana_raw", qty: 0.01 }, { rawId: "mustard_raw", qty: 0.03 }, { rawId: "roasted_chana_raw", qty: 0.15 }, { rawId: "roasted_peanuts_raw", qty: 0.15 }, { rawId: "roasted_karipatta_raw", qty: 0.05 }, { rawId: "salt_raw", qty: 0.06 }, { rawId: "sugar_raw", qty: 0.1 }, { rawId: "safed_til_raw", qty: 0.03 }, { rawId: "urad_daal", qty: 1.5 }] },
  rawa_mix: { name: "Rawa Mix", yield: "6 Kg", yieldQty: 6, ingredients: [{ rawId: "hing_raw", qty: 0.1 }, { rawId: "jeera_raw", qty: 0.06 }, { rawId: "kaju_raw", qty: 0.15 }, { rawId: "kali_mirch_raw", qty: 0.06 }, { rawId: "curry_leaves_raw", qty: 0.15 }, { rawId: "rice_powder_raw", qty: 3.0 }, { rawId: "salt_raw", qty: 0.12 }, { rawId: "upma_sooji_raw", qty: 2.0 }] },
  red_chutney: { name: "Red Chutney", yield: "7 Kg", yieldQty: 7, ingredients: [{ rawId: "chana_dal_raw", qty: 0.4 }, { rawId: "coconut_crush_raw", qty: 0.5 }, { rawId: "deggi_mirch_raw", qty: 0.2 }, { rawId: "coriander_raw", qty: 0.075 }, { rawId: "garlic_raw", qty: 0.2 }, { rawId: "ginger_raw", qty: 0.18 }, { rawId: "jeera_raw", qty: 0.08 }, { rawId: "kali_mirch_raw", qty: 0.08 }, { rawId: "mint_raw", qty: 0.2 }, { rawId: "onions_raw", qty: 4.0 }, { rawId: "fortune_refined_raw", qty: 0.047 }, { rawId: "roasted_chana_raw", qty: 0.4 }, { rawId: "salt_raw", qty: 0.24 }, { rawId: "sugar_raw", qty: 0.18 }, { rawId: "tomatoes_raw", qty: 3.0 }] },
  sambhar: { name: "Sambhar", yield: "70 Kg", yieldQty: 70, ingredients: [{ rawId: "arhar_dal_raw", qty: 5.0 }, { rawId: "chana_dal_raw", qty: 0.6 }, { rawId: "coconut_crush_raw", qty: 0.6 }, { rawId: "deggi_mirch_raw", qty: 0.15 }, { rawId: "dhaniya_whole_raw", qty: 0.1 }, { rawId: "drumstick_raw", qty: 0.7 }, { rawId: "desi_ghee_raw", qty: 0.033 }, { rawId: "ginger_raw", qty: 0.04 }, { rawId: "gur_raw", qty: 1.0 }, { rawId: "haldi_raw", qty: 0.1 }, { rawId: "green_chilli_raw", qty: 0.04 }, { rawId: "hing_raw", qty: 0.15 }, { rawId: "imli_raw", qty: 1.0 }, { rawId: "jeera_raw", qty: 0.13 }, { rawId: "kali_mirch_raw", qty: 0.1 }, { rawId: "curry_leaves_raw", qty: 0.16 }, { rawId: "methi_dana_raw", qty: 0.2 }, { rawId: "mustard_raw", qty: 0.5 }, { rawId: "salt_raw", qty: 0.4 }, { rawId: "onions_raw", qty: 3.0 }, { rawId: "petha_raw", qty: 2.0 }, { rawId: "fortune_refined_raw", qty: 0.067 }, { rawId: "safed_til_raw", qty: 0.6 }, { rawId: "sambhar_masala_raw", qty: 0.25 }, { rawId: "tomatoes_raw", qty: 2.0 }] },
  vada_batter: { name: "Vada Batter", yield: "2 Kg (1 Batch)", yieldQty: 2, ingredients: [{ rawId: "ginger_raw", qty: 0.1 }, { rawId: "green_chilli_raw", qty: 0.1 }, { rawId: "jeera_raw", qty: 0.05 }, { rawId: "kali_mirch_raw", qty: 0.05 }, { rawId: "meetha_soda_raw", qty: 0.01 }, { rawId: "salt_raw", qty: 0.06 }, { rawId: "urad_daal", qty: 1.0 }] },
  roasted_peanuts: { name: "Roasted Peanuts", yield: "1 Kg", yieldQty: 1, ingredients: [{ rawId: "peanuts_raw", qty: 1.0 }, { rawId: "salt_raw", qty: 0.3 }] },
  roasted_karipatta: { name: "Roasted Karipatta", yield: "1 Kg", yieldQty: 1, ingredients: [{ rawId: "curry_leaves_raw", qty: 1.0 }, { rawId: "salt_raw", qty: 0.3 }] },
  pineapple_halwa: { name: "Pineapple Halwa", yield: "1 Kg", yieldQty: 1, ingredients: [{ rawId: "upma_sooji_raw", qty: 0.15 }, { rawId: "desi_ghee_raw", qty: 0.01 }, { rawId: "sugar_raw", qty: 0.18 }, { rawId: "kaju_raw", qty: 0.02 }, { rawId: "kishmish_raw", qty: 0.02 }, { rawId: "kesar_raw", qty: 0.0003 }, { rawId: "pineapple_raw", qty: 0.25 }, { rawId: "milk_raw", qty: 0.05 }] },
  white_chutney: { name: "White Chutney", yield: "2.5 Kg", yieldQty: 2.5, ingredients: [{ rawId: "coconut_crush_raw", qty: 1.0 }, { rawId: "roasted_chana_raw", qty: 0.2 }, { rawId: "roasted_peanuts_raw", qty: 0.2 }, { rawId: "salt_raw", qty: 0.04 }, { rawId: "ginger_raw", qty: 0.04 }, { rawId: "green_chilli_raw", qty: 0.04 }, { rawId: "tadka_raw", qty: 0.1 }] },
  tadka: { name: "Tadka", yield: "1 Kg", yieldQty: 1, ingredients: [{ rawId: "mustard_raw", qty: 0.5 }, { rawId: "fortune_refined_raw", qty: 0.013 }, { rawId: "whole_red_chilli_raw", qty: 0.1 }, { rawId: "curry_leaves_raw", qty: 0.2 }] },
  coconut_crush: { name: "Coconut Crush", yield: "0.2 Kg", yieldQty: 0.2, ingredients: [{ rawId: "coconut_raw", qty: 0.8 }] },
  rasam: { name: "Rasam", yield: "3.25 Kg", yieldQty: 3.25, ingredients: [{ rawId: "tomatoes_raw", qty: 1.0 }, { rawId: "kali_mirch_raw", qty: 0.05 }, { rawId: "jeera_raw", qty: 0.03 }, { rawId: "coriander_raw", qty: 0.1 }, { rawId: "garam_masala_raw", qty: 0.02 }, { rawId: "deggi_mirch_raw", qty: 0.02 }, { rawId: "imli_raw", qty: 0.1 }, { rawId: "garlic_raw", qty: 0.05 }, { rawId: "green_chilli_raw", qty: 0.05 }, { rawId: "curry_leaves_raw", qty: 0.05 }, { rawId: "salt_raw", qty: 0.1 }, { rawId: "hing_raw", qty: 0.05 }, { rawId: "fortune_refined_raw", qty: 0.007 }] },
  sevya_payasam: { name: "Sevya Payasam", yield: "2.5 Kg", yieldQty: 2.5, ingredients: [{ rawId: "desi_ghee_raw", qty: 0.01 }, { rawId: "kaju_raw", qty: 0.02 }, { rawId: "kishmish_raw", qty: 0.02 }, { rawId: "kesar_raw", qty: 0.0003 }, { rawId: "milk_raw", qty: 2.0 }, { rawId: "semiyan_raw", qty: 0.2 }, { rawId: "sugar_raw", qty: 0.3 }, { rawId: "milkmaid_raw", qty: 0.04 }, { rawId: "ilaychi_raw", qty: 0.001 }] },
};

// ─── UNIT CONVERSIONS — Custom unit to base unit mappings ─────────────────
let UNIT_CONVERSIONS = {
  Batch: [
    { item_id: "dosa_batter", item_name: "Dosa Batter", qty: 18, base_unit: "Kg", notes: "1 Batch = 18 Kg" },
    { item_id: "idli_batter", item_name: "Idli Batter", qty: 16, base_unit: "Kg", notes: "1 Batch = 16 Kg" },
    { item_id: "vada_batter", item_name: "Vada Batter", qty: 2, base_unit: "Kg", notes: "1 Batch = 2 Kg" },
  ],
  Pkt: [
    { item_id: "deggi_mirch", item_name: "Deggi Mirch", qty: 500, base_unit: "Gm", notes: "1 Pkt = 500 Gm" },
    { item_id: "dhaniya_powder", item_name: "Dhaniya Powder", qty: 500, base_unit: "Gm", notes: "1 Pkt = 500 Gm" },
    { item_id: "kitchen_king", item_name: "Kitchen King", qty: 100, base_unit: "Gm", notes: "1 Pkt = 100 Gm" },
    { item_id: "chat_masala", item_name: "Chat Masala", qty: 100, base_unit: "Gm", notes: "1 Pkt = 100 Gm" },
    { item_id: "haldi_powder", item_name: "Haldi Powder", qty: 500, base_unit: "Gm", notes: "1 Pkt = 500 Gm" },
    { item_id: "red_chilli_powder", item_name: "Red Chilli Powder", qty: 500, base_unit: "Gm", notes: "1 Pkt = 500 Gm" },
    { item_id: "sambhar_masala_777", item_name: "Sambhar Masala 777", qty: 200, base_unit: "Gm", notes: "1 Pkt = 200 Gm" },
    { item_id: "amchoor_powder", item_name: "Amchoor Powder", qty: 100, base_unit: "Gm", notes: "1 Pkt = 100 Gm" },
    { item_id: "kasturi_methi", item_name: "Kasturi Methi", qty: 100, base_unit: "Gm", notes: "1 Pkt = 100 Gm" },
    { item_id: "filter_coffee_powder", item_name: "Filter Coffee Powder", qty: 200, base_unit: "Gm", notes: "1 Pkt = 200 Gm" },
    { item_id: "chai_patti", item_name: "Chai Patti", qty: 250, base_unit: "Gm", notes: "1 Pkt = 250 Gm" },
    { item_id: "papad_777", item_name: "777 Papad", qty: 200, base_unit: "Pcs", notes: "1 Pkt = 200 Pcs" },
    { item_id: "sarf", item_name: "Surf", qty: 1, base_unit: "Kg", notes: "1 Pkt = 1 Kg" },
  ],
  Tin: [
    { item_id: "fortune_refined", item_name: "Fortune Refined Oil", qty: 15, base_unit: "Ltr", notes: "1 Tin = 15 Ltr" },
    { item_id: "desi_ghee", item_name: "Desi Ghee", qty: 15, base_unit: "Kg", notes: "1 Tin = 15 Kg" },
  ],
  Box: [
    { item_id: "achar", item_name: "Achar", qty: 5, base_unit: "Kg", notes: "1 Box = 5 Kg" },
  ],
  Bundle: [
    { item_id: "bio_garbage_bag", item_name: "Bio Garbage Bag", qty: 10, base_unit: "Pcs", notes: "1 Bundle = 10 Pcs" },
    { item_id: "clean_wrap", item_name: "Clean Wrap", qty: 1, base_unit: "Roll", notes: "1 Bundle = 1 Roll" },
    { item_id: "tape", item_name: "Tape", qty: 6, base_unit: "Pcs", notes: "1 Bundle = 6 Pcs" },
  ],
};

const getBk = (id) => BK_ITEMS.find((b) => b.id === id)?.name || id;

// ─── UNIT CONVERSION HELPER ─────────────────────────────────────────────
// Converts a quantity+unit using ONLY the custom UNIT_CONVERSIONS table.
// No automatic Gm→Kg or Ml→Ltr — those create false mismatches when
// inventory tracks items in Gm/Ml (which is common for vegetables, spices).
// Returns { qty, unit, converted, factor }
const convertToBase = (qty, unit, itemId, itemName) => {
  if (!unit || !qty || qty === 0) return { qty: Number(qty) || 0, unit: unit || "", converted: false, factor: 1 };
  // Only check custom UNIT_CONVERSIONS (Batch, Tin, Pkt, Box, Bundle, etc.)
  const conversions = UNIT_CONVERSIONS[unit];
  if (conversions && Array.isArray(conversions)) {
    const norm = (s) => (s || "").toLowerCase().trim();
    const match = conversions.find((c) => c.item_id === itemId)
               || conversions.find((c) => norm(c.item_name) === norm(itemName));
    if (match) {
      return { qty: Number(qty) * Number(match.qty), unit: match.base_unit, converted: true, factor: Number(match.qty) };
    }
  }
  // No conversion — pass through as-is
  return { qty: Number(qty), unit, converted: false, factor: 1 };
};

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

// ─── CSV Export helper ──────────────────────────────────────────────────────
const exportCSV = (headers, rows, filename) => {
  const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};
const ExportBtn = ({ onClick }) => (
  <button className="no-print" onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "1px solid #BBF7D0", background: "#F0FDF4", fontSize: 12, fontWeight: 600, color: "#16A34A", cursor: "pointer", fontFamily: "inherit" }}>📥 CSV</button>
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
    {/* Missing demand alerts */}
    {(() => {
      const h = istHour();
      const afterNightWindow = h >= 1 && h < 11; // Between 1AM-11AM, night orders should have been placed
      if (!afterNightWindow) return null;
      const outletDemands = data.demands || [];
      const missingOutlets = OUTLETS.filter((o) => !outletDemands.some((d) => d.outlet_id === o.id));
      if (missingOutlets.length === 0) return null;
      return (<div style={{ padding: "12px 16px", borderRadius: 12, background: "#FEF2F2", border: "1px solid #FECACA", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#991B1B", marginBottom: 6 }}>🚨 Missing Night Demand (9PM–1AM)</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{missingOutlets.map((o) => (<span key={o.id} style={{ padding: "3px 10px", borderRadius: 6, background: "#DC2626", color: "#fff", fontSize: 11, fontWeight: 700 }}>{o.name}</span>))}</div>
      </div>);
    })()}
    {data.demands.length > 0 && <div style={{ marginBottom: 16 }}><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>📋 Demands</div>{data.demands.map((d) => (<div key={d.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 14px", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><strong style={{ fontSize: 12 }}>{OUTLETS.find((o) => o.id === d.outlet_id)?.name || d.outlet_id}</strong><span style={{ fontSize: 10, color: "#888" }}>{d.type === "photo" ? "📷" : d.type === "wastage" ? "🗑️" : "✏️"}</span><span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: d.status === "fulfilled" ? "#F0FDF4" : "#FFFBEB", color: d.status === "fulfilled" ? "#16A34A" : "#B45309" }}>{d.status}</span></div><span style={{ fontSize: 11, color: "#999" }}>{new Date(d.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span></div>))}</div>}
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
//  BASE KITCHEN (Consolidated Demand + Stock Out BK + Per-Outlet Direct Items)
// ═════════════════════════════════════════════════════════════════════════════
const BaseKitchen = () => {
  const [orders, setOrders] = useState([]); const [prevDayOrders, setPrevDayOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selDate, setSelDate] = useState(today());
  const [showAll, setShowAll] = useState(false);
  const [cycle, setCycle] = useState("all"); // all, morning, evening
  const [stockOutFilter, setStockOutFilter] = useState("bk");
  const load = useCallback(() => {
    setLoading(true);
    // Load today's orders AND previous day's orders (for night demands)
    const prevDate = (() => { const d = new Date(); d.setDate(d.getDate() - 1); const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000); return ist.toISOString().split("T")[0]; })();
    Promise.all([
      api.getOrders({ date: selDate }),
      selDate === today() ? api.getOrders({ date: prevDate }) : Promise.resolve([]),
    ]).then(([todayData, prevData]) => {
      setOrders(todayData.filter((d) => d.type === "manual" && d.items));
      setPrevDayOrders(prevData.filter((d) => d.type === "manual" && d.items));
    }).catch(() => { setOrders([]); setPrevDayOrders([]); }).finally(() => setLoading(false));
  }, [selDate]);
  useEffect(load, [load]);

  // Split orders into morning and evening cycles using demand_slot field
  // Fallback to submission time if demand_slot is not set (old orders)
  const getOrderHour = (o) => {
    if (!o.submitted_at) return 12;
    const d = new Date(o.submitted_at);
    const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
    return ist.getHours();
  };

  const morningOrders = [
    ...orders.filter((o) => o.demand_slot === "morning"),
    // Fallback for old orders without demand_slot: night submissions
    ...prevDayOrders.filter((o) => !o.demand_slot && getOrderHour(o) >= 21),
    ...orders.filter((o) => !o.demand_slot && getOrderHour(o) < 1),
  ];
  const eveningOrders = [
    ...orders.filter((o) => o.demand_slot === "evening"),
    // Fallback for old orders without demand_slot: day submissions
    ...orders.filter((o) => !o.demand_slot && getOrderHour(o) >= 1),
  ];

  const cycleOrders = cycle === "morning" ? morningOrders : cycle === "evening" ? eveningOrders : orders;

  const pendingOrders = cycleOrders.filter((o) => o.status === "submitted" || o.status === "received");
  const dispatchedOrders = cycleOrders.filter((o) => o.status === "fulfilled");
  const issuedOrders = cycleOrders.filter((o) => o.status === "issued");
  const activeOrders = showAll ? cycleOrders : pendingOrders;

  const consolidated = {}; BK_ITEMS.forEach((bk) => { consolidated[bk.id] = { total: 0, by: {} }; activeOrders.forEach((o) => { const q = o.items?.[bk.id] || 0; consolidated[bk.id].total += q; consolidated[bk.id].by[o.outlet_id] = (consolidated[bk.id].by[o.outlet_id] || 0) + q; }); });

  const foodSection = DEMAND_SECTIONS.find((s) => s.id === "food");
  const foodItemIds = new Set(foodSection?.items.map((i) => i.id) || []);
  const rawReq = {};
  Object.entries(consolidated).forEach(([bkId, data]) => {
    if (!foodItemIds.has(bkId)) return;
    const recipe = RECIPES[bkId]; if (!recipe || data.total === 0) return;
    const batches = data.total / recipe.yieldQty;
    recipe.ingredients.forEach((ing) => { rawReq[ing.rawId] = (rawReq[ing.rawId] || 0) + ing.qty * batches; });
  });

  const nonFoodSections = DEMAND_SECTIONS.filter((s) => s.id !== "food");
  const directItems = {}; const allDirectItems = {};
  activeOrders.forEach((o) => {
    if (!directItems[o.outlet_id]) directItems[o.outlet_id] = {};
    nonFoodSections.forEach((sec) => { sec.items.forEach((item) => {
      const qty = o.items?.[item.id] || 0;
      if (qty > 0) {
        if (!directItems[o.outlet_id][item.id]) directItems[o.outlet_id][item.id] = { name: item.name, qty: 0, unit: item.unit || "", category: sec.titleHi };
        directItems[o.outlet_id][item.id].qty += qty;
        if (!allDirectItems[item.id]) allDirectItems[item.id] = { name: item.name, qty: 0, unit: item.unit || "", category: sec.titleHi };
        allDirectItems[item.id].qty += qty;
      }
    }); });
  });

  const stockOutItems = stockOutFilter === "bk" ? null : stockOutFilter === "all" ? allDirectItems : (directItems[stockOutFilter] || {});
  const hasRawReq = Object.keys(rawReq).length > 0;

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;
  return (
    <div id="print-kitchen">
      {/* Header row: Title + Today/Calendar + Refresh + Print */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div><h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>BK Consolidated</h3><p style={{ fontSize: 11, color: "#888", margin: 0 }}>{pendingOrders.length} pending · {issuedOrders.length} issued · {dispatchedOrders.length} done</p></div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <button onClick={() => setSelDate(today())} style={{ padding: "5px 10px", borderRadius: 6, border: selDate === today() ? "1px solid #BBF7D0" : "1px solid #E0E0DC", background: selDate === today() ? "#F0FDF4" : "#fff", color: selDate === today() ? "#16A34A" : "#777", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Today</button>
          <input type="date" value={selDate} onChange={(e) => setSelDate(e.target.value)} style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11, fontFamily: "inherit", color: "#777", cursor: "pointer", width: 32, background: "#fff" }} />
          <button onClick={load} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 11, color: "#777", cursor: "pointer" }}>🔄</button>
          <PrintBtn sectionId="print-kitchen" title="BK Challan" />
        </div>
      </div>
      {selDate !== today() && <div style={{ padding: "6px 12px", borderRadius: 6, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 11, color: "#92400E", marginBottom: 10, textAlign: "center" }}>Viewing: {selDate}</div>}
      {/* Cycle + Status pills */}
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {[{ id: "morning", label: "🌅 Morning", c: "#B45309", bg: "#FFFBEB", border: "#FDE68A" }, { id: "evening", label: "🌇 Evening", c: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" }, { id: "all", label: "All", c: "#555", bg: "#F5F5F3", border: "#E0E0DC" }].map((c) => (
          <button key={c.id} onClick={() => setCycle(c.id)} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: cycle === c.id ? 700 : 500, border: cycle === c.id ? `1px solid ${c.border}` : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: cycle === c.id ? c.bg : "#fff", color: cycle === c.id ? c.c : "#888", whiteSpace: "nowrap" }}>{c.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowAll(false)} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: !showAll ? 700 : 500, border: !showAll ? "1px solid #FDE68A" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !showAll ? "#FFFBEB" : "#fff", color: !showAll ? "#B45309" : "#888", whiteSpace: "nowrap" }}>Pending</button>
        <button onClick={() => setShowAll(true)} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: showAll ? 700 : 500, border: showAll ? "1px solid #E0E0DC" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: showAll ? "#F5F5F3" : "#fff", color: showAll ? "#555" : "#888", whiteSpace: "nowrap" }}>All</button>
      </div>
      {!showAll && pendingOrders.length === 0 && orders.length > 0 && (<div style={{ padding: "10px 14px", borderRadius: 8, background: "#F0FDF4", border: "1px solid #BBF7D0", fontSize: 12, color: "#166534", marginBottom: 12, textAlign: "center" }}>✅ All issued</div>)}

      <div id="print-demand" style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", marginBottom: 20 }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #E8E8E4", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>📋 Consolidated Demand</span>
          <div style={{ display: "flex", gap: 6 }}><ExportBtn onClick={() => { const headers = ["Item", "Unit", "TOTAL", ...OUTLETS.map((o) => o.short)]; const rows = BK_ITEMS.filter((bk) => consolidated[bk.id]?.total > 0).map((bk) => { const d = consolidated[bk.id]; return [bk.name, bk.unit || "", d.total, ...OUTLETS.map((o) => d.by[o.id] || 0)]; }); exportCSV(headers, rows, `demand_${selDate}.csv`); }} /><PrintBtn sectionId="print-demand" title="Consolidated Demand" /></div>
        </div>
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}><thead><tr style={{ background: "#FAFAF8" }}>{["Item", "TOTAL", ...OUTLETS.map((o) => o.short)].map((h, i) => <th key={i} style={{ ...thS, textAlign: i > 0 ? "center" : "left", color: i === 1 ? "#1A1A1A" : undefined, fontWeight: i === 1 ? 800 : undefined, whiteSpace: "nowrap", minWidth: i === 0 ? 100 : 50, ...(i === 0 ? { position: "sticky", left: 0, background: "#FAFAF8", zIndex: 2 } : {}) }}>{h}</th>)}</tr></thead>
        <tbody>{BK_ITEMS.filter((bk) => consolidated[bk.id]?.total > 0).map((bk) => { const d = consolidated[bk.id]; return (<tr key={bk.id} style={{ borderBottom: "1px solid #F0F0EC" }}><td style={{ ...tdS, fontWeight: 600, position: "sticky", left: 0, background: "#fff", zIndex: 1, whiteSpace: "nowrap" }}>{bk.name} <span style={{ fontSize: 10, color: "#999", fontWeight: 400 }}>{bk.unit}</span></td><td style={{ ...tdS, textAlign: "center", fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: "#B45309" }}>{d.total}</td>{OUTLETS.map((o) => <td key={o.id} style={{ ...tdS, textAlign: "center", color: d.by[o.id] ? "#1A1A1A" : "#DDD" }}>{d.by[o.id] || "—"}</td>)}</tr>); })}</tbody></table></div>
      </div>

    </div>
  );
};



// ═════════════════════════════════════════════════════════════════════════════
//  DISPATCH — with per-item qty editing + printable challan
// ═════════════════════════════════════════════════════════════════════════════
const Dispatch = () => {
  const [orders, setOrders] = useState([]); const [loading, setLoading] = useState(true);
  const [dispatchQty, setDispatchQty] = useState({}); // { orderId: { itemId: qty } }
  const [dispatching, setDispatching] = useState(null);
  const [selOutlet, setSelOutlet] = useState(null);
  const [expandedCat, setExpandedCat] = useState({});
  const [challanOrder, setChallanOrder] = useState(null);
  const [checkedItems, setCheckedItems] = useState({}); // { orderId: { itemId: true } } // order to show challan for
  const load = () => { setLoading(true); api.getOrders({ date: today() }).then(setOrders).catch(() => setOrders([])).finally(() => setLoading(false)); };
  useEffect(load, []);

  const pending = orders.filter((o) => (o.status === "submitted" || o.status === "received" || o.status === "issued") && (!selOutlet || o.outlet_id === selOutlet));
  const done = orders.filter((o) => o.status === "fulfilled" && (!selOutlet || o.outlet_id === selOutlet));
  const allPending = orders.filter((o) => o.status === "submitted" || o.status === "received" || o.status === "issued");
  const allDone = orders.filter((o) => o.status === "fulfilled");

  const getDispQty = (oid, iid, demandedQty) => {
    if (dispatchQty[oid]?.[iid] !== undefined) return dispatchQty[oid][iid];
    return demandedQty; // default: full qty
  };
  const setDQ = (oid, iid, val) => setDispatchQty((p) => ({ ...p, [oid]: { ...(p[oid] || {}), [iid]: val } }));
  const toggleCat = (key) => setExpandedCat((p) => ({ ...p, [key]: !p[key] }));
  const isChecked = (oid, iid) => !!checkedItems[oid]?.[iid];
  const toggleCheck = (oid, iid) => setCheckedItems((p) => ({ ...p, [oid]: { ...(p[oid] || {}), [iid]: !p[oid]?.[iid] } }));
  const checkAllCat = (oid, catItems) => {
    const allChecked = catItems.every(([id]) => isChecked(oid, id));
    setCheckedItems((p) => {
      const oCopy = { ...(p[oid] || {}) };
      catItems.forEach(([id]) => { oCopy[id] = !allChecked; });
      return { ...p, [oid]: oCopy };
    });
  };
  const getCheckedCount = (oid, itemEntries) => itemEntries.filter(([id]) => isChecked(oid, id)).length;

  const doDispatch = async (order) => {
    const itemEntries = order.items ? Object.entries(order.items).filter(([, q]) => q > 0) : [];
    // Only dispatch CHECKED items
    const dispItems = {};
    const remainingItems = {};
    let hasAny = false;
    itemEntries.forEach(([id, demandedQty]) => {
      if (isChecked(order.id, id)) {
        const actualQty = Number(getDispQty(order.id, id, demandedQty)) || 0;
        if (actualQty > 0) { dispItems[id] = actualQty; hasAny = true; }
      } else {
        // Unchecked items stay as remaining
        remainingItems[id] = demandedQty;
      }
    });
    if (!hasAny) { alert("Tick at least 1 item to dispatch"); return; }
    setDispatching(order.id);
    try {
      await api.dispatchOrder(order.id, dispItems, getCurrentUser()?.name || "store", remainingItems);
      setCheckedItems((p) => { const c = { ...p }; delete c[order.id]; return c; });
      setDispatchQty((p) => { const c = { ...p }; delete c[order.id]; return c; });
      load();
    } catch (e) { alert("Error: " + e.message); }
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

  // Get item name from any section
  const getItemName = (id) => {
    for (const sec of DEMAND_SECTIONS) { const it = sec.items.find((i) => i.id === id); if (it) return it.name; }
    const bk = BK_ITEMS.find((b) => b.id === id); if (bk) return bk.name;
    return id;
  };
  const getItemUnit = (id) => {
    for (const sec of DEMAND_SECTIONS) { const it = sec.items.find((i) => i.id === id); if (it) return it.unit; }
    return "";
  };

  // ── CHALLAN VIEW ──
  if (challanOrder) {
    const order = challanOrder;
    const outlet = OUTLETS.find((o) => o.id === order.outlet_id);
    const demanded = order.items || {};
    const dispatched = order.dispatch_items || demanded; // fallback for old orders without dispatch_items
    const allIds = [...new Set([...Object.keys(demanded), ...Object.keys(dispatched)])].filter((id) => (demanded[id] || 0) > 0 || (dispatched[id] || 0) > 0);
    const categories = getItemsByCategory(demanded);
    const dateStr = order.date || today();
    const timeStr = order.dispatched_at ? new Date(order.dispatched_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : new Date(order.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

    const printChallan = () => {
      const pw = window.open("", "_blank");
      const rows = allIds.map((id) => {
        const dem = demanded[id] || 0;
        const disp = dispatched[id] || 0;
        const short = disp < dem;
        return `<tr style="${short ? "background:#FEF2F2" : ""}"><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;font-weight:600">${getItemName(id)}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;color:#999;font-size:11px">${getItemUnit(id)}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;font-family:monospace">${dem}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;font-weight:700;font-family:monospace;color:${short ? "#DC2626" : "#16A34A"}">${disp}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;font-size:11px;color:${short ? "#DC2626" : "#16A34A"}">${short ? "⬇ " + (dem - disp) + " short" : disp === dem ? "✓" : "⬆ +" + (disp - dem)}</td></tr>`;
      }).join("");
      pw.document.write(`<!DOCTYPE html><html><head><title>Dispatch Challan</title><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Outfit',sans-serif;color:#1A1A1A;padding:24px}@media print{body{padding:12px}}</style></head><body><div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1A1A1A;padding-bottom:12px;margin-bottom:16px"><div><h1 style="font-size:18px;font-weight:800">Ananda Cafe — Dispatch Challan</h1><p style="font-size:12px;color:#888;margin-top:2px">🏪 ${outlet?.name || order.outlet_id}</p></div><div style="text-align:right"><div style="font-size:12px;color:#888">${dateStr}</div><div style="font-size:11px;color:#BBB">${timeStr}</div></div></div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#F8F8F5"><th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;border-bottom:2px solid #DDD">Item</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;border-bottom:2px solid #DDD">Unit</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;border-bottom:2px solid #DDD">Demanded</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;border-bottom:2px solid #DDD">Dispatched</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;border-bottom:2px solid #DDD">Status</th></tr></thead><tbody>${rows}</tbody></table><div style="margin-top:20px;display:flex;justify-content:space-between;font-size:11px;color:#999"><span>Total: ${allIds.length} items</span><span>Generated: ${new Date().toLocaleString("en-IN")}</span></div><div style="margin-top:40px;display:flex;justify-content:space-between"><div style="text-align:center"><div style="border-top:1px solid #999;width:120px;margin-top:40px;padding-top:4px;font-size:10px;color:#888">Store Manager</div></div><div style="text-align:center"><div style="border-top:1px solid #999;width:120px;margin-top:40px;padding-top:4px;font-size:10px;color:#888">Transport</div></div><div style="text-align:center"><div style="border-top:1px solid #999;width:120px;margin-top:40px;padding-top:4px;font-size:10px;color:#888">Outlet Manager</div></div></div></body></html>`);
      pw.document.close();
      setTimeout(() => { pw.focus(); pw.print(); }, 400);
    };

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <BackBtn onClick={() => setChallanOrder(null)} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>📋 Dispatch Challan</div>
            <div style={{ fontSize: 11, color: "#999" }}>{outlet?.name} — {dateStr}</div>
          </div>
          <button onClick={printChallan} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 12, fontWeight: 600, color: "#777", cursor: "pointer", fontFamily: "inherit" }}>🖨️ Print</button>
        </div>

        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={thS}>Item</th>
                <th style={{ ...thS, textAlign: "center" }}>Unit</th>
                <th style={{ ...thS, textAlign: "center" }}>Demanded</th>
                <th style={{ ...thS, textAlign: "center" }}>Dispatched</th>
                <th style={{ ...thS, textAlign: "center" }}>Status</th>
              </tr></thead>
              <tbody>
                {allIds.map((id) => {
                  const dem = demanded[id] || 0;
                  const disp = dispatched[id] || 0;
                  const isShort = disp < dem;
                  const isOver = disp > dem;
                  return (
                    <tr key={id} style={{ borderBottom: "1px solid #F0F0EC", background: isShort ? "#FEF2F2" : "transparent" }}>
                      <td style={{ ...tdS, fontWeight: 600 }}>{getItemName(id)}</td>
                      <td style={{ ...tdS, textAlign: "center", color: "#999", fontSize: 11 }}>{getItemUnit(id)}</td>
                      <td style={{ ...tdS, textAlign: "center", fontFamily: "'JetBrains Mono', monospace" }}>{dem}</td>
                      <td style={{ ...tdS, textAlign: "center", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: isShort ? "#DC2626" : "#16A34A" }}>{disp}</td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: isShort ? "#FEF2F2" : "#F0FDF4", color: isShort ? "#DC2626" : "#16A34A" }}>
                          {isShort ? `⬇ ${dem - disp} short` : isOver ? `⬆ +${disp - dem}` : "✓ Full"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;

  const outletCounts = {};
  OUTLETS.forEach((o) => { outletCounts[o.id] = allPending.filter((d) => d.outlet_id === o.id).length; });

  return (
    <div>
      {/* Outlet pills + refresh */}
      <div style={{ display: "flex", gap: 5, marginBottom: 12, overflowX: "auto", paddingBottom: 4, alignItems: "center" }}>
        {OUTLETS.map((o) => {
          const pCount = allPending.filter((d) => d.outlet_id === o.id).length;
          const dCount = allDone.filter((d) => d.outlet_id === o.id).length;
          const isAllDone = pCount === 0 && dCount > 0;
          return (<button key={o.id} onClick={() => setSelOutlet(selOutlet === o.id ? null : o.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: selOutlet === o.id ? 700 : 500, border: selOutlet === o.id ? "1px solid #FDE68A" : isAllDone ? "1px solid #BBF7D0" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selOutlet === o.id ? "#FFFBEB" : isAllDone ? "#F0FDF4" : "#fff", color: selOutlet === o.id ? "#B45309" : "#888", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", flexShrink: 0 }}>
            {isAllDone && <span style={{ fontSize: 9 }}>✅</span>}
            {pCount > 0 && <span style={{ width: 6, height: 6, borderRadius: 3, background: "#F59E0B", flexShrink: 0 }} />}
            {o.short}
          </button>);
        })}
        <div style={{ flex: 1 }} />
        <button onClick={load} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 11, color: "#777", cursor: "pointer", flexShrink: 0 }}>🔄</button>
      </div>

      {pending.length === 0 && <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "40px 20px", textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 8 }}>✓</div><div style={{ color: "#999" }}>{selOutlet ? `No pending for ${OUTLETS.find((o) => o.id === selOutlet)?.name}` : "All dispatched for today"}</div></div>}

      {/* ── PENDING ORDERS ── */}
      {pending.map((order) => {
        const outlet = OUTLETS.find((o) => o.id === order.outlet_id);
        const itemEntries = order.items ? Object.entries(order.items).filter(([, q]) => q > 0) : [];
        const hasItems = itemEntries.length > 0;
        const categories = hasItems ? getItemsByCategory(order.items) : [];
        const filledCount = hasItems ? itemEntries.filter(([id, q]) => Number(getDispQty(order.id, id, q)) > 0).length : 0;
        const hasShortage = hasItems && itemEntries.some(([id, q]) => Number(getDispQty(order.id, id, q)) < q);
        const checkedCount = hasItems ? getCheckedCount(order.id, itemEntries) : 0;
        const allChecked = hasItems && checkedCount === itemEntries.length;

        return (
          <div key={order.id} style={{ marginBottom: 10 }}>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", overflow: "hidden" }}>
            {/* Header */}
            <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #F0F0EC" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{outlet?.short || order.outlet_id}</span>
                <span style={{ fontSize: 10, color: "#999" }}>{order.type === "photo" ? "📷" : "✏️"}</span>
                <span style={{ fontSize: 10, color: "#BBB" }}>{new Date(order.submitted_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {hasShortage && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "#FFFBEB", color: "#B45309", fontWeight: 700 }}>Partial</span>}
                {hasItems && <span style={{ fontSize: 11, fontWeight: 700, color: allChecked ? "#16A34A" : "#B45309" }}>✓{checkedCount}/{itemEntries.length}</span>}
              </div>
            </div>

            {order.note && <div style={{ padding: "8px 18px", fontSize: 12, color: "#888", borderBottom: "1px solid #F0F0EC" }}>📝 {order.note}</div>}

            {/* Category-wise items with qty editing + verification checkboxes */}
            {hasItems ? categories.map(([catId, cat]) => {
              const catKey = `${order.id}_${catId}`;
              const isOpen = expandedCat[catKey] !== false;
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
                    {/* Column headers */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", marginBottom: 4 }}>
                      <span style={{ width: 24 }} />
                      <span style={{ flex: 1, fontSize: 9, fontWeight: 700, color: "#BBB", textTransform: "uppercase", letterSpacing: 0.5 }}>Item</span>
                      <span style={{ width: 50, textAlign: "center", fontSize: 9, fontWeight: 700, color: "#BBB", textTransform: "uppercase" }}>Asked</span>
                      <span style={{ width: 56, textAlign: "center", fontSize: 9, fontWeight: 700, color: "#BBB", textTransform: "uppercase" }}>Send</span>
                      <span style={{ width: 28 }} />
                    </div>
                    {cat.items.map(([id, qty]) => {
                      const dispVal = getDispQty(order.id, id, qty);
                      const isShort = Number(dispVal) < qty;
                      const isZero = Number(dispVal) === 0;
                      const checked = isChecked(order.id, id);
                      return (
                        <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px", borderRadius: 10, marginBottom: 2, background: checked ? "#F0FDF4" : isZero ? "#FEF2F2" : isShort ? "#FFFBEB" : "transparent", opacity: checked ? 0.7 : 1 }}>
                          <button onClick={() => toggleCheck(order.id, id)} style={{ width: 24, height: 24, borderRadius: 6, border: checked ? "2px solid #16A34A" : "2px solid #D0D0CC", background: checked ? "#16A34A" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, padding: 0 }}>
                            {checked && <span style={{ color: "#fff", fontSize: 13, fontWeight: 800 }}>✓</span>}
                          </button>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: isZero ? "#DC2626" : "#1A1A1A", textDecoration: checked ? "line-through" : "none" }}>{getItemName(id)}</span>
                          <span style={{ width: 50, textAlign: "center", fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#888" }}>{qty}</span>
                          <input type="number" inputMode="numeric" min="0" value={dispVal}
                            onChange={(e) => setDQ(order.id, id, Math.max(0, Number(e.target.value) || 0))}
                            disabled={checked}
                            style={{ width: 56, padding: "5px 4px", borderRadius: 6, border: isShort ? "2px solid #F59E0B" : isZero ? "2px solid #DC2626" : "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: isZero ? "#DC2626" : isShort ? "#B45309" : "#16A34A", background: checked ? "#F0FDF4" : "#fff" }} />
                          <span style={{ fontSize: 10, color: "#999", width: 28 }}>{getItemUnit(id)}</span>
                        </div>
                      );
                    })}
                  </div>}
                </div>
              );
            }) : <div style={{ padding: "14px 18px", fontSize: 12, color: "#888" }}>📷 Photo order — verify manually.</div>}
          </div>
          {/* Dispatch button — sticky at page bottom, outside overflow card */}
          <div style={{ position: "sticky", bottom: 0, padding: "8px 0", background: "linear-gradient(transparent, #FAF9F6 20%)", zIndex: 10 }}>
              <button onClick={() => doDispatch(order)} disabled={dispatching === order.id || checkedCount === 0}
                style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: checkedCount === 0 ? "#D0D0CC" : dispatching === order.id ? "#D0D0CC" : checkedCount < itemEntries.length ? "#B45309" : "#16A34A", color: "#fff", fontWeight: 800, fontSize: 16, cursor: checkedCount === 0 || dispatching === order.id ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                {dispatching === order.id ? "⏳ Dispatching..." : checkedCount === 0 ? "✅ Tick items to dispatch" : checkedCount < itemEntries.length ? `🚚 Dispatch ${checkedCount}/${itemEntries.length} items to ${outlet?.name}` : `🚚 Dispatch All to ${outlet?.name}`}
              </button>
          </div>
          </div>
        );
      })}

      {/* ── DISPATCHED TODAY ── */}
      {done.length > 0 && (<div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "#16A34A" }}>✅ Dispatched Today</div>
        {done.map((order) => {
          const outlet = OUTLETS.find((o) => o.id === order.outlet_id);
          const hasShortage = order.dispatch_items && order.items && Object.keys(order.items).some((id) => (order.dispatch_items[id] || 0) < (order.items[id] || 0));
          return (
            <div key={order.id} onClick={() => setChallanOrder(order)} style={{ background: hasShortage ? "#FFFBEB" : "#F0FDF4", borderRadius: 12, border: `1px solid ${hasShortage ? "#FDE68A" : "#BBF7D0"}`, padding: "12px 16px", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{outlet?.name || order.outlet_id}</span>
                <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: hasShortage ? "#FDE68A" : "#DCFCE7", color: hasShortage ? "#B45309" : "#16A34A" }}>{hasShortage ? "PARTIAL" : "FULL"}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "#999" }}>{order.dispatched_at ? new Date(order.dispatched_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                <span style={{ fontSize: 11, color: "#2563EB", fontWeight: 600 }}>📋 Challan →</span>
              </div>
            </div>
          );
        })}
      </div>)}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  INVENTORY MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
//  ORDER CHALLAN — RM Order based, standalone component
// ═════════════════════════════════════════════════════════════════════════════
const ORDER_VENDORS = [
  { id: "vegetable", label: "🥬 Vegetables", categories: ["Vegetable"], period: "daily", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  { id: "dairy", label: "🥛 Dairy", categories: ["Dairy"], period: "daily", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  { id: "gas", label: "🔥 Gas", categories: ["Gas"], period: "daily", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  { id: "grocery_masala", label: "🛒 Grocery & Masala", categories: ["Grocery", "Food", "Masala"], period: "10day", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
  { id: "packaging_cleaning", label: "📦 Packaging & Cleaning", categories: ["Packaging", "Cleaning"], period: "10day", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
];
const OrderChallanView = ({ items, categories, displayCategory, selCat, setSelCat, orderQty, setOrderQty, setView, setDraft, fmt }) => {
  const [rmConfig, setRmConfig] = useState({});
  const [usageSuggestion, setUsageSuggestion] = useState({});
  const [rmLoading, setRmLoading] = useState(true);
  const [challanSaving, setChallanSaving] = useState(false);
  const [rmEditing, setRmEditing] = useState(false);
  const [rmDraft, setRmDraft] = useState({});
  const [pendingPOs, setPendingPOs] = useState([]);
  const [selVendor, setSelVendor] = useState(null);
  useEffect(() => { setRmLoading(true); Promise.all([api.getRmOrderConfig().catch(()=>[]),api.getRmUsageSuggestion().catch(()=>({})),api.getPurchaseOrders({status:"pending",limit:10}).catch(()=>[])]).then(([config,usage,orders])=>{const m={};(config||[]).forEach(c=>{m[c.item_id]=Number(c.rm_qty)||0});setRmConfig(m);setRmDraft(m);setUsageSuggestion(usage||{});setPendingPOs(orders||[])}).finally(()=>setRmLoading(false)); }, []);
  const getVendorItems = (v) => items.filter(i => v.categories.includes(displayCategory(i.category))).map(item => { const rmQty = Number(rmConfig[item.id]) || 0; const currentQty = Number(item.current_qty) || 0; return { ...item, rmQty, orderQtyCalc: Math.max(0, rmQty - currentQty) }; });
  const saveRmConfig = async () => { const v = ORDER_VENDORS.find(x=>x.id===selVendor); const vi = items.filter(i=>v?.categories.includes(displayCategory(i.category))); const entries = vi.filter(i=>rmDraft[i.id]>0).map(i=>({item_id:i.id,rm_qty:rmDraft[i.id],rm_unit:i.unit})); try { await api.saveRmOrderConfig(entries); setRmConfig(p=>{const n={...p};entries.forEach(e=>{n[e.item_id]=e.rm_qty});return n}); setRmEditing(false); alert(`✅ Saved ${v?.label} — ${entries.length} items`); } catch(e){alert("Error: "+e.message)} };
  const generateChallan = async (v) => { const vi = getVendorItems(v); const ci = {}; vi.forEach(item=>{const eq=Number(orderQty[item.id]);const fq=!isNaN(eq)&&eq>=0?eq:item.orderQtyCalc;if(fq>0)ci[item.id]={name:item.name,unit:item.unit,category:displayCategory(item.category),rm_qty:item.rmQty,current_stock:Number(item.current_qty),order_qty:fq}}); if(!Object.keys(ci).length){alert("No items");return} setChallanSaving(true); try{const r=await api.createPurchaseOrder({items:ci,notes:v.label,created_by:getCurrentUser()?.name||"store"});alert(`✅ ${v.label} Challan ${r.order_number} created`);printChallan(r,v)}catch(e){alert("Error: "+e.message)}finally{setChallanSaving(false)} };
  const printChallan = (order, v) => { const pw=window.open("","_blank"); const oi=order.items||{}; const rows=Object.entries(oi).sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([,item])=>`<tr><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;font-weight:600">${item.name}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;font-family:monospace">${item.current_stock}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;font-family:monospace">${item.rm_qty}</td><td style="padding:8px 10px;border-bottom:1px solid #E8E8E4;text-align:center;font-weight:700;font-family:monospace;color:#2563EB;font-size:16px">${item.order_qty} ${item.unit}</td></tr>`).join(""); pw.document.write(`<!DOCTYPE html><html><head><title>${v?.label} Order</title><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Outfit',sans-serif;color:#1A1A1A;padding:24px}@media print{body{padding:12px}}</style></head><body><div style="border-bottom:2px solid #1A1A1A;padding-bottom:12px;margin-bottom:16px"><h1 style="font-size:18px;font-weight:800">Ananda Cafe — ${v?.label} Order</h1><p style="font-size:12px;color:#888">${order.order_number} · ${order.date}</p></div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#F8F8F5"><th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#666;border-bottom:2px solid #DDD">Item</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;border-bottom:2px solid #DDD">Stock</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;border-bottom:2px solid #DDD">${v?.period==="daily"?"Daily Req":"10-Day Req"}</th><th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;color:#666;border-bottom:2px solid #DDD">Order Qty</th></tr></thead><tbody>${rows}</tbody></table><div style="margin-top:20px;font-size:11px;color:#999">Total: ${Object.keys(oi).length} items</div><div style="margin-top:40px;display:flex;justify-content:space-between"><div style="text-align:center"><div style="border-top:1px solid #999;width:120px;margin-top:40px;padding-top:4px;font-size:10px;color:#888">Store Manager</div></div><div style="text-align:center"><div style="border-top:1px solid #999;width:120px;margin-top:40px;padding-top:4px;font-size:10px;color:#888">Vendor</div></div></div></body></html>`); pw.document.close(); setTimeout(()=>{pw.focus();pw.print()},400) };
  const shareChallanWA = (v) => { const vi=getVendorItems(v); const lines=[`*🛒 Ananda Cafe — ${v.label} Order*`,`📅 ${today()}`,""]; vi.forEach(item=>{const eq=Number(orderQty[item.id]);const fq=!isNaN(eq)&&eq>=0?eq:item.orderQtyCalc;if(fq>0)lines.push(`• ${item.name}: *${fq} ${item.unit}*`)}); lines.push("",`Total: ${lines.filter(l=>l.startsWith("•")).length} items`); window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`,"_blank") };
  if (rmLoading) return <div style={{textAlign:"center",padding:40,color:"#999"}}>⏳ Loading...</div>;
  if (rmEditing && selVendor) { const v=ORDER_VENDORS.find(x=>x.id===selVendor); const vi=items.filter(i=>v?.categories.includes(displayCategory(i.category))); return (<div><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}><BackBtn onClick={()=>setRmEditing(false)} /><div style={{flex:1}}><div style={{fontSize:15,fontWeight:800}}>⚙️ Set {v?.label} Requirement</div><div style={{fontSize:11,color:"#888"}}>{v?.period==="daily"?"Daily requirement":"10-day requirement"}</div></div></div><div style={{padding:"10px 14px",borderRadius:10,background:"#EFF6FF",border:"1px solid #BFDBFE",fontSize:12,color:"#1D4ED8",marginBottom:14}}>Set qty needed for {v?.period==="daily"?"1 day":"10 days"}. Last 10d usage shown as suggestion.</div>{vi.map(item=>{const usage=Math.round((usageSuggestion[item.id]||0)*100)/100;return(<div key={item.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:10,background:rmDraft[item.id]>0?"#EFF6FF":"#FAFAF8",marginBottom:3}}><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{item.name}</div><div style={{fontSize:10,color:"#999"}}>10d usage: <strong style={{color:usage>0?"#2563EB":"#CCC"}}>{usage||"—"}</strong>{v?.period==="daily"&&usage>0&&<span> · ~{Math.round(usage/10*100)/100}/day</span>}</div></div><input type="number" inputMode="numeric" min="0" placeholder="0" value={rmDraft[item.id]||""} onChange={e=>setRmDraft(p=>({...p,[item.id]:Math.max(0,+e.target.value||0)}))} style={{width:70,padding:"6px",borderRadius:8,border:"1px solid #E0E0DC",fontSize:15,textAlign:"center",fontFamily:"inherit",fontWeight:700}} /><span style={{fontSize:10,color:"#999",width:28}}>{item.unit}</span></div>)})}<div style={{position:"sticky",bottom:0,padding:"12px 0",background:"linear-gradient(transparent, #FAF9F6 20%)",zIndex:10}}><button onClick={saveRmConfig} style={{width:"100%",padding:"14px",borderRadius:14,border:"none",background:v?.color||"#2563EB",color:"#fff",fontWeight:800,fontSize:16,cursor:"pointer",fontFamily:"inherit"}}>💾 Save {v?.label} Config</button></div></div>); }
  if (selVendor) { const v=ORDER_VENDORS.find(x=>x.id===selVendor); const vi=getVendorItems(v); const tot=vi.filter(i=>{const e=Number(orderQty[i.id]);return(!isNaN(e)?e:i.orderQtyCalc)>0}).length; const hasConfig=vi.some(i=>i.rmQty>0); return (<div><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}><BackBtn onClick={()=>{setSelVendor(null);setOrderQty({})}} /><div style={{flex:1}}><div style={{fontSize:15,fontWeight:800}}>{v?.label} Order</div><div style={{fontSize:11,color:"#888"}}>{v?.period==="daily"?"Daily order":"10-day RM order"}</div></div><button onClick={()=>setRmEditing(true)} style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${v?.border}`,background:v?.bg,fontSize:10,fontWeight:700,color:v?.color,cursor:"pointer",fontFamily:"inherit"}}>⚙️ Set Req</button></div>{!hasConfig&&<div style={{padding:20,textAlign:"center",background:v?.bg,borderRadius:14,border:`1px solid ${v?.border}`,marginBottom:16}}><div style={{fontSize:36,marginBottom:8}}>📦</div><div style={{fontSize:14,fontWeight:700,color:v?.color,marginBottom:4}}>Set {v?.period==="daily"?"daily":"10-day"} requirement first</div><button onClick={()=>setRmEditing(true)} style={{padding:"10px 20px",borderRadius:10,border:"none",background:v?.color,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit",marginTop:8}}>⚙️ Set Requirement</button></div>}{hasConfig&&<><div style={{padding:"8px 12px",borderRadius:10,background:"#F0FDF4",border:"1px solid #BBF7D0",fontSize:11,color:"#166534",marginBottom:14,display:"flex",justifyContent:"space-between"}}><span>Order = {v?.period==="daily"?"Daily Req":"10-Day Req"} − Stock</span><span style={{fontWeight:700}}>{tot} items</span></div>{vi.map(item=>{const e=Number(orderQty[item.id]);const fq=!isNaN(e)&&e>=0?e:item.orderQtyCalc;const need=fq>0;return(<div key={item.id} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 12px",borderRadius:10,background:need?v?.bg:"#FAFAF8",marginBottom:3,border:need?`1px solid ${v?.border}`:"1px solid transparent"}}><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{item.name}</div><div style={{fontSize:10,color:"#999"}}>Req: <strong>{item.rmQty}</strong> − Stock: <strong style={{color:Number(item.current_qty)===0?"#DC2626":"#888"}}>{item.current_qty}</strong> = <strong style={{color:v?.color}}>{item.orderQtyCalc}</strong> {item.unit}</div></div><input type="number" inputMode="numeric" min="0" placeholder={String(item.orderQtyCalc)} value={orderQty[item.id]??""} onChange={e=>setOrderQty(p=>({...p,[item.id]:e.target.value}))} style={{width:64,padding:"6px",borderRadius:8,border:need?`2px solid ${v?.color}`:"1px solid #E0E0DC",fontSize:16,textAlign:"center",fontFamily:"'JetBrains Mono'",fontWeight:800,background:"#fff"}} /><span style={{fontSize:10,color:"#999",width:28}}>{item.unit}</span></div>)})}<div style={{position:"sticky",bottom:0,padding:"12px 0",background:"linear-gradient(transparent, #FAF9F6 20%)",zIndex:10}}><div style={{display:"flex",gap:8}}><button onClick={()=>shareChallanWA(v)} style={{flex:1,padding:"12px",borderRadius:12,border:"1px solid #BBF7D0",background:"#F0FDF4",color:"#16A34A",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>💬 WhatsApp</button><button onClick={()=>generateChallan(v)} disabled={challanSaving||tot===0} style={{flex:2,padding:"12px",borderRadius:12,border:"none",background:tot>0&&!challanSaving?v?.color:"#D0D0CC",color:"#fff",fontWeight:800,fontSize:14,cursor:tot>0?"pointer":"not-allowed",fontFamily:"inherit"}}>{challanSaving?"⏳...":`📝 Challan (${tot})`}</button></div></div></>}</div>); }
  const dailyV=ORDER_VENDORS.filter(v=>v.period==="daily");const rmV=ORDER_VENDORS.filter(v=>v.period==="10day");
  return (<div><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}><BackBtn onClick={()=>setView("stock")} /><div style={{flex:1,fontSize:15,fontWeight:800}}>📝 Order Challan</div></div>{pendingPOs.length>0&&<div style={{marginBottom:20}}><div style={{fontSize:12,fontWeight:700,color:"#B45309",marginBottom:8}}>📋 Pending Orders — tap to receive</div>{pendingPOs.map(po=><div key={po.id} onClick={()=>{setDraft({});Object.entries(po.items||{}).forEach(([id,item])=>{setDraft(p=>({...p,[id]:item.order_qty}))});setView("stock_in")}} style={{padding:"10px 14px",borderRadius:10,background:"#FFFBEB",border:"1px solid #FDE68A",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}><div><div style={{fontSize:13,fontWeight:700}}>{po.order_number}</div><div style={{fontSize:10,color:"#999"}}>{po.total_items} items · {po.notes||""} · {po.date}</div></div><span style={{fontSize:11,color:"#2563EB",fontWeight:600}}>📥 Receive →</span></div>)}</div>}<div style={{fontSize:12,fontWeight:700,color:"#16A34A",marginBottom:8}}>🔄 Daily Orders</div><div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:8,marginBottom:20}}>{dailyV.map(v=>{const vi=getVendorItems(v);const need=vi.filter(i=>i.orderQtyCalc>0).length;return(<button key={v.id} onClick={()=>setSelVendor(v.id)} style={{padding:"14px 8px",borderRadius:14,border:`1px solid ${v.border}`,background:v.bg,cursor:"pointer",fontFamily:"inherit",textAlign:"center"}}><div style={{fontSize:24,marginBottom:2}}>{v.label.split(" ")[0]}</div><div style={{fontSize:12,fontWeight:700,color:v.color}}>{v.label.split(" ").slice(1).join(" ")}</div><div style={{fontSize:10,color:"#999",marginTop:2}}>{vi.length} items</div>{need>0&&<div style={{fontSize:11,fontWeight:700,color:v.color,marginTop:2}}>{need} to order</div>}</button>)})}</div><div style={{fontSize:12,fontWeight:700,color:"#B45309",marginBottom:8}}>📦 10-Day RM Orders</div><div style={{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:8}}>{rmV.map(v=>{const vi=getVendorItems(v);const need=vi.filter(i=>i.orderQtyCalc>0).length;return(<button key={v.id} onClick={()=>setSelVendor(v.id)} style={{padding:"14px 8px",borderRadius:14,border:`1px solid ${v.border}`,background:v.bg,cursor:"pointer",fontFamily:"inherit",textAlign:"center"}}><div style={{fontSize:24,marginBottom:2}}>{v.label.split(" ")[0]}</div><div style={{fontSize:12,fontWeight:700,color:v.color}}>{v.label.split(" ").slice(1).join(" ")}</div><div style={{fontSize:10,color:"#999",marginTop:2}}>{vi.length} items</div>{need>0&&<div style={{fontSize:11,fontWeight:700,color:v.color,marginTop:2}}>{need} to order</div>}</button>)})}</div></div>);
};

const Inventory = () => {
  const [items, setItems] = useState([]); const [loading, setLoading] = useState(true);
  const [view, setView] = useState("stock"); // stock, stock_in, stock_out, smart_stock_out, thresholds, history
  const [selCat, setSelCat] = useState(null);
  const [draft, setDraft] = useState({}); // { item_id: qty }
  const [saving, setSaving] = useState(false);
  const [selItem, setSelItem] = useState(null); // for history
  const [movements, setMovements] = useState([]);
  const [thresholds, setThresholds] = useState({});
  const [orderQty, setOrderQty] = useState({});
  const [rawReqData, setRawReqData] = useState({}); // raw material requisition from BK
  const [originalReq, setOriginalReq] = useState({}); // original calculated values for audit
  const [stockFilter, setStockFilter] = useState("all"); // all, low, out
  const [invSection, setInvSection] = useState("stockout"); // inventory, stockout
  const [stockInPrices, setStockInPrices] = useState({}); // { item_id: total_price }
  const [issuedItems, setIssuedItems] = useState({}); // { rawId: true/false }
  const [editedQty, setEditedQty] = useState({}); // { rawId: "edited value" }
  const [issuing, setIssuing] = useState(false);
  const [editingItem, setEditingItem] = useState(null); // id of item being edited
  const [editQtyVal, setEditQtyVal] = useState("");
  const [stockOutView, setStockOutView] = useState("bk"); // bk, sec23, sec31, sec56, elan
  const [stockOutData, setStockOutData] = useState(null);
  const [stockOutLoading, setStockOutLoading] = useState(false);
  const [bkDemandDisplay, setBkDemandDisplay] = useState({}); // BK view only: bkId → { raw, unit, baseQty, baseUnit, converted, itemName }
  const [extraItems, setExtraItems] = useState({}); // manually added items: { tempId: { name, qty, unit, inv_id, manual: true } }
  const [removedItems, setRemovedItems] = useState({}); // ids removed from view: { id: true }
  const [addItemSearch, setAddItemSearch] = useState(""); // search text for add-item panel
  const [addItemQty, setAddItemQty] = useState(""); // qty for item being added
  const [showAddPanel, setShowAddPanel] = useState(false);

  // Auto-load stock out data when view changes
  useEffect(() => {
    setStockOutLoading(true);
    api.getOrders({ date: today() }).then((ordersData) => {
      const manualOrders = ordersData.filter((d) => d.type === "manual" && d.items && (d.status === "submitted" || d.status === "received"));
      if (stockOutView === "bk") {
        // BK raw materials from recipes — with unit conversion support.
        // Example: demand "2 Batch Dosa Batter" → convert to 36 Kg → then compute raw materials.
        const foodSection = DEMAND_SECTIONS.find((s) => s.id === "food");
        const foodItems = foodSection?.items || [];
        // Consolidate demand across outlets, converted to base units (Kg for BK items)
        const consolidatedKg = {}; // bkId → total Kg demanded
        const originalDemand = {}; // bkId → { raw: number, unit: string, converted: true/false } for UI display
        foodItems.forEach((item) => {
          let totalRaw = 0;
          manualOrders.forEach((o) => { totalRaw += (o.items?.[item.id] || 0); });
          if (totalRaw === 0) return;
          const conv = convertToBase(totalRaw, item.unit, item.id, item.name);
          consolidatedKg[item.id] = conv.qty; // e.g. 36 Kg
          originalDemand[item.id] = { raw: totalRaw, unit: item.unit, baseQty: conv.qty, baseUnit: conv.unit, converted: conv.converted, itemName: item.name };
        });
        const rawReq = {};
        Object.entries(consolidatedKg).forEach(([bkId, totalBaseQty]) => {
          const recipe = RECIPES[bkId]; if (!recipe) return;
          const batches = totalBaseQty / recipe.yieldQty;
          recipe.ingredients.forEach((ing) => {
            const raw = RAW_MATERIALS.find((r) => r.id === ing.rawId);
            if (!rawReq[ing.rawId]) rawReq[ing.rawId] = { name: raw?.name || ing.rawId, qty: 0, unit: raw?.unit || "Kg", inv_id: raw?.inv_id || null };
            rawReq[ing.rawId].qty += ing.qty * batches;
          });
        });
        setStockOutData(rawReq);
        setBkDemandDisplay(originalDemand);
      } else {
        // Direct items for specific outlet — with unit conversion.
        // Example: outlet demands "1 Tin Fortune Oil" → deduct 15 Ltr from inventory.
        const nonFoodSections = DEMAND_SECTIONS.filter((s) => s.id !== "food");
        const outletOrders = manualOrders.filter((o) => o.outlet_id === stockOutView);
        const directItems = {};
        outletOrders.forEach((o) => {
          nonFoodSections.forEach((sec) => { sec.items.forEach((item) => {
            const qty = o.items?.[item.id] || 0;
            if (qty > 0) {
              const conv = convertToBase(qty, item.unit, item.id, item.name);
              if (!directItems[item.id]) {
                directItems[item.id] = {
                  name: item.name,
                  qty: 0,           // accumulated in BASE unit (for inventory deduction)
                  rawQty: 0,        // accumulated in ORIGINAL unit (for display)
                  unit: conv.unit,  // base unit
                  rawUnit: item.unit, // original demand unit
                  converted: conv.converted,
                  factor: conv.factor,
                  category: sec.titleHi,
                };
              }
              directItems[item.id].qty += conv.qty;
              directItems[item.id].rawQty += Number(qty);
            }
          }); });
        });
        setStockOutData(directItems);
        setBkDemandDisplay({});
      }
    }).catch(() => setStockOutData(null)).finally(() => setStockOutLoading(false));
  }, [stockOutView, items]);

  const load = () => { setLoading(true); api.getInventory().then(setItems).catch(() => setItems([])).finally(() => setLoading(false)); };
  useEffect(load, []);

  // ─── BK-prepared items: hide from Current Inventory view ───
  // These items are PRODUCED in the base kitchen, not STORED — their "stock" is
  // really raw material availability. Identified via demand_item_id matching
  // any item in the food section of DEMAND_SECTIONS (DB-driven).
  const bkPreparedIds = useMemo(() => {
    const foodSection = DEMAND_SECTIONS.find((s) => s.id === "food");
    return new Set((foodSection?.items || []).map((i) => i.id));
  }, []);
  // Also build a Set of BK item NAMES (normalized) as a fallback when inventory items
  // don't have demand_item_id populated in the DB. This catches items by name match.
  const bkPreparedNames = useMemo(() => {
    const foodSection = DEMAND_SECTIONS.find((s) => s.id === "food");
    const norm = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
    return new Set((foodSection?.items || []).map((i) => norm(i.name)));
  }, []);
  const isBkPrepared = (item) => {
    // Only filter items that are explicitly linked to a BK food demand item via demand_item_id
    // Do NOT use id or name matching — it incorrectly filters raw materials like roasted_chana
    if (item.demand_item_id && bkPreparedIds.has(item.demand_item_id)) return true;
    return false;
  };

  // Display-only: rename "Food" category label → "Grocery" (raw groceries, not prepared food)
  const displayCategory = (cat) => cat === "Food" ? "Grocery" : cat;

  // `items` stays unfiltered (needed for Stock Out logic which uses ALL items).
  // `invItems` is the filtered list used ONLY by Current Inventory view.
  const invItems = items.filter((i) => !isBkPrepared(i));

  const categories = [...new Set(invItems.map((i) => displayCategory(i.category)))];
  const filtered = selCat ? invItems.filter((i) => displayCategory(i.category) === selCat) : invItems;
  const alerts = invItems.filter((i) => i.below_threshold);
  const outOfStock = invItems.filter((i) => Number(i.current_qty) === 0);

  const submitStockIn = async () => {
    const entries = Object.entries(draft).filter(([, q]) => q > 0).map(([item_id, quantity]) => ({
      item_id, quantity,
      total_price: Number(stockInPrices[item_id]) || 0,
      unit_price: (Number(stockInPrices[item_id]) || 0) / quantity,
    }));
    if (entries.length === 0) return;
    setSaving(true);
    try { await api.stockIn(entries, "purchase", getCurrentUser()?.name); setDraft({}); setStockInPrices({}); load(); setView("stock"); } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const submitStockOut = async () => {
    const entries = Object.entries(draft).filter(([, q]) => q > 0).map(([item_id, quantity]) => ({ item_id, quantity }));
    if (entries.length === 0) return;
    setSaving(true);
    try {
      await api.stockOut(entries, "issuance");
      // Save audit: original calculated vs actual issued
      if (Object.keys(originalReq).length > 0) {
        const auditEntries = entries.map(({ item_id, quantity }) => ({
          item_id,
          item_name: items.find((i) => i.id === item_id)?.name || item_id,
          calculated_qty: originalReq[item_id] || 0,
          issued_qty: quantity,
          variance: quantity - (originalReq[item_id] || 0),
          date: today(),
        }));
        try { await api.saveIssuanceAudit(auditEntries); } catch (e) { console.error("Audit save failed:", e); }
        // Mark orders as "issued" in database
        for (const orderId of issuedForOrders) {
          try { await api.updateOrderStatus(orderId, "issued"); } catch (e) { console.error("Status update failed:", e); }
        }
      }
      setDraft({}); setOriginalReq({}); setIssuedForOrders([]); load(); setView("stock");
    } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const [issuedForOrders, setIssuedForOrders] = useState([]);

  // Load raw material requisition from BK — PENDING orders only
  const loadSmartStockOut = async () => {
    try {
      const ordersData = await api.getOrders({ date: today() });
      // Only use pending orders (not issued, not dispatched)
      const pendingOrders = ordersData.filter((d) => d.type === "manual" && d.items && (d.status === "submitted" || d.status === "received"));

      if (pendingOrders.length === 0) {
        alert("No pending demands to issue. All demands have been issued or dispatched.");
        return;
      }

      const consolidated = {};
      BK_ITEMS.forEach((bk) => {
        consolidated[bk.id] = { total: 0 };
        pendingOrders.forEach((o) => { consolidated[bk.id].total += (o.items?.[bk.id] || 0); });
      });
      const rawReq = {};
      Object.entries(consolidated).forEach(([bkId, data]) => {
        const recipe = RECIPES[bkId];
        if (!recipe || data.total === 0) return;
        const batches = data.total / recipe.yieldQty;
        recipe.ingredients.forEach((ing) => {
          rawReq[ing.rawId] = (rawReq[ing.rawId] || 0) + ing.qty * batches;
        });
      });
      // Match rawReq IDs to inventory item IDs and pre-fill draft
      const newDraft = {};
      const newOriginal = {};
      Object.entries(rawReq).forEach(([rawId, qty]) => {
        const raw = RAW_MATERIALS.find((r) => r.id === rawId);
        if (!raw) return;
        // Direct inventory item lookup via inv_id (DB-mapped)
        const invItem = raw.inv_id ? items.find((i) => i.id === raw.inv_id) : null;
        if (invItem) {
          const rounded = Math.round(qty * 100) / 100;
          newDraft[invItem.id] = rounded;
          newOriginal[invItem.id] = rounded;
        }
      });
      setDraft(newDraft);
      setOriginalReq(newOriginal);
      setRawReqData(rawReq);
      setIssuedForOrders(pendingOrders.map((o) => o.id));
      setView("stock_out");
    } catch (e) {
      alert("Failed to load requisition: " + e.message);
    }
  };

  const saveThresholds = async () => {
    const entries = Object.entries(thresholds).filter(([id, t]) => { const item = items.find((i) => i.id === id); return item && Number(t) !== item.threshold; }).map(([id, threshold]) => ({ id, threshold: Number(threshold) }));
    if (entries.length === 0) return;
    setSaving(true);
    try { await api.bulkUpdateThresholds(entries); load(); setView("stock"); } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const loadHistory = async (itemId) => { setSelItem(itemId); try { const data = await api.getMovements(itemId); setMovements(data); } catch (e) { setMovements([]); } setView("history"); };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading inventory...</div>;

  // ── HISTORY VIEW ──
  if (view === "history" && selItem) {
    const item = items.find((i) => i.id === selItem);
    return (<div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setView("stock")} /><div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 800 }}>{item?.name || selItem}</div><div style={{ fontSize: 11, color: "#999" }}>Stock: {item?.current_qty} {item?.unit}</div></div></div>
      {movements.length === 0 ? <div style={{ textAlign: "center", padding: 40, color: "#999" }}>No movements yet</div> : movements.map((m) => (
        <div key={m.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "10px 14px", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><span style={{ fontSize: 12, fontWeight: 700, color: m.type === "stock_in" ? "#16A34A" : m.type === "stock_out" ? "#DC2626" : "#B45309" }}>{m.type === "stock_in" ? "📥 IN" : m.type === "stock_out" ? "📤 OUT" : "🔄 ADJ"}</span><span style={{ fontSize: 12, color: "#888", marginLeft: 8 }}>{m.reason}</span></div>
          <div style={{ textAlign: "right" }}><div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: m.quantity > 0 ? "#16A34A" : "#DC2626" }}>{m.quantity > 0 ? "+" : ""}{m.quantity}</div><div style={{ fontSize: 10, color: "#999" }}>{new Date(m.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} {new Date(m.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div></div>
        </div>
      ))}
    </div>);
  }

  // ── STOCK IN / OUT VIEW ──
  if (view === "stock_in" || view === "stock_out") {
    const isIn = view === "stock_in";
    const count = Object.values(draft).filter((v) => v > 0).length;
    const hasPreFill = Object.keys(originalReq).length > 0;
    return (<div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => { setView("stock"); setDraft({}); setOriginalReq({}); }} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>{isIn ? "📥 Stock In" : hasPreFill ? "📤 Smart Issue (from Requisition)" : "📤 Stock Out"}</div>{count > 0 && <span style={{ padding: "3px 10px", borderRadius: 6, background: isIn ? "#F0FDF4" : "#FEF2F2", color: isIn ? "#16A34A" : "#DC2626", fontSize: 11, fontWeight: 700 }}>{count} items</span>}</div>
      {hasPreFill && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#EFF6FF", border: "1px solid #BFDBFE", marginBottom: 14, fontSize: 12, color: "#2563EB" }}>
          ℹ️ Pre-filled from today's Raw Material Requisition. Edit quantities as needed — changes will be tracked in audit.
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}><button onClick={() => setSelCat(null)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: !selCat ? 700 : 500, border: !selCat ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selCat ? "#1A1A1A" : "#fff", color: !selCat ? "#fff" : "#888" }}>All</button>{categories.map((c) => (<button key={c} onClick={() => setSelCat(c)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: selCat === c ? 700 : 500, border: selCat === c ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selCat === c ? "#1A1A1A" : "#fff", color: selCat === c ? "#fff" : "#888" }}>{c}</button>))}</div>
      {filtered.map((item) => {
        const preFilled = originalReq[item.id];
        const isEdited = preFilled !== undefined && draft[item.id] !== preFilled;
        const qty = Number(draft[item.id]) || 0;
        const price = Number(stockInPrices[item.id]) || 0;
        const perUnit = qty > 0 && price > 0 ? Math.round(price / qty * 100) / 100 : 0;
        return (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 10, background: isEdited ? "#FFFBEB" : draft[item.id] > 0 ? (isIn ? "#F0FDF4" : "#FEF2F2") : "#FAFAF8", marginBottom: 3, border: isEdited ? "1px solid #FDE68A" : "1px solid transparent" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
            <div style={{ fontSize: 10, color: "#999" }}>
              {item.current_qty} {item.unit}
              {item.last_unit_price > 0 && <span style={{ color: "#888" }}> · ₹{Math.round(item.last_unit_price * 100) / 100}/{item.unit}</span>}
              {isIn && perUnit > 0 && <span style={{ color: "#16A34A", fontWeight: 600 }}> → ₹{perUnit}/{item.unit}</span>}
            </div>
          </div>
          <input type="number" inputMode="numeric" min="0" step="0.01" placeholder="0" value={draft[item.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 52, padding: "6px 4px", borderRadius: 8, border: isEdited ? "2px solid #B45309" : "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} />
          <span style={{ fontSize: 9, color: "#999", width: 20 }}>{item.unit}</span>
          {isIn && <input type="number" inputMode="numeric" min="0" placeholder="₹" value={stockInPrices[item.id] || ""} onChange={(e) => setStockInPrices((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 56, padding: "6px 4px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "inherit", fontWeight: 700, color: "#16A34A", background: price > 0 ? "#F0FDF4" : "#fff" }} />}
        </div>);
      })}
      <div style={{ position: "sticky", bottom: 0, padding: "12px 0", background: "linear-gradient(transparent, #FAF9F6 20%)", zIndex: 10 }}>
      {isIn && (() => { const totalSpend = Object.entries(stockInPrices).reduce((s, [id, p]) => s + (draft[id] > 0 ? Number(p) || 0 : 0), 0); return totalSpend > 0 ? (
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderRadius: 10, background: "#F0FDF4", border: "1px solid #BBF7D0", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#166534" }}>Total Purchase Value</span>
          <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#16A34A" }}>₹{totalSpend.toLocaleString("en-IN")}</span>
        </div>) : null; })()}
      <button onClick={isIn ? submitStockIn : submitStockOut} disabled={count === 0 || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: count > 0 && !saving ? (isIn ? "#16A34A" : "#DC2626") : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: count > 0 && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳..." : isIn ? `📥 Add Stock (${count} items)` : `📤 Issue Stock (${count} items)`}</button>
      </div>
    </div>);
  }

  // ── THRESHOLDS VIEW ──
  if (view === "thresholds") {
    return (<div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setView("stock")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>⚙️ Set Thresholds</div></div>
      <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12, color: "#92400E", marginBottom: 14 }}>Set minimum stock level for each item. Alert shows when stock falls below threshold.</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}><button onClick={() => setSelCat(null)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: !selCat ? 700 : 500, border: !selCat ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selCat ? "#1A1A1A" : "#fff", color: !selCat ? "#fff" : "#888" }}>All</button>{categories.map((c) => (<button key={c} onClick={() => setSelCat(c)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: selCat === c ? 700 : 500, border: selCat === c ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selCat === c ? "#1A1A1A" : "#fff", color: selCat === c ? "#fff" : "#888" }}>{c}</button>))}</div>
      {filtered.map((item) => (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: "#FAFAF8", marginBottom: 3 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{item.name}</div>
        <input type="number" inputMode="numeric" min="0" placeholder={String(item.threshold)} value={thresholds[item.id] ?? item.threshold} onChange={(e) => setThresholds((p) => ({ ...p, [item.id]: e.target.value }))} style={{ width: 60, padding: "6px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} />
        <span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.unit}</span>
      </div>))}
      <button onClick={saveThresholds} disabled={saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: !saving ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: !saving ? "pointer" : "not-allowed", fontFamily: "inherit", marginTop: 12 }}>{saving ? "⏳..." : "💾 Save Thresholds"}</button>
    </div>);
  }

  // ── ORDER CHALLAN VIEW — RM Order based ──
  if (view === "order_challan") {
    return <OrderChallanView items={invItems} categories={categories} displayCategory={displayCategory} selCat={selCat} setSelCat={setSelCat} orderQty={orderQty} setOrderQty={setOrderQty} setView={setView} setDraft={setDraft} fmt={fmt} />;
  }

  // ── MAIN STOCK VIEW ──
  const stockFiltered = (() => {
    let list = stockFilter === "low" ? alerts : stockFilter === "out" ? outOfStock : filtered;
    // selCat holds the DISPLAY label (e.g. "Grocery"), but item.category holds the raw DB value ("Food").
    // Compare via displayCategory() so the renamed "Grocery" pill correctly matches "Food" rows.
    if (selCat) list = list.filter((i) => displayCategory(i.category) === selCat);
    return list;
  })();

  return (<div>
    {/* Top bar: pills + action icons all in one row */}
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
      <button onClick={() => setInvSection("stockout")} style={{ padding: "8px 16px", borderRadius: 8, border: invSection === "stockout" ? "none" : "1px solid #FECACA", background: invSection === "stockout" ? "#DC2626" : "#FEF2F2", color: invSection === "stockout" ? "#fff" : "#DC2626", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>📤 Stock Out</button>
      <button onClick={() => setInvSection("inventory")} style={{ padding: "8px 16px", borderRadius: 8, border: invSection === "inventory" ? "none" : "1px solid #E0E0DC", background: invSection === "inventory" ? "#1A1A1A" : "#fff", color: invSection === "inventory" ? "#fff" : "#888", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>📦 Current Inventory</button>
      <div style={{ flex: 1 }} />
      <button onClick={() => { setDraft({}); setView("stock_in"); }} title="Stock In" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #BBF7D0", background: "#F0FDF4", fontSize: 14, cursor: "pointer" }}>📥</button>
      <button onClick={() => { setView("order_challan"); }} title="Order Challan" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #BFDBFE", background: "#EFF6FF", fontSize: 14, cursor: "pointer" }}>📝</button>
      <button onClick={() => { setThresholds({}); setView("thresholds"); }} title="Thresholds" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 14, cursor: "pointer" }}>⚙️</button>
      <button onClick={load} title="Refresh" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 14, cursor: "pointer" }}>🔄</button>
    </div>

    {/* ── INVENTORY SECTION ── */}
    {invSection === "inventory" && (<>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <ExportBtn onClick={() => {
          const headers = ["Name", "Category", "Unit", "Current Qty", "Threshold", "Status"];
          const rows = invItems.map((i) => {
            const qty = Number(i.current_qty);
            return [i.name, displayCategory(i.category), i.unit, qty, i.threshold, qty === 0 ? "Out" : i.below_threshold ? "Low" : "OK"];
          });
          exportCSV(headers, rows, `current_inventory_${today()}.csv`);
        }} />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => { setStockFilter("all"); }} style={{ flex: 1, background: stockFilter === "all" ? "#1A1A1A" : "#fff", borderRadius: 10, padding: "10px 8px", border: stockFilter === "all" ? "none" : "1px solid #E8E8E4", textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 9, color: stockFilter === "all" ? "#999" : "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>All</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: stockFilter === "all" ? "#fff" : "#1A1A1A" }}>{invItems.length}</div>
        </button>
        <button onClick={() => setStockFilter("low")} style={{ flex: 1, background: stockFilter === "low" ? "#B45309" : alerts.length > 0 ? "#FFFDF5" : "#F0FDF4", borderRadius: 10, padding: "10px 8px", border: stockFilter === "low" ? "none" : `1px solid ${alerts.length > 0 ? "#FDE68A" : "#BBF7D0"}`, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 9, color: stockFilter === "low" ? "rgba(255,255,255,0.7)" : "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Low</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: stockFilter === "low" ? "#fff" : alerts.length > 0 ? "#B45309" : "#16A34A" }}>{alerts.length}</div>
        </button>
        <button onClick={() => setStockFilter("out")} style={{ flex: 1, background: stockFilter === "out" ? "#DC2626" : outOfStock.length > 0 ? "#FEF2F2" : "#F0FDF4", borderRadius: 10, padding: "10px 8px", border: stockFilter === "out" ? "none" : `1px solid ${outOfStock.length > 0 ? "#FECACA" : "#BBF7D0"}`, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 9, color: stockFilter === "out" ? "rgba(255,255,255,0.7)" : "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Out</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: stockFilter === "out" ? "#fff" : outOfStock.length > 0 ? "#DC2626" : "#16A34A" }}>{outOfStock.length}</div>
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, overflowX: "auto", paddingBottom: 4 }}><button onClick={() => setSelCat(null)} style={{ padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: !selCat ? 700 : 500, border: !selCat ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selCat ? "#1A1A1A" : "#fff", color: !selCat ? "#fff" : "#888", whiteSpace: "nowrap" }}>All</button>{categories.map((c) => (<button key={c} onClick={() => setSelCat(c)} style={{ padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: selCat === c ? 700 : 500, border: selCat === c ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selCat === c ? "#1A1A1A" : "#fff", color: selCat === c ? "#fff" : "#888", whiteSpace: "nowrap" }}>{c}</button>))}</div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
        {stockFiltered.length === 0 && <div style={{ padding: "20px", textAlign: "center", color: "#999", fontSize: 13 }}>{stockFilter === "out" ? "No items out of stock" : stockFilter === "low" ? "No low stock items" : "No items"}</div>}
        {stockFiltered.map((item, idx) => {
          const qty = Number(item.current_qty);
          const isLow = item.below_threshold;
          const isOut = qty === 0;
          const isEditing = editingItem === item.id;
          return (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: idx < stockFiltered.length - 1 ? "1px solid #F0F0EC" : "none", background: isEditing ? "#FFFDF5" : "transparent" }}>
              <div style={{ flex: 1, cursor: "pointer" }} onClick={() => !isEditing && loadHistory(item.id)}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                <div style={{ fontSize: 10, color: "#999" }}>{displayCategory(item.category)} • Min: {item.threshold} {item.unit}</div>
              </div>
              {isEditing ? (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input type="number" inputMode="numeric" autoFocus value={editQtyVal} onChange={(e) => setEditQtyVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") {
                      const newQty = Number(editQtyVal);
                      const diff = newQty - qty;
                      if (diff !== 0) {
                        const type = diff > 0 ? "stock_in" : "stock_out";
                        api.stockIn ? (diff > 0 ? api.stockIn([{ item_id: item.id, quantity: Math.abs(diff) }], "correction") : api.stockOut([{ item_id: item.id, quantity: Math.abs(diff) }], "correction")) : null;
                        load();
                      }
                      setEditingItem(null);
                    } if (e.key === "Escape") setEditingItem(null); }}
                    style={{ width: 60, padding: "5px", borderRadius: 6, border: "2px solid #B45309", fontSize: 16, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 800 }} />
                  <button onClick={async () => {
                    const newQty = Number(editQtyVal);
                    const diff = newQty - qty;
                    if (diff !== 0) {
                      try {
                        if (diff > 0) await api.stockIn([{ item_id: item.id, quantity: Math.abs(diff) }], "correction");
                        else await api.stockOut([{ item_id: item.id, quantity: Math.abs(diff) }], "correction");
                        load();
                      } catch (e) { alert("Error: " + e.message); }
                    }
                    setEditingItem(null);
                  }} style={{ padding: "4px 8px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✓</button>
                  <button onClick={() => setEditingItem(null)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", color: "#888", fontSize: 12, cursor: "pointer" }}>✕</button>
                </div>
              ) : (
                <div style={{ textAlign: "right", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); setEditingItem(item.id); setEditQtyVal(String(qty)); }}>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: isOut ? "#DC2626" : isLow ? "#B45309" : "#1A1A1A" }}>{qty}</div>
                  <div style={{ fontSize: 10, color: "#999" }}>{item.unit}</div>
                </div>
              )}
              {isLow && !isEditing && <div style={{ width: 8, height: 8, borderRadius: 4, background: isOut ? "#DC2626" : "#F59E0B", flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>
    </>)}

    {/* ── STOCK OUT SECTION ── */}
    {invSection === "stockout" && (<>
      <div style={{ display: "flex", gap: 5, marginBottom: 12, overflowX: "auto", paddingBottom: 4 }}>
        {[{ id: "bk", label: "🏭 Kitchen", color: "#B45309" }, ...OUTLETS.map((o) => ({ id: o.id, label: "🏪 " + o.short, color: "#2563EB" }))].map((f) => (
          <button key={f.id} onClick={() => { setStockOutView(f.id); setIssuedItems({}); setEditedQty({}); setExtraItems({}); setRemovedItems({}); setShowAddPanel(false); setAddItemSearch(""); setAddItemQty(""); }} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: stockOutView === f.id ? 700 : 500, border: stockOutView === f.id ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: stockOutView === f.id ? f.color : "#fff", color: stockOutView === f.id ? "#fff" : "#888", whiteSpace: "nowrap" }}>{f.label}</button>
        ))}
      </div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #E8E8E4", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "#888" }}>{stockOutView === "bk" ? "Raw materials for Kitchen" : `Direct items for ${OUTLETS.find((o) => o.id === stockOutView)?.name || stockOutView}`}</span>
          {(() => {
            const mergedData = { ...(stockOutData || {}), ...extraItems };
            const visibleIds = Object.keys(mergedData).filter((k) => !removedItems[k]);
            const tickedCount = visibleIds.filter((k) => issuedItems[k]).length;
            return visibleIds.length > 0 && <span style={{ fontSize: 11, color: "#16A34A", fontWeight: 700 }}>{tickedCount}/{visibleIds.length} issued</span>;
          })()}
        </div>
        {stockOutLoading && <div style={{ padding: "20px", textAlign: "center", color: "#999", fontSize: 12 }}>⏳ Loading...</div>}
        {/* BK demand summary — shows what demand triggered the raw material calc (with conversions) */}
        {!stockOutLoading && stockOutView === "bk" && Object.keys(bkDemandDisplay).length > 0 && (
          <div style={{ padding: "10px 14px", background: "#FFFBEB", borderBottom: "1px solid #FDE68A" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#B45309", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>📋 Demand Summary</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.values(bkDemandDisplay).sort((a, b) => a.itemName.localeCompare(b.itemName)).map((d, i) => (
                <span key={i} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: "#fff", border: "1px solid #FDE68A", color: "#92400E" }}>
                  <strong>{d.itemName}</strong>{" "}
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{d.raw} {d.unit}</span>
                  {d.converted && (
                    <span style={{ color: "#B45309", fontWeight: 600 }}> → {Math.round(d.baseQty * 100) / 100} {d.baseUnit}</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        {/* Direct outlet conversion hint */}
        {!stockOutLoading && stockOutView !== "bk" && stockOutData && Object.values(stockOutData).some((v) => v.converted) && (
          <div style={{ padding: "8px 14px", background: "#EFF6FF", borderBottom: "1px solid #BFDBFE", fontSize: 11, color: "#1D4ED8", display: "flex", alignItems: "center", gap: 6 }}>
            <span>🔄</span>
            <span>Some items converted from demand unit to inventory base unit — see <strong>→</strong> arrows below</span>
          </div>
        )}
        {/* Smart nudge: only appears when user has pending edits or manual additions */}
        {!stockOutLoading && (() => {
          const editCount = Object.keys(editedQty).length;
          const manualCount = Object.keys(extraItems).filter((k) => !removedItems[k]).length;
          if (editCount === 0 && manualCount === 0) return null;
          const parts = [];
          if (editCount > 0) parts.push(`${editCount} edit${editCount > 1 ? "s" : ""}`);
          if (manualCount > 0) parts.push(`${manualCount} added`);
          return (
            <div style={{ padding: "8px 14px", background: "#FFFBEB", borderBottom: "1px solid #FDE68A", fontSize: 11, color: "#B45309", display: "flex", alignItems: "center", gap: 6 }}>
              <span>💡</span>
              <span><strong>{parts.join(" · ")}</strong> pending — changes save only when you tap <strong>Issue</strong> below</span>
            </div>
          );
        })()}
        {!stockOutLoading && (() => {
          const mergedData = { ...(stockOutData || {}), ...extraItems };
          const visibleEntries = Object.entries(mergedData).filter(([k]) => !removedItems[k]);
          if (visibleEntries.length === 0) {
            return <div style={{ padding: "20px", textAlign: "center", color: "#999", fontSize: 12 }}>No items — use + Add below to add items manually</div>;
          }
          return (
          <div>
            {visibleEntries.sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, item]) => {
              const isManual = !!item.manual;
              const invItem = item.inv_id ? items.find((i) => i.id === item.inv_id) : items.find((i) => i.demand_item_id === id);
              const stock = invItem ? Number(invItem.current_qty) : null;

              // Smart unit conversion: if recipe unit differs from inventory unit within same dimension,
              // convert the qty to match inventory unit for accurate display and deduction.
              // e.g., recipe says 0.2 Kg but inventory tracks in Gm → display 200 Gm
              const getUnitFactor = (fromUnit, toUnit) => {
                const f = String(fromUnit || "").toLowerCase();
                const t = String(toUnit || "").toLowerCase();
                if (f === t) return 1;
                // Weight: Kg → Gm
                if ((f === "kg") && (t === "gm" || t === "g" || t === "gram" || t === "grams")) return 1000;
                // Weight: Gm → Kg
                if ((f === "gm" || f === "g" || f === "gram" || f === "grams") && t === "kg") return 0.001;
                // Volume: Ltr → Ml
                if ((f === "ltr" || f === "liter" || f === "litre") && (t === "ml" || t === "milliliter")) return 1000;
                // Volume: Ml → Ltr
                if ((f === "ml" || f === "milliliter") && (t === "ltr" || t === "liter" || t === "litre")) return 0.001;
                return 1; // incompatible or same — no conversion
              };
              const invUnit = invItem?.unit || item.unit;
              const unitFactor = getUnitFactor(item.unit, invUnit);
              const adjustedQty = typeof item.qty === "number" ? item.qty * unitFactor : item.qty;
              const displayUnit = unitFactor !== 1 ? invUnit : item.unit;

              const isLow = stock !== null && stock < adjustedQty;
              const stockColor = stock === null ? "#BBB" : stock === 0 ? "#DC2626" : isLow ? "#DC2626" : "#16A34A";
              const issued = issuedItems[id] || false;
              const editQty = editedQty[id];
              const displayQty = editQty !== undefined ? editQty : (typeof adjustedQty === "number" ? Math.round(adjustedQty * 100) / 100 : adjustedQty);
              const isEdited = editQty !== undefined && Number(editQty) !== (typeof adjustedQty === "number" ? Math.round(adjustedQty * 100) / 100 : Number(adjustedQty));
              // Unit mismatch warning: only show for truly incompatible units.
              // Kg↔Gm and Ltr↔Ml are the same dimension — no warning needed.
              const unitsCompatible = (a, b) => {
                const na = String(a || "").toLowerCase();
                const nb = String(b || "").toLowerCase();
                if (na === nb) return true;
                const weightUnits = new Set(["kg", "gm", "gram", "grams", "g"]);
                const volumeUnits = new Set(["ltr", "liter", "litre", "ml", "milliliter"]);
                if (weightUnits.has(na) && weightUnits.has(nb)) return true;
                if (volumeUnits.has(na) && volumeUnits.has(nb)) return true;
                return false;
              };
              const unitMismatch = invItem && item.unit && invItem.unit && !unitsCompatible(item.unit, invItem.unit);
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #F0F0EC", background: issued ? "#F0FDF4" : isManual ? "#FFF7ED" : "transparent", opacity: issued ? 0.6 : 1 }}>
                  <button onClick={() => setIssuedItems((p) => ({ ...p, [id]: !p[id] }))} style={{ width: 24, height: 24, borderRadius: 6, border: issued ? "2px solid #16A34A" : "2px solid #D0D0CC", background: issued ? "#16A34A" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, padding: 0 }}>
                    {issued && <span style={{ color: "#fff", fontSize: 13, fontWeight: 800 }}>✓</span>}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, textDecoration: issued ? "line-through" : "none", display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      <span>{item.name}</span>
                      {isManual && <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#EA580C", color: "#fff", textTransform: "uppercase", letterSpacing: 0.3 }}>Manual</span>}
                      {!isManual && isEdited && <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#B45309", color: "#fff", textTransform: "uppercase", letterSpacing: 0.3 }}>Edited</span>}
                      {item.converted && !isManual && <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#2563EB", color: "#fff", textTransform: "uppercase", letterSpacing: 0.3 }}>Converted</span>}
                      {unitMismatch && <span title={`Inventory tracks in ${invItem.unit}, not ${item.unit}. Deduction may be off.`} style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#DC2626", color: "#fff", textTransform: "uppercase", letterSpacing: 0.3, cursor: "help" }}>⚠ Unit Mismatch</span>}
                    </div>
                    {item.converted && !isManual && (
                      <div style={{ fontSize: 9, color: "#2563EB", marginTop: 1, fontFamily: "'JetBrains Mono', monospace" }}>
                        {item.rawQty} {item.rawUnit} → {Math.round(item.qty * 100) / 100} {item.unit}
                      </div>
                    )}
                    {unitMismatch && (
                      <div style={{ fontSize: 9, color: "#DC2626", marginTop: 1 }}>
                        ⚠ Inventory unit: <strong>{invItem.unit}</strong> · demand base unit: <strong>{item.unit}</strong> — verify before issuing
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", minWidth: 40, flexShrink: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: stockColor }}>{stock !== null ? stock : "—"}</div>
                    <div style={{ fontSize: 9, color: "#999" }}>{displayUnit}</div>
                  </div>
                  <input type="number" inputMode="numeric" step="1" value={displayQty} onChange={(e) => setEditedQty((p) => ({ ...p, [id]: e.target.value }))} disabled={issued}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const inputs = Array.from(document.querySelectorAll("[data-stockout-input]")); const idx = inputs.indexOf(e.target); if (idx < inputs.length - 1) inputs[idx + 1].focus(); } }}
                    data-stockout-input
                    style={{ width: 56, padding: "5px 4px", borderRadius: 6, border: isEdited ? "2px solid #B45309" : "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: "#B45309", background: issued ? "#F0FDF4" : "#fff" }} />
                  <span style={{ fontSize: 10, color: "#999", width: 20, flexShrink: 0 }}>{displayUnit}</span>
                  <button onClick={() => { setRemovedItems((p) => ({ ...p, [id]: true })); setIssuedItems((p) => { const c = { ...p }; delete c[id]; return c; }); setEditedQty((p) => { const c = { ...p }; delete c[id]; return c; }); if (isManual) { setExtraItems((p) => { const c = { ...p }; delete c[id]; return c; }); } }} title="Remove from list" style={{ width: 22, height: 22, borderRadius: 5, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 12, cursor: "pointer", padding: 0, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                </div>
              );
            })}
          </div>
          );
        })()}
        {/* + Add Item panel */}
        {!stockOutLoading && (
          <div style={{ borderTop: "1px solid #E8E8E4", background: "#FAFAF8" }}>
            {!showAddPanel ? (
              <button onClick={() => setShowAddPanel(true)} style={{ width: "100%", padding: "14px 12px", border: "none", background: "#F0FDF4", fontSize: 13, fontWeight: 700, color: "#16A34A", cursor: "pointer", fontFamily: "inherit", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <span style={{ fontSize: 16 }}>＋</span> Add Extra Item / Override Qty
              </button>
            ) : (() => {
              const q = addItemSearch.trim().toLowerCase();
              const matches = q ? items.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 6) : [];
              const exactMatch = matches.find((m) => m.name.toLowerCase() === q);
              const mergedData = { ...(stockOutData || {}), ...extraItems };
              const alreadyAdded = (invId) => Object.values(mergedData).some((v) => !removedItems[Object.keys(mergedData).find((k) => mergedData[k] === v)] && v.inv_id === invId);
              const addFromInventory = (inv) => {
                const tempId = `manual_${Date.now()}_${inv.id}`;
                setExtraItems((p) => ({ ...p, [tempId]: { name: inv.name, qty: Number(addItemQty) || 1, unit: inv.unit, inv_id: inv.id, manual: true } }));
                setAddItemSearch(""); setAddItemQty(""); setShowAddPanel(false);
              };
              const addAsFreeText = () => {
                if (!addItemSearch.trim()) return;
                const tempId = `manual_${Date.now()}_freetext`;
                setExtraItems((p) => ({ ...p, [tempId]: { name: addItemSearch.trim(), qty: Number(addItemQty) || 1, unit: "", inv_id: null, manual: true } }));
                setAddItemSearch(""); setAddItemQty(""); setShowAddPanel(false);
                alert("⚠️ Added as free-text (no inventory match). Stock will NOT be deducted for this item — please add it to Inventory SKUs and re-issue.");
              };
              return (
                <div style={{ padding: "10px 12px" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: matches.length > 0 || (q && !exactMatch) ? 8 : 0 }}>
                    <input autoFocus value={addItemSearch} onChange={(e) => setAddItemSearch(e.target.value)} placeholder="Search inventory…" style={{ flex: 1, padding: "7px 10px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
                    <input type="number" inputMode="numeric" min="0" step="0.01" value={addItemQty} onChange={(e) => setAddItemQty(e.target.value)} placeholder="Qty" style={{ width: 60, padding: "7px 6px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }} />
                    <button onClick={() => { setShowAddPanel(false); setAddItemSearch(""); setAddItemQty(""); }} style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 11, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
                  </div>
                  {q && matches.length > 0 && (
                    <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #E0E0DC", overflow: "hidden" }}>
                      {matches.map((inv) => {
                        const used = alreadyAdded(inv.id);
                        return (
                          <button key={inv.id} onClick={() => !used && addFromInventory(inv)} disabled={used} style={{ width: "100%", padding: "8px 10px", border: "none", borderBottom: "1px solid #F5F5F3", background: used ? "#F5F5F3" : "#fff", textAlign: "left", cursor: used ? "not-allowed" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8, opacity: used ? 0.5 : 1 }}>
                            <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{inv.name}</span>
                            <span style={{ fontSize: 10, color: "#999" }}>{inv.category}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: Number(inv.current_qty) === 0 ? "#DC2626" : "#16A34A" }}>{inv.current_qty} {inv.unit}</span>
                            {used && <span style={{ fontSize: 9, color: "#999" }}>added</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {q && matches.length === 0 && (
                    <button onClick={addAsFreeText} style={{ width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px dashed #FDE68A", background: "#FFFBEB", color: "#B45309", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                      + Add "{addItemSearch}" as new item (free-text — won't deduct stock)
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
      {/* Issue button — sticky at bottom, only issues ticked items */}
      {(() => {
        const mergedData = { ...(stockOutData || {}), ...extraItems };
        const visibleIds = Object.keys(mergedData).filter((k) => !removedItems[k]);
        if (visibleIds.length === 0) return null;
        const tickedIds = visibleIds.filter((k) => issuedItems[k]);
        const tickedCount = tickedIds.length;
        return (
        <div style={{ position: "sticky", bottom: 0, padding: "12px 0", background: "linear-gradient(transparent, #FAF9F6 20%)", zIndex: 10 }}>
        <button onClick={async () => {
          if (tickedCount === 0) { alert("Tick items to issue first"); return; }
          // Build entries + per-entry source tracking
          const rawEntries = tickedIds.map((id) => {
            const item = mergedData[id];
            if (!item) return null;
            const calcQty = typeof item.qty === "number" ? Math.round(item.qty * 100) / 100 : Number(item.qty);
            const qty = editedQty[id] !== undefined ? Number(editedQty[id]) : calcQty;
            const invItem = item.inv_id ? items.find((i) => i.id === item.inv_id) : items.find((i) => i.demand_item_id === id);
            if (!invItem || qty <= 0) return null;
            // Determine source: manual (added by user), edited (recipe qty changed), recipe (unchanged)
            const isManual = !!item.manual;
            const isEdited = !isManual && editedQty[id] !== undefined && Number(editedQty[id]) !== calcQty;
            const source = isManual ? "manual" : isEdited ? "edited" : "recipe";
            return { item_id: invItem.id, quantity: qty, _calc: calcQty, _name: invItem.name, _source: source };
          }).filter(Boolean);
          if (rawEntries.length === 0) { alert("No matching inventory items found. Free-text items are skipped until added to Inventory SKUs."); return; }
          // Warn if any free-text items were ticked but have no inv_id match
          const skippedFreeText = tickedIds.filter((id) => {
            const item = mergedData[id];
            if (!item || !item.manual) return false;
            const invItem = item.inv_id ? items.find((i) => i.id === item.inv_id) : items.find((i) => i.demand_item_id === id);
            return !invItem;
          });
          if (skippedFreeText.length > 0) {
            if (!confirm(`${skippedFreeText.length} free-text item(s) will NOT be deducted from inventory (no SKU match). Continue with the rest?`)) return;
          }
          const entries = rawEntries.map(({ item_id, quantity }) => ({ item_id, quantity }));
          setIssuing(true);
          try {
            await api.stockOut(entries, "issuance");
            const auditEntries = rawEntries.map(({ item_id, quantity, _calc, _name, _source }) => ({
              item_id,
              item_name: _name,
              calculated_qty: _calc,
              issued_qty: quantity,
              variance: quantity - _calc,
              source: _source,
              date: today(),
            }));
            try { await api.saveIssuanceAudit(auditEntries); } catch (e) {}
            const manualCount = rawEntries.filter((e) => e._source === "manual").length;
            const editedCount = rawEntries.filter((e) => e._source === "edited").length;
            let msg = `✅ ${entries.length} items issued from inventory`;
            if (manualCount > 0) msg += ` (${manualCount} manual)`;
            if (editedCount > 0) msg += ` (${editedCount} edited)`;
            alert(msg);
            // Mark all related orders as "issued" so they don't show in stock out again
            const orderIds = issuedForOrders || [];
            for (const oid of orderIds) {
              try { await api.updateOrderStatus(oid, "issued"); } catch (e) { console.error("Status update failed:", e); }
            }
            setIssuedItems({}); setEditedQty({}); setExtraItems({}); setRemovedItems({}); load();
          } catch (e) { alert("Error: " + e.message); }
          finally { setIssuing(false); }
        }} disabled={issuing || tickedCount === 0} style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: issuing || tickedCount === 0 ? "#D0D0CC" : "#DC2626", color: "#fff", fontWeight: 800, fontSize: 15, cursor: issuing || tickedCount === 0 ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
          {issuing ? "⏳ Issuing..." : tickedCount === 0 ? "✅ Tick items to issue" : `📤 Issue ${tickedCount} items — Deduct from Inventory`}
        </button>
        </div>);
      })()}
    </>)}
  </div>);
};

// ═════════════════════════════════════════════════════════════════════════════
//  RECIPES
// ═════════════════════════════════════════════════════════════════════════════
const RecipesPanel = () => {
  const [sel, setSel] = useState("sambhar");
  const [editMode, setEditMode] = useState(false);
  const [editRecipes, setEditRecipes] = useState(JSON.parse(JSON.stringify(RECIPES)));
  const [newIngName, setNewIngName] = useState("");
  const [newIngQty, setNewIngQty] = useState("");
  const [newIngUnit, setNewIngUnit] = useState("Kg");
  const [saved, setSaved] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);

  const recipe = editRecipes[sel];

  // ── Download all recipes as CSV ──
  const downloadRecipes = () => {
    const headers = ["Recipe", "Yield", "YieldQty", "RawMaterial", "RawMaterialId", "Qty", "Unit"];
    const rows = [];
    Object.entries(editRecipes).forEach(([key, r]) => {
      r.ingredients.forEach((ing) => {
        const raw = RAW_MATERIALS.find((rm) => rm.id === ing.rawId);
        rows.push([r.name, r.yield, r.yieldQty, raw?.name || ing.rawId, ing.rawId, ing.qty, raw?.unit || ""]);
      });
    });
    const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `ananda_recipes_${today()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Upload recipes from CSV ──
  const handleUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target.result;
        const lines = text.split("\n").filter((l) => l.trim());
        if (lines.length < 2) { setUploadMsg({ ok: false, msg: "Empty file" }); return; }

        const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim().toLowerCase());
        const recipeIdx = headers.indexOf("recipe");
        const yieldIdx = headers.indexOf("yield");
        const yieldQtyIdx = headers.indexOf("yieldqty");
        const rmIdx = headers.indexOf("rawmaterial");
        const rmIdIdx = headers.indexOf("rawmaterialid");
        const qtyIdx = headers.indexOf("qty");
        const unitIdx = headers.indexOf("unit");

        if (recipeIdx < 0 || qtyIdx < 0) {
          setUploadMsg({ ok: false, msg: "CSV must have columns: Recipe, Yield, YieldQty, RawMaterial, RawMaterialId, Qty, Unit" });
          return;
        }

        const newRecipes = {};
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].match(/(".*?"|[^,]*)/g)?.map((c) => c.replace(/^"|"$/g, "").trim()) || [];
          const recipeName = cols[recipeIdx];
          const yieldStr = cols[yieldIdx] || "";
          const yieldQty = parseFloat(cols[yieldQtyIdx]) || 0;
          const rmName = cols[rmIdx] || "";
          const rmId = cols[rmIdIdx] || rmName.toLowerCase().replace(/[^a-z0-9]/g, "_");
          const qty = parseFloat(cols[qtyIdx]) || 0;
          const unit = cols[unitIdx] || "Kg";

          if (!recipeName || !rmName) continue;

          const recipeKey = recipeName.toLowerCase().replace(/[^a-z0-9]/g, "_");

          if (!newRecipes[recipeKey]) {
            newRecipes[recipeKey] = { name: recipeName, yield: yieldStr, yieldQty: yieldQty, ingredients: [] };
          }

          // Add raw material if not in RAW_MATERIALS
          if (!RAW_MATERIALS.find((r) => r.id === rmId)) {
            RAW_MATERIALS.push({ id: rmId, name: rmName, unit: unit });
          }

          newRecipes[recipeKey].ingredients.push({ rawId: rmId, qty });
        }

        const count = Object.keys(newRecipes).length;
        if (count === 0) { setUploadMsg({ ok: false, msg: "No valid recipes found in file" }); return; }

        // Merge: update existing, add new
        const merged = { ...editRecipes };
        Object.entries(newRecipes).forEach(([key, recipe]) => {
          merged[key] = recipe;
        });

        setEditRecipes(merged);
        // Also save to global
        Object.keys(merged).forEach((k) => { RECIPES[k] = merged[k]; });

        setSel(Object.keys(newRecipes)[0]);
        setUploadMsg({ ok: true, msg: `✅ Loaded ${count} recipes with ${Object.values(newRecipes).reduce((s, r) => s + r.ingredients.length, 0)} ingredients` });
      } catch (err) {
        setUploadMsg({ ok: false, msg: `❌ Parse error: ${err.message}` });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const updateQty = (idx, newQty) => {
    setEditRecipes((prev) => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy[sel].ingredients[idx].qty = Number(newQty) || 0;
      return copy;
    });
  };

  const updateYield = (newYield) => {
    setEditRecipes((prev) => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy[sel].yield = newYield;
      // Extract number from yield string
      const num = parseFloat(newYield);
      if (!isNaN(num)) copy[sel].yieldQty = num;
      return copy;
    });
  };

  const removeIngredient = (idx) => {
    setEditRecipes((prev) => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy[sel].ingredients.splice(idx, 1);
      return copy;
    });
  };

  const addIngredient = () => {
    if (!newIngName.trim() || !newIngQty) return;
    // Find or create rawId
    const rawId = newIngName.trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
    // Check if raw material exists, if not add to RAW_MATERIALS
    if (!RAW_MATERIALS.find((r) => r.id === rawId)) {
      RAW_MATERIALS.push({ id: rawId, name: newIngName.trim(), unit: newIngUnit });
    }
    setEditRecipes((prev) => {
      const copy = JSON.parse(JSON.stringify(prev));
      copy[sel].ingredients.push({ rawId, qty: Number(newIngQty) || 0 });
      return copy;
    });
    setNewIngName(""); setNewIngQty(""); setNewIngUnit("Kg");
  };

  const saveRecipes = () => {
    // Update the global RECIPES object
    Object.keys(editRecipes).forEach((k) => {
      RECIPES[k] = editRecipes[k];
    });
    setSaved(true);
    setEditMode(false);
    setTimeout(() => setSaved(false), 2000);
  };

  const discardChanges = () => {
    setEditRecipes(JSON.parse(JSON.stringify(RECIPES)));
    setEditMode(false);
  };

  return (
    <div id="print-recipes">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div><h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Recipe Management</h3><p style={{ fontSize: 13, color: "#888", margin: 0 }}>Standard recipes for raw material calculations and audit</p></div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={downloadRecipes} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #BBF7D0", background: "#F0FDF4", fontSize: 12, fontWeight: 600, color: "#16A34A", cursor: "pointer", fontFamily: "inherit" }}>📥 Download CSV</button>
          <label style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #BFDBFE", background: "#EFF6FF", fontSize: 12, fontWeight: 600, color: "#2563EB", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center" }}>
            📤 Upload CSV
            <input type="file" accept=".csv" onChange={handleUpload} style={{ display: "none" }} />
          </label>
          {!editMode ? (
            <button onClick={() => setEditMode(true)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #BFDBFE", background: "#EFF6FF", fontSize: 12, fontWeight: 600, color: "#2563EB", cursor: "pointer", fontFamily: "inherit" }}>✏️ Edit</button>
          ) : (
            <>
              <button onClick={discardChanges} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #E0E0DC", background: "#fff", fontSize: 12, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>✕ Cancel</button>
              <button onClick={saveRecipes} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#16A34A", fontSize: 12, fontWeight: 600, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>💾 Save</button>
            </>
          )}
          <PrintBtn sectionId="print-recipes" title={`Recipe — ${recipe.name}`} />
        </div>
      </div>
      {saved && <div style={{ padding: "10px 14px", borderRadius: 10, background: "#F0FDF4", border: "1px solid #BBF7D0", fontSize: 12, color: "#166534", marginBottom: 14 }}>✅ Recipes saved! Raw material requisitions will use updated values.</div>}
      {uploadMsg && <div style={{ padding: "10px 14px", borderRadius: 10, background: uploadMsg.ok ? "#F0FDF4" : "#FEF2F2", border: `1px solid ${uploadMsg.ok ? "#BBF7D0" : "#FECACA"}`, fontSize: 12, color: uploadMsg.ok ? "#166534" : "#991B1B", marginBottom: 14 }}>{uploadMsg.msg}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>{Object.keys(editRecipes).map((k) => (<button key={k} onClick={() => setSel(k)} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: sel === k ? "none" : "1px solid #E0E0DC", background: sel === k ? "#1A1A1A" : "#fff", color: sel === k ? "#fff" : "#666", fontFamily: "inherit" }}>{editRecipes[k].name}</button>))}</div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h4 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{recipe.name}</h4>
            {editMode ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 13, color: "#888" }}>Yield:</span>
                <input type="text" value={recipe.yield} onChange={(e) => updateYield(e.target.value)} style={{ width: 80, padding: "4px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 13, fontWeight: 700, color: "#B45309", fontFamily: "inherit" }} />
              </div>
            ) : (
              <span style={{ fontSize: 13, color: "#888" }}>Yield: <strong style={{ color: "#B45309" }}>{recipe.yield}</strong></span>
            )}
          </div>
          <span style={{ padding: "3px 10px", borderRadius: 6, background: editMode ? "#FFFBEB" : "#EFF6FF", color: editMode ? "#B45309" : "#2563EB", fontSize: 11, fontWeight: 700 }}>{editMode ? "EDITING" : "STANDARD"}</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: "#FAFAF8" }}>
            <th style={thS}>Raw Material</th><th style={thS}>Qty / Batch</th><th style={thS}>Unit</th>
            {editMode && <th style={{ ...thS, width: 40 }}></th>}
          </tr></thead>
          <tbody>
            {recipe.ingredients.map((ing, idx) => {
              const raw = RAW_MATERIALS.find((r) => r.id === ing.rawId);
              return (
                <tr key={idx} style={{ borderBottom: "1px solid #F0F0EC" }}>
                  <td style={{ ...tdS, fontWeight: 600 }}>{raw?.name || ing.rawId}</td>
                  <td style={tdS}>
                    {editMode ? (
                      <input type="number" step="0.01" value={ing.qty} onChange={(e) => updateQty(idx, e.target.value)} style={{ width: 70, padding: "4px 6px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 14, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: "#B45309" }} />
                    ) : (
                      <span style={{ display: "block", textAlign: "center", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{ing.qty}</span>
                    )}
                  </td>
                  <td style={{ ...tdS, textAlign: "center", color: "#999" }}>{raw?.unit || ""}</td>
                  {editMode && (
                    <td style={tdS}>
                      <button onClick={() => removeIngredient(idx)} style={{ padding: "2px 8px", borderRadius: 4, border: "none", background: "#FEF2F2", color: "#DC2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {editMode && (
          <div style={{ marginTop: 14, padding: "14px", background: "#FAFAF8", borderRadius: 10, border: "1px dashed #E0E0DC" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#888", marginBottom: 8 }}>+ Add Ingredient</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input type="text" placeholder="Material name" value={newIngName} onChange={(e) => setNewIngName(e.target.value)} list="raw-materials-list"
                style={{ flex: "1 1 140px", padding: "8px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit" }} />
              <datalist id="raw-materials-list">{RAW_MATERIALS.map((r) => <option key={r.id} value={r.name} />)}</datalist>
              <input type="number" step="0.01" placeholder="Qty" value={newIngQty} onChange={(e) => setNewIngQty(e.target.value)}
                style={{ width: 70, padding: "8px 6px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, textAlign: "center", fontFamily: "inherit" }} />
              <select value={newIngUnit} onChange={(e) => setNewIngUnit(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
                <option value="Kg">Kg</option><option value="Ltr">Ltr</option><option value="Gm">Gm</option><option value="Pcs">Pcs</option><option value="Bunch">Bunch</option>
              </select>
              <button onClick={addIngredient} disabled={!newIngName.trim() || !newIngQty} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: newIngName.trim() && newIngQty ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontSize: 12, fontWeight: 700, cursor: newIngName.trim() && newIngQty ? "pointer" : "not-allowed", fontFamily: "inherit" }}>+ Add</button>
            </div>
          </div>
        )}
        {!editMode && <div style={{ marginTop: 14, padding: "10px 14px", background: "#FAFAF8", borderRadius: 8, fontSize: 12, color: "#888" }}>Click "Edit" to modify quantities or add new ingredients. Changes affect all raw material requisitions.</div>}
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
  const [demandSlot, setDemandSlot] = useState(null); // "morning" or "evening"
  const [savedSections, setSavedSections] = useState({}); // { sectionId: true } — which categories have been saved
  const [draftId, setDraftId] = useState(null); // DB id of the draft demand record

  // Load existing draft when demandSlot is selected
  useEffect(() => {
    if (!demandSlot || !outlet) return;
    const deliveryDate = demandSlot === "morning" ? istDateAgo(-1) : today();
    api.getOrders({ date: deliveryDate, outlet_id: outlet }).then((orders) => {
      const existingDraft = orders.find((o) => o.type === "manual" && (o.status === "draft" || o.status === "submitted") && o.demand_slot === demandSlot);
      if (existingDraft && existingDraft.items) {
        setDraft(existingDraft.items);
        setDraftId(existingDraft.id);
        const saved = {};
        DEMAND_SECTIONS.forEach((sec) => {
          if (sec.items.some((i) => existingDraft.items[i.id] > 0)) saved[sec.id] = true;
        });
        setSavedSections(saved);
      }
    }).catch(() => {});
  }, [demandSlot, outlet]);
  const [salesData, setSalesData] = useState({ total_sale: "", swiggy_sale: "", zomato_sale: "", other_delivery_sale: "", cancelled_orders: "", complimentary_amount: "", complimentary_reason: "", zomato_district: "", upi_collected: "", cash_collected: "", cash_expense: "", cash_expense_note: "", cash_deposited: "", notes: "" });
  const [prevCash, setPrevCash] = useState(0);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesSaving, setSalesSaving] = useState(false);
  const [existingData, setExistingData] = useState(null);
  const [salesLoaded, setSalesLoaded] = useState(false);
  // Purchase state
  const [purchases, setPurchases] = useState([{ item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]);
  const [billImages, setBillImages] = useState({}); const [purchaseNote, setPurchaseNote] = useState(""); const [paymentMode, setPaymentMode] = useState("cash");
  const oData = OUTLETS.find((o) => o.id === outlet); const tSubs = subs.filter((s) => s.outlet === outlet && s.date === today()); const reset = () => { setImages({}); setDraft({}); setNote(""); setExpSec(null); setErr(null); setStaffFood({}); setStaffShift("am"); setStaffDress([]); setDemandSlot(null); setSavedSections({}); setDraftId(null); };
  const resetPurchase = () => { setPurchases([{ item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]); setBillImages({}); setPurchaseNote(""); setPaymentMode("cash"); setErr(null); };

  // ── Staff Demand State ──
  const [staffItems, setStaffItems] = useState([]); // master items from DB
  const [staffFood, setStaffFood] = useState({}); // { roti: 10, sabji: 2 }
  const [staffShift, setStaffShift] = useState(() => istHour() < 14 ? "am" : "pm");
  const [staffDress, setStaffDress] = useState([]); // [{ item: "tshirt", role: "Chef", size: "XL" }]
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffItemsLoaded, setStaffItemsLoaded] = useState(false);

  // Load staff demand items from DB once
  useEffect(() => {
    if (!staffItemsLoaded) {
      api.getStaffDemandItems().then(setStaffItems).catch(() => setStaffItems([]));
      setStaffItemsLoaded(true);
    }
  }, [staffItemsLoaded]);

  const staffFoodItems = staffItems.filter((i) => i.category === "food");
  const staffDressItems = staffItems.filter((i) => i.category === "dress");
  const addPurchaseRow = () => setPurchases((p) => [...p, { item: "", qty: "", unit: "Kg", amount: "", vendor: "" }]);
  const updatePurchase = (idx, field, val) => setPurchases((p) => p.map((r, i) => i === idx ? { ...r, [field]: val } : r));
  const removePurchaseRow = (idx) => setPurchases((p) => p.filter((_, i) => i !== idx));

  const submit = async (type) => {
    if (type === "manual" && !demandSlot) { alert("Please select delivery slot (Morning or Evening)"); return; }
    setSaving(true); setErr(null);
    try {
      if (type === "closing") {
        const result = await api.submitClosingStock({ outlet_id: outlet, items: closing });
        const e = { ...result, type: "closing", outlet, time: timeNow(), date: today() };
        setSubs((p) => [e, ...p]); setLast(e);
      } else {
        const deliveryDate = type === "manual" && demandSlot === "morning" ? istDateAgo(-1) : today();
        const slotNote = type === "manual" ? `[${demandSlot === "morning" ? "🌅 Morning " + deliveryDate : "🌇 Evening " + deliveryDate}] ${note}`.trim() : note;
        if (type === "manual" && draftId) {
          await api.updateDemandDraft(draftId, { items: draft });
          await api.updateOrderStatus(draftId, "submitted");
          const e = { id: draftId, type, outlet, time: timeNow(), date: deliveryDate };
          setSubs((p) => [e, ...p]); setLast(e);
        } else {
          const result = await api.createDemand({ outlet_id: outlet, type, items: (type === "manual" || type === "wastage") ? draft : {}, note: slotNote, date: deliveryDate, demand_slot: demandSlot, submitted_by: getCurrentUser()?.name || outlet });
          const e = { ...result, type, outlet, time: timeNow(), date: deliveryDate };
          setSubs((p) => [e, ...p]); setLast(e);
        }
      }
      reset(); setClosing({}); setScreen("done");
    } catch (error) {
      setErr(error.message || "Failed to submit. Check internet connection.");
    } finally { setSaving(false); }
  };

  const waMsg = (e) => { let m = `📋 *Ananda Cafe — ${e.type === "closing" ? "Closing Stock" : "Demand"}*\n🏪 ${oData?.name}\n📅 ${e.date} | ⏰ ${e.time}\n`; if (e.type === "photo") m += `📷 ${Object.keys(e.images || {}).length} photos\n`; if (e.note) m += `📝 ${e.note}\n`; m += `✅ Sent via App`; window.open(`https://wa.me/?text=${encodeURIComponent(m)}`, "_blank"); };
  const ErrBar = () => err ? <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12 }}>❌ {err}</div> : null;
  const SavingOverlay = () => saving ? <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}><div style={{ background: "#fff", borderRadius: 16, padding: "24px 32px", textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div><div style={{ fontSize: 15, fontWeight: 700 }}>Submitting...</div><div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>Please wait</div></div></div> : null;

  if (screen === "pick") {
    const user = getCurrentUser();
    // If outlet manager with assigned outlet, skip picker
    if (user?.outlet_id && user?.role === "outlet_mgr") {
      const assignedOutlet = OUTLETS.find(o => o.id === user.outlet_id);
      if (assignedOutlet) {
        setOutlet(user.outlet_id);
        setScreen("home");
        return null;
      }
    }
    return (<div><div style={{ textAlign: "center", marginBottom: 30 }}><div style={{ fontSize: 40, marginBottom: 6 }}>🍽️</div><h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Select Outlet</h2>{user && <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>👤 {user.name}</p>}</div>{OUTLETS.map((o) => (<button key={o.id} onClick={() => { setOutlet(o.id); setScreen("home"); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 14, border: "1px solid #E8E8E4", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 12, marginBottom: 8, color: "#1A1A1A" }}><span style={{ fontSize: 24 }}>🏪</span><span style={{ flex: 1 }}>{o.name}</span><span style={{ color: "#CCC" }}>→</span></button>))}{onBack && <button onClick={onBack} style={{ width: "100%", marginTop: 12, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>}</div>);
  }

  if (screen === "done" && last) return (<div style={{ textAlign: "center", padding: "40px 0" }}><div style={{ fontSize: 64, marginBottom: 12 }}>✅</div><h3 style={{ fontSize: 20, fontWeight: 800, color: "#166534", margin: "0 0 4px" }}>{last.type === "closing" ? "Closing Stock Submitted!" : last.type === "wastage" ? "Wastage Recorded!" : last.type === "purchase" ? "Purchase Recorded!" : "Demand Submitted!"}</h3><p style={{ color: "#16A34A", margin: "0 0 24px" }}>{oData?.name} — {last.time}</p><button onClick={() => waMsg(last)} style={{ padding: "14px 32px", borderRadius: 14, border: "none", background: "#25D366", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}>💬 Share on WhatsApp</button><br /><button onClick={() => setScreen("home")} style={{ padding: "12px 32px", borderRadius: 14, border: "1px solid #E0E0DC", background: "#fff", color: "#1A1A1A", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }}>← Back to Home</button></div>);

  if (screen === "home") { const dw = getDemandWindow(); return (<div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div><div style={{ fontSize: 16, fontWeight: 800 }}>🏪 {oData?.name}</div><div style={{ fontSize: 11, color: "#999" }}>{today()}</div></div><div style={{ display: "flex", gap: 6 }}>{tSubs.length > 0 && <span style={{ padding: "4px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>✅ {tSubs.length} sent</span>}<button onClick={() => { setOutlet(null); setScreen("pick"); }} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 11, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>Switch</button></div></div>
    <div style={{ padding: "10px 14px", borderRadius: 10, background: dw.active ? "#F0FDF4" : "#FEF2F2", border: `1px solid ${dw.active ? "#BBF7D0" : "#FECACA"}`, fontSize: 12, color: dw.active ? "#166534" : "#991B1B", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 16 }}>{dw.active ? "🟢" : "🔴"}</span><div><strong>{dw.label}</strong>{!dw.active && <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>Demand entry is closed right now</div>}</div></div>
    {[{ s: "manual", icon: "✏️", t: "Demand — Manual Entry", sub: dw.label, isDemand: false, tag: "⚡ OPEN", tagC: "#B45309", bg: "linear-gradient(135deg,#FFFBEB,#FFF7ED)", bc: "#FDE68A" }, { s: "daily_sales", icon: "💰", t: "Daily Sales & Cash", sub: "Sales, UPI, cash reconciliation", bg: "linear-gradient(135deg,#F0FDF4,#ECFDF5)", bc: "#BBF7D0" }, { s: "purchase", icon: "🧾", t: "Cash Purchase", sub: "Record local purchase with bill", bg: "linear-gradient(135deg,#FFF7ED,#FFFBEB)", bc: "#FED7AA" }, { s: "wastage", icon: "🗑️", t: "Wastage / Disposal", sub: "Record expired or disposed items", tag: "⚠️ Audit trail", tagC: "#991B1B", bg: "linear-gradient(135deg,#FEF2F2,#FFF1F2)", bc: "#FECACA" }, { s: "close", icon: "📊", t: "Closing Stock", sub: "End of day — stock remaining", tag: "⚠️ Must fill daily", tagC: "#991B1B", bg: "linear-gradient(135deg,#EFF6FF,#F0F9FF)", bc: "#BFDBFE" }].map((opt) => (<button key={opt.s} onClick={() => { reset(); resetPurchase(); setClosing({}); setScreen(opt.s); }} style={{ width: "100%", padding: "18px 20px", borderRadius: 16, border: `1.5px solid ${opt.bc}`, background: opt.bg, textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14, opacity: 1 }}><div style={{ fontSize: 34 }}>{opt.icon}</div><div><div style={{ fontSize: 16, fontWeight: 800 }}>{opt.t}</div><div style={{ fontSize: 12, color: "#888" }}>{opt.sub}</div>{opt.tag && <div style={{ fontSize: 10, fontWeight: 700, color: opt.tagC, marginTop: 3 }}>{opt.tag}</div>}</div></button>))}
    {onBack && <button onClick={onBack} style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>}
  </div>); }

  // ── DAILY SALES & CASH RECONCILIATION ──
  if (screen === "daily_sales") {

    const loadSalesData = () => {
      setSalesLoading(true);
      Promise.all([
        api.getOutletSales({ outlet_id: outlet, date: today() }).catch(() => []),
        api.getLatestCash(outlet, today()).catch(() => null),
      ]).then(([sales, prev]) => {
        if (sales && sales.length > 0) {
          const s = sales[0];
          setSalesData({ total_sale: s.total_sale || "", swiggy_sale: s.swiggy_sale || "", zomato_sale: s.zomato_sale || "", other_delivery_sale: s.other_delivery_sale || "", cancelled_orders: s.cancelled_orders || "", complimentary_amount: s.complimentary_amount || "", complimentary_reason: s.complimentary_reason || "", zomato_district: s.zomato_district || "", upi_collected: s.upi_collected || "", cash_collected: s.cash_collected || "", cash_expense: s.cash_expense || "", cash_expense_note: s.cash_expense_note || "", cash_deposited: s.cash_deposited || "", notes: s.notes || "" });
          setExistingData(s);
        }
        if (prev) {
          const closingCash = Number(prev.prev_day_cash || 0) + Number(prev.cash_collected || 0) - Number(prev.cash_expense || 0) - Number(prev.cash_deposited || 0);
          setPrevCash(closingCash);
        }
      }).finally(() => setSalesLoading(false));
    };
    if (!salesLoaded) { setSalesLoaded(true); loadSalesData(); }

    const n = (v) => Number(v) || 0;
    const totalSale = n(salesData.total_sale);
    const deliverySale = n(salesData.swiggy_sale) + n(salesData.zomato_sale) + n(salesData.other_delivery_sale);
    const cancelledOrders = n(salesData.cancelled_orders);
    const complimentaryAmt = n(salesData.complimentary_amount);
    const storeSale = Math.max(0, totalSale - deliverySale - cancelledOrders - complimentaryAmt);
    const upi = n(salesData.upi_collected);
    const cash = n(salesData.cash_collected);
    const zomatoDistrict = n(salesData.zomato_district);
    const paymentTotal = upi + cash;
    const effectivePayment = paymentTotal - zomatoDistrict;
    const paymentDiff = storeSale - effectivePayment;
    const closingCash = prevCash + cash - n(salesData.cash_expense) - n(salesData.cash_deposited);

    const submitSales = async () => {
      setSalesSaving(true);
      try {
        await api.submitOutletSales({ outlet_id: outlet, date: today(), total_sale: totalSale, swiggy_sale: n(salesData.swiggy_sale), zomato_sale: n(salesData.zomato_sale), other_delivery_sale: n(salesData.other_delivery_sale), cancelled_orders: cancelledOrders, complimentary_amount: complimentaryAmt, complimentary_reason: salesData.complimentary_reason || null, zomato_district: zomatoDistrict, upi_collected: upi, cash_collected: cash, prev_day_cash: prevCash, cash_expense: n(salesData.cash_expense), cash_expense_note: salesData.cash_expense_note, cash_deposited: n(salesData.cash_deposited), submitted_by: getCurrentUser()?.name || outlet, notes: salesData.notes });
        alert("✅ Daily sales saved!");
        setScreen("home");
      } catch (e) { alert("Error: " + e.message); }
      finally { setSalesSaving(false); }
    };

    if (salesLoading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;

    const numInputStyle = { width: 100, padding: "5px 8px", borderRadius: 6, border: "1px solid #E8E8E4", fontSize: 16, textAlign: "right", fontFamily: "'JetBrains Mono'", fontWeight: 700, background: "#fff" };
    const salesRow = (label, field, prefix) => (
      <div key={field} style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F5F5F3" }}>
        <span style={{ flex: 1, fontSize: 12, color: "#555" }}>{label}</span>
        <span style={{ fontSize: 12, color: "#999" }}>{prefix}</span>
        <input type="number" inputMode="numeric" placeholder="0" value={salesData[field]} onChange={(e) => setSalesData((p) => ({ ...p, [field]: e.target.value }))} style={numInputStyle} />
      </div>
    );
    const V = ({ label, value, color }) => (
      <div style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F5F5F3" }}>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "#555" }}>{label}</span>
        <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono'", fontWeight: 800, color: color || "#1A1A1A" }}>₹{value}</span>
      </div>
    );

    return (<div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}><BackBtn onClick={() => { setSalesLoaded(false); setExistingData(null); setSalesData({ total_sale: "", swiggy_sale: "", zomato_sale: "", other_delivery_sale: "", cancelled_orders: "", complimentary_amount: "", complimentary_reason: "", zomato_district: "", upi_collected: "", cash_collected: "", cash_expense: "", cash_expense_note: "", cash_deposited: "", notes: "" }); setScreen("home"); }} /><div style={{ flex: 1, fontSize: 14, fontWeight: 800 }}>💰 Daily Sales</div><span style={{ fontSize: 10, color: "#999" }}>{today()}</span></div>

      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "8px 12px", marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#B45309", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Sales</div>
        {salesRow("Total Sale (Billing)", "total_sale", "₹")}
        {salesRow("Swiggy", "swiggy_sale", "₹")}
        {salesRow("Zomato", "zomato_sale", "₹")}
        {salesRow("Other Delivery", "other_delivery_sale", "₹")}
        <div style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F5F5F3" }}>
          <span style={{ flex: 1, fontSize: 12, color: "#DC2626" }}>− Cancelled Orders</span>
          <span style={{ fontSize: 12, color: "#999" }}>₹</span>
          <input type="number" inputMode="numeric" placeholder="0" value={salesData.cancelled_orders} onChange={(e) => setSalesData((p) => ({ ...p, cancelled_orders: e.target.value }))} style={{ ...numInputStyle, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626" }} />
        </div>
        <div style={{ padding: "6px 0", borderBottom: "1px solid #F5F5F3" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ flex: 1, fontSize: 12, color: "#DC2626" }}>− Complimentary Order</span>
            <span style={{ fontSize: 12, color: "#999" }}>₹</span>
            <input type="number" inputMode="numeric" placeholder="0" value={salesData.complimentary_amount} onChange={(e) => setSalesData((p) => ({ ...p, complimentary_amount: e.target.value }))} style={{ ...numInputStyle, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626" }} />
          </div>
          {n(salesData.complimentary_amount) > 0 && (
            <select value={salesData.complimentary_reason} onChange={(e) => setSalesData((p) => ({ ...p, complimentary_reason: e.target.value }))} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E8E8E4", fontSize: 12, fontFamily: "inherit", background: "#FAFAF8", marginTop: 4, color: salesData.complimentary_reason ? "#1A1A1A" : "#999", cursor: "pointer" }}>
              <option value="">Select reason...</option>
              <option value="sir">Sir</option>
              <option value="mam">Mam</option>
              <option value="quality_issue">Quality Issue</option>
            </select>
          )}
        </div>
        <V label="🏪 Store Sale" value={storeSale} color="#16A34A" />
      </div>

      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "8px 12px", marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#2563EB", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Payment (Store Sale)</div>
        {salesRow("UPI Collected", "upi_collected", "₹")}
        {salesRow("Cash Collected", "cash_collected", "₹")}
        <div style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F5F5F3" }}>
          <span style={{ flex: 1, fontSize: 12, color: "#7C3AED" }}>− Paid by Zomato District</span>
          <span style={{ fontSize: 12, color: "#999" }}>₹</span>
          <input type="number" inputMode="numeric" placeholder="0" value={salesData.zomato_district} onChange={(e) => setSalesData((p) => ({ ...p, zomato_district: e.target.value }))} style={{ ...numInputStyle, border: "1px solid #C4B5FD", background: "#F5F3FF", color: "#7C3AED" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 11, fontWeight: 700 }}>
          <span>UPI+Cash−Zomato = ₹{effectivePayment}</span>
          <span style={{ color: paymentDiff === 0 ? "#16A34A" : "#DC2626" }}>{paymentDiff === 0 ? "✅ Match" : `⚠️ ₹${paymentDiff}`}</span>
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", padding: "8px 12px", marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9333EA", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Cash Management</div>
        <V label="Previous Day Cash" value={prevCash} color="#555" />
        <V label="+ Today Cash" value={cash} color="#16A34A" />
        {salesRow("− Cash Expense", "cash_expense", "₹")}
        <input value={salesData.cash_expense_note} onChange={(e) => setSalesData((p) => ({ ...p, cash_expense_note: e.target.value }))} placeholder="Expense note..." style={{ width: "100%", padding: "5px 8px", borderRadius: 6, border: "1px solid #E8E8E4", fontSize: 11, fontFamily: "inherit", background: "#FAFAF8", marginBottom: 2, boxSizing: "border-box" }} />
        {salesRow("− Cash Deposited", "cash_deposited", "₹")}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 4px", fontSize: 13, fontWeight: 800 }}>
          <span>💰 Closing Cash</span>
          <span style={{ fontFamily: "'JetBrains Mono'", color: closingCash >= 0 ? "#B45309" : "#DC2626", fontSize: 16 }}>₹{closingCash}</span>
        </div>
      </div>

      <input value={salesData.notes} onChange={(e) => setSalesData((p) => ({ ...p, notes: e.target.value }))} placeholder="Notes..." style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit", background: "#fff", marginBottom: 8, boxSizing: "border-box" }} />

      <div style={{ position: "sticky", bottom: 0, padding: "8px 0", background: "linear-gradient(transparent, #FAF9F6 20%)", zIndex: 10 }}>
        <button onClick={submitSales} disabled={salesSaving || !totalSale} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: salesSaving || !totalSale ? "#D0D0CC" : "#16A34A", color: "#fff", fontWeight: 800, fontSize: 14, cursor: salesSaving || !totalSale ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
          {salesSaving ? "⏳..." : existingData ? "💾 Update" : "💰 Submit Sales"}
        </button>
      </div>
    </div>);
  }

  if (screen === "wastage") { const ft = Object.values(draft).filter((v) => v > 0).length; const wastageSections = DEMAND_SECTIONS.filter((sec) => sec.id === "food");
    // Items to hide from wastage (not relevant for disposal tracking)
    const wastageHidden = new Set(["roasted_peanuts", "roasted_chana", "roasted_karipatta", "podi_masala", "upma_sooji"]);
    const wastageFilterItems = (items) => items.filter((i) => !wastageHidden.has(i.id));
    const activeSec = wastageSections.find((s) => s.id === expSec) || wastageSections[0]; if (!expSec || !wastageSections.find((s) => s.id === expSec)) setExpSec(wastageSections[0].id); return (<div><SavingOverlay />
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>🗑️ Wastage / Disposal</div>{ft > 0 && <span style={{ padding: "3px 10px", borderRadius: 6, background: "#FEF2F2", color: "#DC2626", fontSize: 11, fontWeight: 700 }}>{ft} items</span>}</div>
    <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 14 }}>⚠️ Record every item that was thrown away, expired, or disposed. Tracked for audit.</div>
    <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4, position: "sticky", top: 0, background: "#FAF9F6", zIndex: 10, paddingTop: 4 }}>
      {wastageSections.map((sec) => { const fl = sec.items.filter((i) => draft[i.id] > 0).length; return (
        <button key={sec.id} onClick={() => setExpSec(sec.id)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: (expSec || wastageSections[0].id) === sec.id ? 700 : 500, border: (expSec || wastageSections[0].id) === sec.id ? "none" : `1px solid ${sec.border}`, cursor: "pointer", fontFamily: "inherit", background: (expSec || wastageSections[0].id) === sec.id ? sec.color : "#fff", color: (expSec || wastageSections[0].id) === sec.id ? "#fff" : sec.color, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
          <span>{sec.emoji}</span>{sec.titleHi}{fl > 0 && <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.3)", fontSize: 10, fontWeight: 800 }}>{fl}</span>}
        </button>); })}
    </div>
    <div style={{ background: "#fff", borderRadius: 14, border: `1px solid ${activeSec.border}`, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "10px 16px", background: activeSec.bg, borderBottom: `1px solid ${activeSec.border}`, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>{activeSec.emoji}</span><span style={{ fontSize: 14, fontWeight: 700 }}>{activeSec.titleHi}</span><span style={{ fontSize: 11, color: "#999" }}>({wastageFilterItems(activeSec.items).length})</span>
      </div>
      <div style={{ padding: "6px 12px 12px" }}>{wastageFilterItems(activeSec.items).map((item) => (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: draft[item.id] > 0 ? "#FEF2F2" : "#FAFAF8", marginBottom: 3 }}><span style={{ flex: 1, fontSize: 13 }}>{item.name}</span><input type="number" inputMode="numeric" min="0" placeholder="0" value={draft[item.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 56, padding: "6px", borderRadius: 8, border: `1px solid ${draft[item.id] > 0 ? "#FECACA" : activeSec.border}`, background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} /><span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.unit}</span></div>))}</div>
    </div>
    <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(transparent, #FAF9F6 20%)", padding: "12px 0", zIndex: 10 }}>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for wastage (expired, dropped, etc.)..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "0 0 8px", boxSizing: "border-box" }} />
      <ErrBar />
      <button onClick={() => submit("wastage")} disabled={ft === 0 || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: ft > 0 && !saving ? "#DC2626" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: ft > 0 && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳ Submitting..." : `🗑️ Record Wastage (${ft} items)`}</button>
    </div>
  </div>); }

  if (screen === "manual" && !demandSlot) {
    return (<div><SavingOverlay />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>✏️ Manual Entry</div></div>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🕐</div>
        <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>When do you need this?</h3>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>Select the delivery slot for your demand</p>
      </div>
      <button onClick={() => setDemandSlot("morning")} style={{ width: "100%", padding: "20px", borderRadius: 16, border: "1px solid #FDE68A", background: "linear-gradient(135deg, #FFFBEB, #FFF7ED)", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 40 }}>🌅</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#B45309" }}>Morning Delivery</div>
          <div style={{ fontSize: 13, color: "#92400E", marginTop: 2 }}>{istDateAgo(-1)} (Tomorrow)</div>
          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>Items will be prepared tonight & dispatched tomorrow morning</div>
        </div>
        <span style={{ color: "#D97706", fontSize: 18 }}>→</span>
      </button>
      <button onClick={() => setDemandSlot("evening")} style={{ width: "100%", padding: "20px", borderRadius: 16, border: "1px solid #BFDBFE", background: "linear-gradient(135deg, #EFF6FF, #F0F9FF)", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 40 }}>🌇</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#2563EB" }}>Evening Delivery</div>
          <div style={{ fontSize: 13, color: "#1D4ED8", marginTop: 2 }}>{today()} (Today)</div>
          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>Items needed for today's evening shift</div>
        </div>
        <span style={{ color: "#2563EB", fontSize: 18 }}>→</span>
      </button>
    </div>);
  }

  if (screen === "manual" && demandSlot) {
    const ft = Object.values(draft).filter((v) => v > 0).length;
    const staffFoodCount = Object.values(staffFood).filter((v) => v > 0).length;
    const totalCount = ft + staffFoodCount + staffDress.length;
    const isStaffFood = expSec === "__staff_food";
    const isStaffDress = expSec === "__staff_dress";
    const isRegular = !isStaffFood && !isStaffDress;
    const activeSec = isRegular ? (DEMAND_SECTIONS.find((s) => s.id === expSec) || DEMAND_SECTIONS[0]) : null;
    if (!expSec) setExpSec(DEMAND_SECTIONS[0].id);

    // Items to hide from manual demand (redundant or not needed by outlets)
    const manualHidden = new Set(["white_chutney", "coconut", "staff_veg", "plain_idli", "butter_idli", "podi_idli", "dosa", "rawa_mix_item", "vada", "upma", "boiled_rice", "lemon_rice", "tomato_rice", "curd_rice"]);
    const filterManualItems = (items) => items.filter((i) => !manualHidden.has(i.id));

    // Save current category items to DB as draft
    const saveCategory = async (secId) => {
      const deliveryDate = demandSlot === "morning" ? istDateAgo(-1) : today();
      const slotNote = `[${demandSlot === "morning" ? "🌅 Morning " + deliveryDate : "🌇 Evening " + deliveryDate}]`;
      try {
        if (draftId) {
          // Update existing draft with new items merged
          await api.updateDemandDraft(draftId, { items: draft });
        } else {
          // Create new draft
          const result = await api.createDemand({ outlet_id: outlet, type: "manual", items: draft, note: slotNote, date: deliveryDate, demand_slot: demandSlot, status: "draft", submitted_by: getCurrentUser()?.name || outlet });
          if (result?.id) setDraftId(result.id);
        }
        setSavedSections((p) => ({ ...p, [secId]: true }));
        // Auto-advance to next unsaved category
        const currentIdx = DEMAND_SECTIONS.findIndex((s) => s.id === secId);
        const nextUnsaved = DEMAND_SECTIONS.slice(currentIdx + 1).find((s) => !savedSections[s.id]);
        if (nextUnsaved) setExpSec(nextUnsaved.id);
      } catch (e) { alert("Save failed: " + e.message); }
    };

    const submitStaffFood = async () => {
      if (staffFoodCount === 0) return;
      setStaffSaving(true); setErr(null);
      try {
        const foodItems = Object.entries(staffFood).filter(([, q]) => q > 0).map(([item, qty]) => ({ item, qty }));
        await api.submitStaffDemand({ outlet_id: outlet, date: today(), shift: staffShift, category: "food", items: foodItems, note, submitted_by: getCurrentUser()?.name || outlet });
        alert(`✅ Staff food (${staffShift.toUpperCase()}) submitted — ${foodItems.length} items`);
        setStaffFood({});
      } catch (e) { setErr(e.message); }
      finally { setStaffSaving(false); }
    };

    const submitStaffDress = async () => {
      if (staffDress.length === 0) return;
      setStaffSaving(true); setErr(null);
      try {
        await api.submitStaffDemand({ outlet_id: outlet, date: today(), shift: null, category: "dress", items: staffDress, note, submitted_by: getCurrentUser()?.name || outlet });
        alert(`✅ Dress request submitted — ${staffDress.length} items`);
        setStaffDress([]);
      } catch (e) { setErr(e.message); }
      finally { setStaffSaving(false); }
    };

    const addDressRow = () => {
      setStaffDress((p) => [...p, { item: "tshirt", role: "", size: "" }]);
    };
    const updateDress = (idx, field, val) => setStaffDress((p) => p.map((r, i) => i === idx ? { ...r, [field]: val } : r));
    const removeDress = (idx) => setStaffDress((p) => p.filter((_, i) => i !== idx));

    // Get dress item config from DB
    const tshirtConfig = staffDressItems.find((d) => d.id === "tshirt");
    const dressRoles = tshirtConfig?.options?.role || ["Chef", "Helper", "Manager", "Housekeeping"];
    const dressSizes = tshirtConfig?.options?.size || ["S", "M", "L", "XL", "XXL"];

    return (<div><SavingOverlay /><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}><BackBtn onClick={() => setDemandSlot(null)} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>✏️ Manual Entry</div><span style={{ padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: demandSlot === "morning" ? "#FFFBEB" : "#EFF6FF", color: demandSlot === "morning" ? "#B45309" : "#2563EB", border: `1px solid ${demandSlot === "morning" ? "#FDE68A" : "#BFDBFE"}` }}>{demandSlot === "morning" ? "🌅 Morning" : "🌇 Evening"} · {demandSlot === "morning" ? istDateAgo(-1) : today()}</span>{totalCount > 0 && <span style={{ padding: "3px 10px", borderRadius: 6, background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700 }}>{totalCount}</span>}</div>

    {/* Category Pills — regular + staff */}
    <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4, position: "sticky", top: 0, background: "#FAF9F6", zIndex: 10, paddingTop: 4 }}>
      {DEMAND_SECTIONS.map((sec) => { const fl = filterManualItems(sec.items).filter((i) => draft[i.id] > 0).length; const isSaved = savedSections[sec.id]; return (
        <button key={sec.id} onClick={() => setExpSec(sec.id)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: (expSec || DEMAND_SECTIONS[0].id) === sec.id ? 700 : 500, border: (expSec || DEMAND_SECTIONS[0].id) === sec.id ? "none" : `1px solid ${isSaved ? "#BBF7D0" : sec.border}`, cursor: "pointer", fontFamily: "inherit", background: (expSec || DEMAND_SECTIONS[0].id) === sec.id ? sec.color : isSaved ? "#F0FDF4" : "#fff", color: (expSec || DEMAND_SECTIONS[0].id) === sec.id ? "#fff" : isSaved ? "#16A34A" : sec.color, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
          {isSaved && <span style={{ fontSize: 10 }}>✅</span>}<span>{sec.emoji}</span>{sec.titleHi}{fl > 0 && <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.3)", fontSize: 10, fontWeight: 800 }}>{fl}</span>}
        </button>);
      })}
      {/* Staff Food pill */}
      <button onClick={() => setExpSec("__staff_food")} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: isStaffFood ? 700 : 500, border: isStaffFood ? "none" : "1px solid #FED7AA", cursor: "pointer", fontFamily: "inherit", background: isStaffFood ? "#D97706" : "#fff", color: isStaffFood ? "#fff" : "#D97706", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
        <span>🍛</span>Staff Food{staffFoodCount > 0 && <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.3)", fontSize: 10, fontWeight: 800 }}>{staffFoodCount}</span>}
      </button>
      {/* Staff Dress pill */}
      <button onClick={() => setExpSec("__staff_dress")} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: isStaffDress ? 700 : 500, border: isStaffDress ? "none" : "1px solid #C4B5FD", cursor: "pointer", fontFamily: "inherit", background: isStaffDress ? "#7C3AED" : "#fff", color: isStaffDress ? "#fff" : "#7C3AED", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
        <span>👕</span>Staff Dress{staffDress.length > 0 && <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.3)", fontSize: 10, fontWeight: 800 }}>{staffDress.length}</span>}
      </button>
    </div>

    {/* ── REGULAR DEMAND SECTIONS ── */}
    {isRegular && activeSec && (<>
      <div style={{ background: "#fff", borderRadius: 14, border: `1px solid ${activeSec.border}`, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ padding: "10px 16px", background: activeSec.bg, borderBottom: `1px solid ${activeSec.border}`, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>{activeSec.emoji}</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{activeSec.titleHi}</span>
          <span style={{ fontSize: 11, color: "#999" }}>({filterManualItems(activeSec.items).length} items)</span>
          {savedSections[activeSec.id] && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#F0FDF4", color: "#16A34A", fontWeight: 700 }}>✅ Saved</span>}
        </div>
        <div style={{ padding: "6px 12px 12px" }}>{filterManualItems(activeSec.items).map((item) => (<div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: draft[item.id] > 0 ? activeSec.bg : "#FAFAF8", marginBottom: 3 }}><span style={{ flex: 1, fontSize: 13 }}>{item.name}</span><input type="number" inputMode="numeric" min="0" placeholder="0" value={draft[item.id] || ""} onChange={(e) => setDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ width: 56, padding: "6px", borderRadius: 8, border: `1px solid ${activeSec.border}`, background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} /><span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.unit}</span></div>))}</div>
      </div>
      {/* Sticky footer — Save + Submit side by side */}
      <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(transparent, #FAF9F6 20%)", padding: "12px 0", zIndex: 10 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          {DEMAND_SECTIONS.map((sec) => {
            const isSaved = savedSections[sec.id];
            const hasFilled = filterManualItems(sec.items).some((i) => draft[i.id] > 0);
            return <div key={sec.id} style={{ flex: 1, height: 4, borderRadius: 2, background: isSaved ? "#16A34A" : hasFilled ? "#FDE68A" : "#E0E0DC" }} />;
          })}
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any extra note..." style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "0 0 8px", boxSizing: "border-box" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => saveCategory(activeSec.id)} style={{ flex: 1, padding: "14px", borderRadius: 14, border: `1px solid ${activeSec.border}`, background: savedSections[activeSec.id] ? "#F0FDF4" : activeSec.bg, color: savedSections[activeSec.id] ? "#16A34A" : activeSec.color, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
            {savedSections[activeSec.id] ? "✅ Update" : "💾 Save"}
          </button>
          <button onClick={() => submit("manual")} disabled={ft === 0} style={{ flex: 2, padding: "14px", borderRadius: 14, border: "none", background: ft > 0 ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 14, cursor: ft > 0 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>✅ Submit All ({ft})</button>
        </div>
      </div>
    </>)}

    {/* ── STAFF FOOD SECTION ── */}
    {isStaffFood && (
      <div>
        {/* AM/PM shift pills */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {["am", "pm"].map((s) => (
            <button key={s} onClick={() => setStaffShift(s)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: staffShift === s ? "none" : "1px solid #FDE68A", background: staffShift === s ? "#D97706" : "#FFFBEB", color: staffShift === s ? "#fff" : "#B45309", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase" }}>
              {s === "am" ? "☀️ Morning" : "🌙 Evening"}
            </button>
          ))}
        </div>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #FDE68A", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ padding: "10px 16px", background: "#FFFBEB", borderBottom: "1px solid #FDE68A", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>🍛</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#B45309" }}>Staff Food — {staffShift === "am" ? "Morning" : "Evening"}</span>
          </div>
          <div style={{ padding: "10px 14px" }}>
            {staffFoodItems.map((item) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px", borderRadius: 10, background: staffFood[item.id] > 0 ? "#FFFBEB" : "#FAFAF8", marginBottom: 4 }}>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{item.name}</span>
                <input type="number" inputMode="numeric" min="0" placeholder="0" value={staffFood[item.id] || ""}
                  onChange={(e) => setStaffFood((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))}
                  style={{ width: 64, padding: "8px", borderRadius: 8, border: "1px solid #FDE68A", background: "#fff", fontSize: 16, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: "#B45309" }} />
                <span style={{ fontSize: 11, color: "#999", width: 30 }}>{item.unit}</span>
              </div>
            ))}
            {staffFoodItems.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#999", fontSize: 12 }}>No food items configured. Add via Master Data.</div>}
          </div>
        </div>
        <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(transparent, #FAF9F6 20%)", padding: "12px 0", zIndex: 10 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any note (e.g., extra roti for event)..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "0 0 8px", boxSizing: "border-box" }} />
          <ErrBar />
          <button onClick={submitStaffFood} disabled={staffFoodCount === 0 || staffSaving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: staffFoodCount > 0 && !staffSaving ? "#D97706" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: staffFoodCount > 0 && !staffSaving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
            {staffSaving ? "⏳ Submitting..." : `🍛 Submit Staff Food — ${staffShift.toUpperCase()} (${staffFoodCount} items)`}
          </button>
        </div>
      </div>
    )}

    {/* ── STAFF DRESS SECTION ── */}
    {isStaffDress && (
      <div>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #C4B5FD", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ padding: "10px 16px", background: "#F5F3FF", borderBottom: "1px solid #C4B5FD", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>👕</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#7C3AED" }}>Staff Dress Request</span>
          </div>
          <div style={{ padding: "10px 14px" }}>
            {staffDress.length === 0 && (
              <div style={{ padding: "20px", textAlign: "center", color: "#999", fontSize: 12 }}>No items added yet. Tap "+ Add T-Shirt" below.</div>
            )}
            {staffDress.map((row, idx) => (
              <div key={idx} style={{ background: "#F5F3FF", borderRadius: 12, padding: "12px 14px", marginBottom: 8, border: "1px solid #DDD6FE" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>👕 T-Shirt #{idx + 1}</span>
                  <button onClick={() => removeDress(idx)} style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✕</button>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", fontWeight: 600, marginBottom: 4 }}>Role</div>
                    <select value={row.role} onChange={(e) => updateDress(idx, "role", e.target.value)}
                      style={{ width: "100%", padding: "10px 8px", borderRadius: 8, border: "1px solid #C4B5FD", fontSize: 13, fontFamily: "inherit", fontWeight: 600, background: "#fff", color: row.role ? "#7C3AED" : "#999", cursor: "pointer" }}>
                      <option value="">Select Role</option>
                      {dressRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", fontWeight: 600, marginBottom: 4 }}>Size</div>
                    <select value={row.size} onChange={(e) => updateDress(idx, "size", e.target.value)}
                      style={{ width: "100%", padding: "10px 8px", borderRadius: 8, border: "1px solid #C4B5FD", fontSize: 13, fontFamily: "inherit", fontWeight: 600, background: "#fff", color: row.size ? "#7C3AED" : "#999", cursor: "pointer" }}>
                      <option value="">Select Size</option>
                      {dressSizes.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ))}
            <button onClick={addDressRow} style={{ width: "100%", padding: "12px", borderRadius: 10, border: "2px dashed #C4B5FD", background: "transparent", fontSize: 13, fontWeight: 700, color: "#7C3AED", cursor: "pointer", fontFamily: "inherit" }}>
              + Add T-Shirt
            </button>
          </div>
        </div>
        <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(transparent, #FAF9F6 20%)", padding: "12px 0", zIndex: 10 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any note (e.g., urgent, replacing torn)..." style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "0 0 8px", boxSizing: "border-box" }} />
          <ErrBar />
          <button onClick={submitStaffDress} disabled={staffDress.length === 0 || staffDress.some((d) => !d.role || !d.size) || staffSaving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: staffDress.length > 0 && !staffDress.some((d) => !d.role || !d.size) && !staffSaving ? "#7C3AED" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: staffDress.length > 0 && !staffDress.some((d) => !d.role || !d.size) && !staffSaving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
            {staffSaving ? "⏳ Submitting..." : staffDress.some((d) => !d.role || !d.size) ? "👕 Select Role & Size for all" : `👕 Submit Dress Request (${staffDress.length} items)`}
          </button>
        </div>
      </div>
    )}
  </div>); }

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
      <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(transparent, #FAF9F6 20%)", padding: "12px 0", zIndex: 10 }}>
        {totalAmt > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderRadius: 12, background: "#FFFBEB", border: "1px solid #FDE68A", marginBottom: 8 }}><span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>Total</span><span style={{ fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#B45309" }}>{fmt(totalAmt)}</span></div>}
        <button onClick={submitPurchase} disabled={!canSubmit || saving} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: canSubmit && !saving ? "#B45309" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: canSubmit && !saving ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳ Submitting..." : `🧾 Record Purchase ${totalAmt > 0 ? `— ${fmt(totalAmt)}` : ""}`}</button>
      </div>
    </div>);
  }

  if (screen === "close") { 
    const csSections = DEMAND_SECTIONS;
    const csActiveSec = csSections.find((s) => s.id === expSec) || csSections[0];
    if (!expSec) setExpSec(csSections[0].id);
    const csItems = csActiveSec.items.map((i) => ({ id: `cs_${i.id}`, name: i.name, unit: i.unit }));
    const allFilled = CLOSING_STOCK.filter((i) => closing[i.id] !== undefined && closing[i.id] !== "").length;
    const secFilled = csItems.filter((i) => closing[i.id] !== undefined && closing[i.id] !== "").length;
    const done = allFilled === CLOSING_STOCK.length;
    return (<div><SavingOverlay />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>📊 Closing Stock</div><span style={{ fontSize: 12, fontWeight: 700, color: done ? "#16A34A" : "#B45309" }}>{allFilled}/{CLOSING_STOCK.length}</span></div>
      <div style={{ padding: "8px 12px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 11, color: "#991B1B", marginBottom: 10 }}>⚠️ Fill all items. Write 0 if finished.</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 4, position: "sticky", top: 0, background: "#FAF9F6", zIndex: 10, paddingTop: 4 }}>
        {csSections.map((sec) => { const fl = sec.items.filter((i) => closing[`cs_${i.id}`] !== undefined && closing[`cs_${i.id}`] !== "").length; return (
          <button key={sec.id} onClick={() => setExpSec(sec.id)} style={{ padding: "7px 12px", borderRadius: 8, fontSize: 11, fontWeight: (expSec || csSections[0].id) === sec.id ? 700 : 500, border: (expSec || csSections[0].id) === sec.id ? "none" : `1px solid ${sec.border}`, cursor: "pointer", fontFamily: "inherit", background: (expSec || csSections[0].id) === sec.id ? sec.color : "#fff", color: (expSec || csSections[0].id) === sec.id ? "#fff" : sec.color, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
            <span>{sec.emoji}</span>{sec.titleHi}{fl > 0 && <span style={{ padding: "1px 5px", borderRadius: 4, background: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 800 }}>{fl}/{sec.items.length}</span>}
          </button>); })}
      </div>
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 12 }}>
        {csItems.map((item, idx) => { const isFilled = closing[item.id] !== undefined && closing[item.id] !== ""; return (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: idx < csItems.length - 1 ? "1px solid #F0F0EC" : "none", background: isFilled ? "#F0FDF4" : "#fff" }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{item.name}</span>
            <input type="number" inputMode="decimal" min="0" step="0.1" placeholder="—" value={closing[item.id] ?? ""} onChange={(e) => setClosing((p) => ({ ...p, [item.id]: e.target.value === "" ? "" : Math.max(0, +e.target.value || 0) }))} style={{ width: 60, padding: "6px", borderRadius: 8, border: isFilled ? "2px solid #16A34A" : "1px solid #E0E0DC", background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} />
            <span style={{ fontSize: 10, color: "#999", width: 24 }}>{item.unit}</span>
          </div>); })}
      </div>
      <div style={{ position: "sticky", bottom: 0, padding: "8px 0", background: "linear-gradient(transparent, #FAF9F6 20%)", zIndex: 10 }}>
        <button onClick={() => submit("closing")} disabled={!done} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: done ? "#DC2626" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 14, cursor: done ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{done ? "📊 Submit Closing Stock" : `Fill all (${CLOSING_STOCK.length - allFilled} remaining)`}</button>
      </div>
    </div>); }
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
//  STORE MANAGER
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
//  BK DEMAND — Base Kitchen daily requirements (staff food, cleaning, etc.)
// ═════════════════════════════════════════════════════════════════════════════
const BK_DEMAND_SECTIONS = [
  { id: "bk_veg", title: "🥬 Vegetables", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0", items: [
    { id: "bk_tomato", name: "Tomato", unit: "Kg" },
    { id: "bk_ginger", name: "Ginger", unit: "Kg" },
    { id: "bk_garlic", name: "Garlic", unit: "Kg" },
    { id: "bk_coriander", name: "Coriander Leaves", unit: "Gm" },
    { id: "bk_onion", name: "Onion", unit: "Kg" },
  ]},
  { id: "bk_grocery", title: "🛒 Grocery", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A", items: [
    { id: "bk_chhole", name: "Chhole", unit: "Kg" },
    { id: "bk_milk", name: "Milk", unit: "Ltr" },
    { id: "bk_mustard_oil", name: "Mustard Oil", unit: "Ltr" },
    { id: "bk_rajma", name: "Rajma", unit: "Kg" },
    { id: "bk_besan", name: "Besan", unit: "Kg" },
    { id: "bk_curd", name: "Curd", unit: "Kg" },
    { id: "bk_salt", name: "Salt", unit: "Kg" },
    { id: "bk_garam_masala", name: "Garam Masala", unit: "Gm" },
    { id: "bk_jeera", name: "Jeera", unit: "Gm" },
    { id: "bk_black_pepper", name: "Black Pepper", unit: "Gm" },
    { id: "bk_haldi", name: "Haldi Powder", unit: "Gm" },
    { id: "bk_refined_oil", name: "Refined Oil", unit: "Ltr" },
    { id: "bk_desi_ghee", name: "Desi Ghee", unit: "Kg" },
    { id: "bk_soya_badi", name: "Soya Badi", unit: "Kg" },
    { id: "bk_chana_dal", name: "Chana Dal", unit: "Kg" },
    { id: "bk_arhar_dal", name: "Arhar Dal", unit: "Kg" },
  ]},
  { id: "bk_cleaning", title: "🧹 Cleaning", color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC", items: [
    { id: "bk_sarf", name: "Sarf", unit: "Kg" },
    { id: "bk_juna", name: "Juna", unit: "Pcs" },
    { id: "bk_bartan_sabun", name: "Bartan Dhone Ka Sabun", unit: "Pcs" },
    { id: "bk_phenyl", name: "Phenyl", unit: "Ltr" },
    { id: "bk_duster", name: "Duster", unit: "Pcs" },
    { id: "bk_pochha", name: "Pochha", unit: "Pcs" },
    { id: "bk_wiper", name: "Wiper", unit: "Pcs" },
    { id: "bk_sheek_jhadu", name: "Sheek Jhadu", unit: "Pcs" },
    { id: "bk_fool_jhadu", name: "Fool Jhadu", unit: "Pcs" },
    { id: "bk_supli", name: "Supli", unit: "Pcs" },
    { id: "bk_kitchen_wipes", name: "Kitchen Wipes", unit: "Pkt" },
  ]},
  { id: "bk_packaging", title: "📦 Packaging", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE", items: [
    { id: "bk_poly_16x20", name: "16×20 Polythene", unit: "Pkt" },
    { id: "bk_poly_13x16", name: "13×16 Polythene", unit: "Pkt" },
    { id: "bk_bio_garbage", name: "Bio Garbage", unit: "Pkt" },
    { id: "bk_clean_wrap", name: "Clean Wrap", unit: "Pcs" },
  ]},
  { id: "bk_maintenance", title: "🔧 Maintenance", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA", items: [] },
];

const BKDemandForm = () => {
  const [draft, setDraft] = useState({});
  const [expSec, setExpSec] = useState(BK_DEMAND_SECTIONS[0].id);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [savedSections, setSavedSections] = useState({});
  const [draftId, setDraftId] = useState(null);

  const activeSec = BK_DEMAND_SECTIONS.find(s => s.id === expSec) || BK_DEMAND_SECTIONS[0];
  const ft = Object.values(draft).filter(v => v > 0).length;

  // Load existing BK draft
  useEffect(() => {
    api.getOrders({ date: today(), outlet_id: "bk" }).then((orders) => {
      const existing = orders.find(o => o.type === "bk_demand" && (o.status === "draft" || o.status === "submitted"));
      if (existing?.items) {
        setDraft(existing.items);
        setDraftId(existing.id);
        const saved = {};
        BK_DEMAND_SECTIONS.forEach(sec => {
          if (sec.items.some(i => existing.items[i.id] > 0)) saved[sec.id] = true;
        });
        setSavedSections(saved);
      }
    }).catch(() => {});
  }, []);

  const saveCategory = async (secId) => {
    try {
      if (draftId) {
        await api.updateDemandDraft(draftId, { items: draft });
      } else {
        const result = await api.createDemand({ outlet_id: "bk", type: "bk_demand", items: draft, note, date: today(), demand_slot: "morning", status: "draft", submitted_by: getCurrentUser()?.name || "bk" });
        if (result?.id) setDraftId(result.id);
      }
      setSavedSections(p => ({ ...p, [secId]: true }));
      const currentIdx = BK_DEMAND_SECTIONS.findIndex(s => s.id === secId);
      const nextUnsaved = BK_DEMAND_SECTIONS.slice(currentIdx + 1).find(s => s.items.length > 0 && !savedSections[s.id]);
      if (nextUnsaved) setExpSec(nextUnsaved.id);
    } catch (e) { alert("Save failed: " + e.message); }
  };

  const submitAll = async () => {
    if (ft === 0) return;
    setSaving(true);
    try {
      if (draftId) {
        await api.updateDemandDraft(draftId, { items: draft });
        await api.updateOrderStatus(draftId, "submitted");
      } else {
        await api.createDemand({ outlet_id: "bk", type: "bk_demand", items: draft, note, date: today(), demand_slot: "morning", submitted_by: getCurrentUser()?.name || "bk" });
      }
      alert(`✅ BK Demand submitted — ${ft} items`);
      setDraft({}); setSavedSections({}); setDraftId(null); setNote("");
    } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  return (<div>
    <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 14px" }}>🏭 BK Daily Demand</h3>
    {/* Category pills */}
    <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4 }}>
      {BK_DEMAND_SECTIONS.filter(s => s.items.length > 0).map(sec => {
        const fl = sec.items.filter(i => draft[i.id] > 0).length;
        const isSaved = savedSections[sec.id];
        return (<button key={sec.id} onClick={() => setExpSec(sec.id)} style={{ padding: "8px 12px", borderRadius: 10, fontSize: 11, fontWeight: expSec === sec.id ? 700 : 500, border: expSec === sec.id ? "none" : `1px solid ${isSaved ? "#BBF7D0" : sec.border}`, cursor: "pointer", fontFamily: "inherit", background: expSec === sec.id ? sec.color : isSaved ? "#F0FDF4" : "#fff", color: expSec === sec.id ? "#fff" : isSaved ? "#16A34A" : sec.color, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
          {isSaved && <span style={{ fontSize: 9 }}>✅</span>}{sec.title}{fl > 0 && <span style={{ padding: "1px 5px", borderRadius: 4, background: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 800 }}>{fl}</span>}
        </button>);
      })}
    </div>
    {/* Items */}
    <div style={{ background: "#fff", borderRadius: 14, border: `1px solid ${activeSec.border}`, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "10px 16px", background: activeSec.bg, borderBottom: `1px solid ${activeSec.border}`, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: activeSec.color }}>{activeSec.title}</span>
        <span style={{ fontSize: 11, color: "#999" }}>({activeSec.items.length} items)</span>
        {savedSections[activeSec.id] && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#F0FDF4", color: "#16A34A", fontWeight: 700 }}>✅</span>}
      </div>
      <div style={{ padding: "6px 12px 12px" }}>
        {activeSec.items.map(item => (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: draft[item.id] > 0 ? activeSec.bg : "#FAFAF8", marginBottom: 3 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{item.name}</span>
            <input type="number" inputMode="numeric" min="0" placeholder="0" value={draft[item.id] || ""} onChange={e => setDraft(p => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))}
              style={{ width: 56, padding: "6px", borderRadius: 8, border: `1px solid ${activeSec.border}`, background: "#fff", fontSize: 15, textAlign: "center", fontFamily: "inherit", fontWeight: 700 }} />
            <span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.unit}</span>
          </div>
        ))}
      </div>
    </div>
    {/* Footer */}
    <div style={{ position: "sticky", bottom: 0, background: "linear-gradient(transparent, #FAF9F6 20%)", padding: "12px 0", zIndex: 10 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        {BK_DEMAND_SECTIONS.filter(s => s.items.length > 0).map(sec => {
          const isSaved = savedSections[sec.id];
          const hasFilled = sec.items.some(i => draft[i.id] > 0);
          return <div key={sec.id} style={{ flex: 1, height: 4, borderRadius: 2, background: isSaved ? "#16A34A" : hasFilled ? "#FDE68A" : "#E0E0DC" }} />;
        })}
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Any extra note..." style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", margin: "0 0 8px", boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => saveCategory(activeSec.id)} style={{ flex: 1, padding: "14px", borderRadius: 14, border: `1px solid ${activeSec.border}`, background: savedSections[activeSec.id] ? "#F0FDF4" : activeSec.bg, color: savedSections[activeSec.id] ? "#16A34A" : activeSec.color, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
          {savedSections[activeSec.id] ? "✅ Update" : "💾 Save"}
        </button>
        <button onClick={submitAll} disabled={ft === 0 || saving} style={{ flex: 2, padding: "14px", borderRadius: 14, border: "none", background: ft > 0 && !saving ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 14, cursor: ft > 0 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳..." : `✅ Submit All (${ft})`}</button>
      </div>
    </div>
  </div>);
};

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

      {/* BK Daily Demand */}
      <button onClick={() => setScreen("bk_demand")} style={{ width: "100%", padding: "18px 20px", borderRadius: 16, border: "1.5px solid #BBF7D0", background: "linear-gradient(135deg, #F0FDF4, #ECFDF5)", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 34 }}>🏭</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>BK Daily Demand</div>
          <div style={{ fontSize: 12, color: "#888" }}>Staff food, cleaning & maintenance needs</div>
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

      {onBack && <button onClick={onBack} style={{ width: "100%", marginTop: 8, padding: "12px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>← Back to Launcher</button>}
    </div>
  );

  // ── ISSUANCE ──
  if (screen === "bk_demand") return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BackBtn onClick={() => setScreen("home")} /><div style={{ flex: 1, fontSize: 15, fontWeight: 800 }}>🏭 BK Daily Demand</div></div>
      <BKDemandForm />
    </div>
  );

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
//  SALES UPLOAD — PetPooja CSV
// ═════════════════════════════════════════════════════════════════════════════
const SalesUpload = () => {
  const [selDay, setSelDay] = useState(0);
  const [sales, setSales] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadDate, setUploadDate] = useState(today());
  const [useCustomDate, setUseCustomDate] = useState(false);

  const dateStr = useMemo(() => {
    return istDateAgo(selDay);
  }, [selDay]);

  const loadSales = useCallback(() => {
    setLoading(true);
    api.getSales({ date: dateStr }).then(setSales).catch(() => setSales(null)).finally(() => setLoading(false));
  }, [dateStr]);

  useEffect(loadSales, [loadSales]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const dateToUse = useCustomDate ? uploadDate : null;
      const result = await api.uploadSalesCSV(file, dateToUse);
      setUploadResult({ ok: true, msg: `✅ Uploaded ${result.rows_inserted} rows for ${result.date}` });
      loadSales();
    } catch (err) {
      setUploadResult({ ok: false, msg: `❌ ${err.message}` });
      setLoading(false);
    }
    e.target.value = "";
  };

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 14, border: "2px dashed #E8E8E4", padding: 24, textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📤</div>
        <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Upload PetPooja Daily Sales</h3>
        <p style={{ color: "#999", fontSize: 13, margin: "0 0 12px" }}>CSV format: Order Summary Item Report</p>
        
        {/* Date override toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 14 }}>
          <button onClick={() => setUseCustomDate(false)} style={{ padding: "6px 14px", borderRadius: 8, border: !useCustomDate ? "none" : "1px solid #E0E0DC", background: !useCustomDate ? "#1A1A1A" : "#fff", color: !useCustomDate ? "#fff" : "#888", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Auto-detect date</button>
          <button onClick={() => setUseCustomDate(true)} style={{ padding: "6px 14px", borderRadius: 8, border: useCustomDate ? "none" : "1px solid #E0E0DC", background: useCustomDate ? "#B45309" : "#fff", color: useCustomDate ? "#fff" : "#888", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Custom date</button>
        </div>
        {useCustomDate && (
          <div style={{ marginBottom: 14 }}>
            <input type="date" value={uploadDate} onChange={(e) => setUploadDate(e.target.value)} style={{ padding: "10px 16px", borderRadius: 10, border: "2px solid #B45309", fontSize: 16, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, textAlign: "center", color: "#B45309" }} />
            <div style={{ fontSize: 11, color: "#B45309", marginTop: 4, fontWeight: 600 }}>All rows will be saved under this date</div>
          </div>
        )}
        
        <input id="csv-upload" type="file" accept=".csv,.CSV" onChange={handleFile} style={{ display: "none" }} />
        <button onClick={() => document.getElementById("csv-upload").click()} style={{ display: "inline-block", background: "#B45309", color: "#fff", fontWeight: 800, padding: "12px 28px", borderRadius: 10, cursor: "pointer", fontSize: 14, border: "none", fontFamily: "inherit" }}>
          📁 Choose CSV File
        </button>
        {uploadResult && (
          <div style={{ marginTop: 12, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: uploadResult.ok ? "#F0FDF4" : "#FEF2F2",
            color: uploadResult.ok ? "#16A34A" : "#DC2626",
            border: `1px solid ${uploadResult.ok ? "#BBF7D0" : "#FECACA"}` }}>
            {uploadResult.msg}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {Array.from({ length: 10 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - i);
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toISOString().split("T")[0].slice(5);
          return (<button key={i} onClick={() => setSelDay(i)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selDay === i ? 700 : 500, border: selDay === i ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selDay === i ? "#1A1A1A" : "#fff", color: selDay === i ? "#fff" : "#888", whiteSpace: "nowrap" }}>{label}</button>);
        })}
      </div>
      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading sales...</div>}
      {sales && !loading && (
        <>
          {sales.outlets && sales.outlets.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
              {sales.outlets.map((o) => (
                <div key={o.outlet_code} style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4" }}>
                  <div style={{ fontSize: 10, color: "#999", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{o.outlet_code}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#B45309", fontFamily: "'JetBrains Mono', monospace", margin: "4px 0" }}>{fmt(o.revenue || 0)}</div>
                  <div style={{ fontSize: 11, color: "#888" }}>{o.orders} orders</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
            {[
              { l: "Total Revenue", v: fmt(sales.total_revenue || 0), c: "#16A34A" },
              { l: "Items Sold", v: sales.total_items || 0, c: "#2563EB" },
              { l: "Orders", v: sales.total_orders || 0, c: "#B45309" },
            ].map((s, i) => (
              <div key={i} style={{ flex: "1 1 120px", background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{s.l}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: s.c, fontFamily: "'JetBrains Mono', monospace" }}>{s.v}</div>
              </div>
            ))}
          </div>
          {sales.items && (
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid #E8E8E4", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>📋 Item-wise Sales</span>
                <span style={{ fontWeight: 800, color: "#B45309", fontFamily: "'JetBrains Mono', monospace" }}>{fmt(sales.total_revenue || 0)}</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr style={{ background: "#FAFAF8" }}>
                    <th style={thS}>#</th><th style={thS}>Item</th><th style={thS}>Category</th>
                    <th style={{ ...thS, textAlign: "right" }}>Qty</th><th style={{ ...thS, textAlign: "right" }}>Revenue</th>
                  </tr></thead>
                  <tbody>
                    {sales.items.map((item, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid #F0F0EC" }}>
                        <td style={{ ...tdS, color: "#999" }}>{i + 1}</td>
                        <td style={{ ...tdS, fontWeight: 600 }}>{item.item_name}</td>
                        <td style={{ ...tdS, color: "#888" }}>{item.category}</td>
                        <td style={{ ...tdS, textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#2563EB" }}>{item.qty}</td>
                        <td style={{ ...tdS, textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#16A34A" }}>{fmt(item.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  RM AUDIT — Theoretical vs Actual consumption
// ═════════════════════════════════════════════════════════════════════════════
const RMAuditPanel = () => {
  const [selDay, setSelDay] = useState(0);
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(false);

  const dateStr = useMemo(() => {
    return istDateAgo(selDay);
  }, [selDay]);

  useEffect(() => {
    setLoading(true);
    api.getRMAudit(dateStr).then(setAudit).catch(() => setAudit(null)).finally(() => setLoading(false));
  }, [dateStr]);

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>🔍 Raw Material Audit</h3>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>Sales × Recipe = Should Consume vs Actually Issued</p>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {Array.from({ length: 10 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - i);
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toISOString().split("T")[0].slice(5);
          return (<button key={i} onClick={() => setSelDay(i)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selDay === i ? 700 : 500, border: selDay === i ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selDay === i ? "#1A1A1A" : "#fff", color: selDay === i ? "#fff" : "#888", whiteSpace: "nowrap" }}>{label}</button>);
        })}
      </div>
      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Computing audit...</div>}
      {audit?.items && !loading && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={thS}>Raw Material</th><th style={thS}>Unit</th>
                <th style={{ ...thS, textAlign: "right" }}>Should Consume</th>
                <th style={{ ...thS, textAlign: "right" }}>Actual Issued</th>
                <th style={{ ...thS, textAlign: "right" }}>Variance</th>
              </tr></thead>
              <tbody>
                {audit.items.map((item, i) => {
                  const hasActual = item.actual_issued != null;
                  const variance = hasActual ? item.actual_issued - item.should_consume : null;
                  const isOver = variance > 0;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid #F0F0EC" }}>
                      <td style={{ ...tdS, fontWeight: 600 }}>{item.raw_material}</td>
                      <td style={{ ...tdS, color: "#888" }}>{item.unit}</td>
                      <td style={{ ...tdS, textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#2563EB" }}>{Number(item.should_consume).toFixed(2)}</td>
                      <td style={{ ...tdS, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{hasActual ? Number(item.actual_issued).toFixed(2) : "—"}</td>
                      <td style={{ ...tdS, textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: !hasActual ? "#999" : isOver ? "#DC2626" : "#16A34A" }}>
                        {hasActual ? `${isOver ? "+" : ""}${Number(variance).toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "10px 16px", background: "#FAFAF8", fontSize: 11, color: "#888" }}>
            "Actual Issued" connects to issuance records. Shows — until data is available.
          </div>
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  OUTLET RECIPE MANAGER — Store Manager fills recipes for all menu items
//  Ingredients come from BK items (Food section) + Raw Materials
//  All quantities in grams per serving
// ═════════════════════════════════════════════════════════════════════════════
const OutletRecipeManager = () => {
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selRecipe, setSelRecipe] = useState(null); // selected recipe to edit
  const [editIngredients, setEditIngredients] = useState([]); // working copy
  const [saving, setSaving] = useState(false);
  const [addingItem, setAddingItem] = useState(false); // show add new menu item form
  const [newItemName, setNewItemName] = useState("");
  const [newItemCategory, setNewItemCategory] = useState("Dosas");
  const [ingredientSearch, setIngredientSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all"); // all, filled, empty

  const load = () => { setLoading(true); api.getOutletRecipes().then(setRecipes).catch(() => setRecipes([])).finally(() => setLoading(false)); };
  useEffect(load, []);

  // Build searchable ingredient list from BK items (food section) + Raw Materials
  const ingredientOptions = useMemo(() => {
    const opts = [];
    // BK prepared items (from Food section of DEMAND_SECTIONS)
    const foodSection = DEMAND_SECTIONS.find((s) => s.id === "food");
    (foodSection?.items || []).forEach((item) => {
      opts.push({ id: item.id, name: item.name, type: "BK Item", unit: "gm" });
    });
    // Raw materials
    RAW_MATERIALS.forEach((r) => {
      // Avoid duplicates if already in BK items
      if (!opts.find((o) => o.id === r.id)) {
        opts.push({ id: r.id, name: r.name, type: "Raw Material", unit: "gm" });
      }
    });
    // Direct demand items (vegetables, masala, grocery, dairy, etc.)
    // Use actual item unit — Pkt for packaging, Pcs for countable items, gm for weight items
    const gmUnits = new Set(["kg", "gm", "g", "gram", "grams", "ltr", "liter", "litre", "ml"]);
    DEMAND_SECTIONS.filter((s) => s.id !== "food").forEach((sec) => {
      sec.items.forEach((item) => {
        if (!opts.find((o) => o.id === item.id)) {
          const itemUnit = item.unit || "gm";
          const useGm = gmUnits.has(itemUnit.toLowerCase());
          opts.push({ id: item.id, name: item.name, type: sec.titleHi, unit: useGm ? "gm" : itemUnit });
        }
      });
    });
    return opts.sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const categories = [...new Set(recipes.map((r) => r.category))].sort();
  const filledCount = recipes.filter((r) => r.recipe_ingredients && r.recipe_ingredients.length > 0).length;
  const emptyCount = recipes.length - filledCount;

  const filteredRecipes = recipes.filter((r) => {
    if (search && !r.item_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterStatus === "filled" && (!r.recipe_ingredients || r.recipe_ingredients.length === 0)) return false;
    if (filterStatus === "empty" && r.recipe_ingredients && r.recipe_ingredients.length > 0) return false;
    return true;
  });

  const openRecipe = (recipe) => {
    setSelRecipe(recipe);
    setEditIngredients((recipe.recipe_ingredients || []).map((i) => ({
      id: i.id, raw_material: i.raw_material, qty: i.qty, unit: i.unit || "gm", qty_kg: i.qty_kg
    })));
    setIngredientSearch("");
  };

  const saveIngredients = async () => {
    if (!selRecipe) return;
    setSaving(true);
    try {
      const ings = editIngredients.map((i) => ({
        raw_material: i.raw_material,
        qty: Number(i.qty) || 0,
        unit: "gm",
        qty_kg: (Number(i.qty) || 0) / 1000,
      }));
      await api.saveOutletRecipeIngredients(selRecipe.id, ings);
      load();
      setSelRecipe(null);
    } catch (e) { alert("Error: " + e.message); }
    finally { setSaving(false); }
  };

  const addIngredient = (opt) => {
    if (editIngredients.find((i) => i.raw_material === opt.name)) return; // already added
    setEditIngredients((p) => [...p, { id: null, raw_material: opt.name, qty: "", unit: opt.unit || "gm", qty_kg: 0 }]);
    setIngredientSearch("");
  };

  const updateIngQty = (idx, qty) => {
    setEditIngredients((p) => p.map((ing, i) => i === idx ? { ...ing, qty: qty, qty_kg: (Number(qty) || 0) / 1000 } : ing));
  };

  const removeIngredient = (idx) => {
    setEditIngredients((p) => p.filter((_, i) => i !== idx));
  };

  const addMenuItem = async () => {
    if (!newItemName.trim()) return;
    try {
      await api.addOutletRecipe({ item_name: newItemName.trim(), category: newItemCategory });
      setNewItemName(""); setAddingItem(false); load();
    } catch (e) { alert("Error: " + e.message); }
  };

  const deleteMenuItem = async (id, name) => {
    if (!confirm(`Remove "${name}" from menu?`)) return;
    try { await api.deleteOutletRecipe(id); load(); } catch (e) { alert("Error: " + e.message); }
  };

  // ── RECIPE EDITOR VIEW ──
  if (selRecipe) {
    const iq = ingredientSearch.trim().toLowerCase();
    const matches = iq ? ingredientOptions.filter((o) =>
      o.name.toLowerCase().includes(iq) && !editIngredients.find((i) => i.raw_material === o.name)
    ).slice(0, 8) : [];

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <BackBtn onClick={() => setSelRecipe(null)} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>{selRecipe.item_name}</div>
            <div style={{ fontSize: 11, color: "#888" }}>{selRecipe.category} — {editIngredients.length} ingredients</div>
          </div>
        </div>

        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#EFF6FF", border: "1px solid #BFDBFE", fontSize: 12, color: "#1D4ED8", marginBottom: 14 }}>
          ℹ️ Enter quantity in <strong>grams per serving</strong>. For example: Dosa Batter 120gm, Sambhar 80gm for one Plain Dosa.
        </div>

        {/* Current ingredients */}
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ padding: "10px 16px", background: "#F8F8F5", borderBottom: "1px solid #E8E8E4", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>Ingredients</span>
            <span style={{ fontSize: 11, color: "#999" }}>{editIngredients.length} items</span>
          </div>
          {editIngredients.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "#999", fontSize: 12 }}>No ingredients yet — search and add below</div>
          )}
          {editIngredients.map((ing, idx) => (
            <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid #F0F0EC" }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{ing.raw_material}</span>
              <input type="number" inputMode="numeric" min="0" placeholder="gm" value={ing.qty}
                onChange={(e) => updateIngQty(idx, e.target.value)}
                style={{ width: 70, padding: "6px 4px", borderRadius: 6, border: ing.qty ? "2px solid #16A34A" : "1px solid #E0E0DC", fontSize: 15, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: "#B45309", background: "#fff" }} />
              <span style={{ fontSize: 10, color: "#999", width: 20 }}>{ing.unit || "gm"}</span>
              <button onClick={() => removeIngredient(idx)} style={{ width: 24, height: 24, borderRadius: 5, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 12, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
            </div>
          ))}
        </div>

        {/* Add ingredient search */}
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #BBF7D0", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ padding: "10px 14px" }}>
            <input autoFocus value={ingredientSearch} onChange={(e) => setIngredientSearch(e.target.value)}
              placeholder="Search BK items, raw materials, vegetables..."
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#F0FDF4", boxSizing: "border-box" }} />
          </div>
          {iq && matches.length > 0 && (
            <div style={{ borderTop: "1px solid #E8E8E4", maxHeight: 250, overflowY: "auto" }}>
              {matches.map((opt) => (
                <button key={opt.id} onClick={() => addIngredient(opt)} style={{ width: "100%", padding: "10px 14px", border: "none", borderBottom: "1px solid #F5F5F3", background: "#fff", textAlign: "left", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{opt.name}</span>
                  <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: opt.type === "BK Item" ? "#FFFBEB" : "#EFF6FF", color: opt.type === "BK Item" ? "#B45309" : "#2563EB", fontWeight: 700 }}>{opt.type}</span>
                </button>
              ))}
              {/* Free-text add at bottom of suggestions */}
              {!matches.find((m) => m.name.toLowerCase() === iq) && (
                <button onClick={() => {
                  if (editIngredients.find((i) => i.raw_material.toLowerCase() === ingredientSearch.trim().toLowerCase())) return;
                  setEditIngredients((p) => [...p, { id: null, raw_material: ingredientSearch.trim(), qty: "", unit: "gm", qty_kg: 0 }]);
                  setIngredientSearch("");
                }} style={{ width: "100%", padding: "10px 14px", border: "none", borderTop: "1px dashed #FDE68A", background: "#FFFDF5", textAlign: "left", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8, color: "#B45309", fontSize: 12, fontWeight: 700 }}>
                  + Add "{ingredientSearch.trim()}" as new ingredient
                </button>
              )}
            </div>
          )}
          {iq && matches.length === 0 && (
            <div style={{ padding: "8px 14px", borderTop: "1px solid #E8E8E4" }}>
              <button onClick={() => {
                if (editIngredients.find((i) => i.raw_material.toLowerCase() === ingredientSearch.trim().toLowerCase())) return;
                setEditIngredients((p) => [...p, { id: null, raw_material: ingredientSearch.trim(), qty: "", unit: "gm", qty_kg: 0 }]);
                setIngredientSearch("");
              }} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px dashed #FDE68A", background: "#FFFBEB", color: "#B45309", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                + Add "{ingredientSearch.trim()}" as new ingredient
              </button>
            </div>
          )}
        </div>

        {/* Save button */}
        <div style={{ position: "sticky", bottom: 0, padding: "12px 0", background: "linear-gradient(transparent, #FAF9F6 20%)", zIndex: 10 }}>
          <button onClick={saveIngredients} disabled={saving}
            style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: saving ? "#D0D0CC" : "#16A34A", color: "#fff", fontWeight: 800, fontSize: 16, cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {saving ? "⏳ Saving..." : `💾 Save Recipe (${editIngredients.filter((i) => i.qty > 0).length} ingredients)`}
          </button>
        </div>
      </div>
    );
  }

  // ── MAIN LIST VIEW ──
  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading recipes...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>🍳 Outlet Recipes</h3>
          <p style={{ fontSize: 12, color: "#888", margin: 0 }}>Add ingredients for each menu item (qty in grams per serving)</p>
        </div>
        <button onClick={() => setAddingItem(!addingItem)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #BBF7D0", background: "#F0FDF4", fontSize: 12, fontWeight: 700, color: "#16A34A", cursor: "pointer", fontFamily: "inherit" }}>{addingItem ? "Cancel" : "+ Add Item"}</button>
      </div>

      {/* Add new menu item */}
      {addingItem && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, padding: "10px 12px", background: "#F0FDF4", borderRadius: 10, border: "1px solid #BBF7D0", flexWrap: "wrap" }}>
          <input value={newItemName} onChange={(e) => setNewItemName(e.target.value)} placeholder="Item name (e.g., Medu Vada)"
            style={{ flex: "1 1 150px", padding: "8px 10px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit" }} />
          <select value={newItemCategory} onChange={(e) => setNewItemCategory(e.target.value)}
            style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit", background: "#fff" }}>
            {[...categories, "Dosas", "Idli And Vada", "Rice Items", "Beverages", "Desserts", "Snacks", "Combos", "Other"].filter((v, i, a) => a.indexOf(v) === i).sort().map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button onClick={addMenuItem} disabled={!newItemName.trim()} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: newItemName.trim() ? "#16A34A" : "#D0D0CC", color: "#fff", fontSize: 12, fontWeight: 700, cursor: newItemName.trim() ? "pointer" : "not-allowed", fontFamily: "inherit" }}>Add</button>
        </div>
      )}

      {/* Status filter pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setFilterStatus("all")} style={{ flex: 1, background: filterStatus === "all" ? "#1A1A1A" : "#fff", borderRadius: 10, padding: "10px 8px", border: filterStatus === "all" ? "none" : "1px solid #E8E8E4", textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 9, color: filterStatus === "all" ? "#999" : "#999", fontWeight: 600, textTransform: "uppercase" }}>All</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: filterStatus === "all" ? "#fff" : "#1A1A1A" }}>{recipes.length}</div>
        </button>
        <button onClick={() => setFilterStatus("filled")} style={{ flex: 1, background: filterStatus === "filled" ? "#16A34A" : "#F0FDF4", borderRadius: 10, padding: "10px 8px", border: filterStatus === "filled" ? "none" : "1px solid #BBF7D0", textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 9, color: filterStatus === "filled" ? "rgba(255,255,255,0.7)" : "#999", fontWeight: 600, textTransform: "uppercase" }}>Filled</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: filterStatus === "filled" ? "#fff" : "#16A34A" }}>{filledCount}</div>
        </button>
        <button onClick={() => setFilterStatus("empty")} style={{ flex: 1, background: filterStatus === "empty" ? "#DC2626" : emptyCount > 0 ? "#FEF2F2" : "#F0FDF4", borderRadius: 10, padding: "10px 8px", border: filterStatus === "empty" ? "none" : `1px solid ${emptyCount > 0 ? "#FECACA" : "#BBF7D0"}`, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 9, color: filterStatus === "empty" ? "rgba(255,255,255,0.7)" : "#999", fontWeight: 600, textTransform: "uppercase" }}>Empty</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: filterStatus === "empty" ? "#fff" : emptyCount > 0 ? "#DC2626" : "#16A34A" }}>{emptyCount}</div>
        </button>
      </div>

      {/* Search */}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search menu items..."
        style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 12, boxSizing: "border-box" }} />

      {/* Recipe list grouped by category */}
      {categories.filter((cat) => filteredRecipes.some((r) => r.category === cat)).map((cat) => {
        const catRecipes = filteredRecipes.filter((r) => r.category === cat);
        return (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#B45309", marginBottom: 6 }}>{cat} ({catRecipes.length})</div>
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", overflow: "hidden" }}>
              {catRecipes.map((r, idx) => {
                const hasFilled = r.recipe_ingredients && r.recipe_ingredients.length > 0;
                return (
                  <div key={r.id} onClick={() => openRecipe(r)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: idx < catRecipes.length - 1 ? "1px solid #F0F0EC" : "none", cursor: "pointer", background: hasFilled ? "transparent" : "#FFFDF5" }}>
                    <div style={{ width: 10, height: 10, borderRadius: 5, background: hasFilled ? "#16A34A" : "#E0E0DC", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{r.item_name}</div>
                      {hasFilled && <div style={{ fontSize: 10, color: "#16A34A" }}>{r.recipe_ingredients.length} ingredients</div>}
                      {!hasFilled && <div style={{ fontSize: 10, color: "#B45309" }}>⚠ No recipe — tap to add</div>}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); deleteMenuItem(r.id, r.item_name); }} style={{ width: 22, height: 22, borderRadius: 5, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", fontSize: 10, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>×</button>
                    <span style={{ color: "#CCC", fontSize: 12 }}>→</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {filteredRecipes.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>No items match your filter</div>}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  PETPOOJA RECIPES — from PetPooja recipe export
// ═════════════════════════════════════════════════════════════════════════════
const PetPoojaRecipes = () => {
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    api.getRecipesPetpooja().then(setRecipes).catch(() => setRecipes([])).finally(() => setLoading(false));
  }, []);

  const normUnit = (qty, unit) => {
    const u = (unit || "").toUpperCase();
    if (["GM", "G", "GMS"].includes(u)) return { qty: qty / 1000, unit: "Kg" };
    if (["LTR.", "LTR", "L"].includes(u)) return { qty, unit: "Ltr" };
    return { qty, unit };
  };

  const filtered = recipes.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.item_name.toLowerCase().includes(q) ||
      r.recipe_ingredients?.some((m) => m.raw_material.toLowerCase().includes(q));
  });

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading recipes...</div>;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>📖 PetPooja Recipes</h3>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>Item-level recipes from PetPooja export — used for RM audit</p>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <input type="text" placeholder="Search items or ingredients..." value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", fontSize: 13, fontFamily: "inherit", outline: "none" }} />
        <span style={{ fontSize: 12, color: "#888", whiteSpace: "nowrap" }}>{filtered.length} recipes</span>
      </div>
      {filtered.map((r, i) => {
        const isOpen = expanded === i;
        const food = (r.recipe_ingredients || []).filter((m) => { const n = normUnit(m.qty, m.unit); return n.unit !== "Piece" && n.unit !== "Pcs"; });
        const pack = (r.recipe_ingredients || []).filter((m) => { const n = normUnit(m.qty, m.unit); return n.unit === "Piece" || n.unit === "Pcs"; });
        return (
          <div key={i} style={{ background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", marginBottom: 8, overflow: "hidden" }}>
            <div onClick={() => setExpanded(isOpen ? null : i)} style={{ padding: "12px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{r.item_name}</span>
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, fontWeight: 700,
                  background: r.item_type === "Item" ? "#F0FDF4" : "#FFFBEB",
                  color: r.item_type === "Item" ? "#16A34A" : "#B45309" }}>{r.item_type}</span>
              </div>
              <span style={{ fontSize: 12, color: "#888" }}>{r.recipe_ingredients?.length || 0} items {isOpen ? "▲" : "▼"}</span>
            </div>
            {isOpen && (
              <div style={{ padding: "0 16px 14px", borderTop: "1px solid #F0F0EC" }}>
                <div style={{ fontSize: 11, color: "#B45309", fontWeight: 700, margin: "10px 0 6px", textTransform: "uppercase", letterSpacing: 0.5 }}>Food Ingredients</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6 }}>
                  {food.map((m, j) => {
                    const n = normUnit(m.qty, m.unit);
                    return (
                      <div key={j} style={{ background: "#FAFAF8", borderRadius: 8, padding: "6px 10px", fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                        <span>{m.raw_material}</span>
                        <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#B45309" }}>{n.qty.toFixed(3)} {n.unit}</span>
                      </div>
                    );
                  })}
                </div>
                {pack.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: "#888", fontWeight: 700, margin: "10px 0 6px", textTransform: "uppercase", letterSpacing: 0.5 }}>Packaging</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {pack.map((m, j) => (
                        <span key={j} style={{ background: "#FAFAF8", borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "#888" }}>{m.raw_material} × {m.qty}</span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  ISSUANCE AUDIT — Calculated vs Actually Issued
// ═════════════════════════════════════════════════════════════════════════════
const IssuanceAudit = () => {
  const [selDay, setSelDay] = useState(0);
  const [auditData, setAuditData] = useState([]);
  const [loading, setLoading] = useState(false);

  const dateStr = useMemo(() => {
    return istDateAgo(selDay);
  }, [selDay]);

  useEffect(() => {
    setLoading(true);
    api.getIssuanceAudit(dateStr).then(setAuditData).catch(() => setAuditData([])).finally(() => setLoading(false));
  }, [dateStr]);

  const totalCalc = auditData.reduce((s, a) => s + (a.calculated_qty || 0), 0);
  const totalIssued = auditData.reduce((s, a) => s + (a.issued_qty || 0), 0);
  const editsCount = auditData.filter((a) => a.variance !== 0 && a.source !== "manual").length;
  const manualCount = auditData.filter((a) => a.source === "manual").length;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>📊 Issuance Audit</h3>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>Calculated Requisition vs Actual Issued — track edits</p>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {Array.from({ length: 10 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - i);
          const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toISOString().split("T")[0].slice(5);
          return (<button key={i} onClick={() => setSelDay(i)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selDay === i ? 700 : 500, border: selDay === i ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selDay === i ? "#1A1A1A" : "#fff", color: selDay === i ? "#fff" : "#888", whiteSpace: "nowrap" }}>{label}</button>);
        })}
      </div>

      {/* Summary Cards */}
      {auditData.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 100px", background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Items Issued</div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{auditData.length}</div>
          </div>
          <div style={{ flex: "1 1 100px", background: editsCount > 0 ? "#FFFBEB" : "#F0FDF4", borderRadius: 12, padding: "14px 16px", border: `1px solid ${editsCount > 0 ? "#FDE68A" : "#BBF7D0"}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Edits Made</div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: editsCount > 0 ? "#B45309" : "#16A34A" }}>{editsCount}</div>
          </div>
          <div style={{ flex: "1 1 100px", background: manualCount > 0 ? "#FFF7ED" : "#fff", borderRadius: 12, padding: "14px 16px", border: `1px solid ${manualCount > 0 ? "#FED7AA" : "#E8E8E4"}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Manual Adds</div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: manualCount > 0 ? "#EA580C" : "#999" }}>{manualCount}</div>
          </div>
          <div style={{ flex: "1 1 100px", background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E8E4", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Net Variance</div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: totalIssued > totalCalc ? "#DC2626" : "#16A34A" }}>{totalIssued > totalCalc ? "+" : ""}{(totalIssued - totalCalc).toFixed(2)}</div>
          </div>
        </div>
      )}

      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading audit...</div>}

      {!loading && auditData.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "#999" }}>No issuance data for {dateStr}. Use "Smart Issue" in Inventory to track.</div>
      )}

      {!loading && auditData.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={thS}>Item</th>
                <th style={{ ...thS, textAlign: "right" }}>Calculated</th>
                <th style={{ ...thS, textAlign: "right" }}>Issued</th>
                <th style={{ ...thS, textAlign: "right" }}>Variance</th>
                <th style={{ ...thS, textAlign: "center" }}>Source</th>
                <th style={{ ...thS, textAlign: "center" }}>Status</th>
              </tr></thead>
              <tbody>
                {auditData.map((a, i) => {
                  const source = a.source || "recipe";
                  const isManual = source === "manual";
                  const isEdited = a.variance !== 0 && !isManual;
                  const isOver = a.variance > 0;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid #F0F0EC", background: isManual ? "#FFF7ED" : isEdited ? "#FFFDF5" : "transparent" }}>
                      <td style={{ ...tdS, fontWeight: 600 }}>{a.item_name}</td>
                      <td style={{ ...tdS, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#2563EB" }}>{isManual ? "—" : Number(a.calculated_qty).toFixed(2)}</td>
                      <td style={{ ...tdS, textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{Number(a.issued_qty).toFixed(2)}</td>
                      <td style={{ ...tdS, textAlign: "right", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: isManual ? "#EA580C" : !isEdited ? "#999" : isOver ? "#DC2626" : "#16A34A" }}>
                        {isManual ? "manual" : isEdited ? `${isOver ? "+" : ""}${Number(a.variance).toFixed(2)}` : "—"}
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, background: isManual ? "#FFF7ED" : isEdited ? "#FFFBEB" : "#F0FDF4", color: isManual ? "#EA580C" : isEdited ? "#B45309" : "#16A34A" }}>
                          {isManual ? "Manual" : isEdited ? "Edited" : "Recipe"}
                        </span>
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        {isManual ? (
                          <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: "#FFF7ED", color: "#EA580C" }}>➕ Added</span>
                        ) : isEdited ? (
                          <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: isOver ? "#FEF2F2" : "#F0FDF4", color: isOver ? "#DC2626" : "#16A34A" }}>
                            {isOver ? "⬆ Over" : "⬇ Under"}
                          </span>
                        ) : (
                          <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: "#F0FDF4", color: "#16A34A" }}>✓ Match</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  MONTHLY INVENTORY VIEW — Daily stock movements grid
// ═════════════════════════════════════════════════════════════════════════════
const MonthlyInventory = () => {
  const [items, setItems] = useState([]);
  const [movements, setMovements] = useState({});
  const [loading, setLoading] = useState(true);
  const [selMonth, setSelMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  const [viewType, setViewType] = useState("all"); // all, out, in
  const [selCat, setSelCat] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.getInventory().then(async (inv) => {
      setItems(inv || []);
      // Fetch movements for all items
      const movMap = {};
      const promises = (inv || []).map((item) =>
        api.getMovements(item.id).then((mov) => { movMap[item.id] = mov || []; }).catch(() => { movMap[item.id] = []; })
      );
      await Promise.all(promises);
      setMovements(movMap);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const year = parseInt(selMonth.split("-")[0]);
  const month = parseInt(selMonth.split("-")[1]);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dayNums = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const todayDay = new Date().getDate();
  const isCurrentMonth = selMonth === `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  // Build grid from movements — track in and out separately
  const grid = {};
  const monthlyTotals = {};
  items.forEach((item) => {
    grid[item.id] = {};
    monthlyTotals[item.id] = { in: 0, out: 0 };
    dayNums.forEach((d) => { grid[item.id][d] = { in: 0, out: 0 }; });
    (movements[item.id] || []).forEach((m) => {
      const d = new Date(m.created_at);
      const day = d.getDate();
      const mMonth = d.getMonth() + 1;
      const mYear = d.getFullYear();
      if (mMonth !== month || mYear !== year) return;
      const qty = Math.abs(m.quantity);
      if (m.type === "stock_out") { grid[item.id][day].out += qty; monthlyTotals[item.id].out += qty; }
      if (m.type === "stock_in") { grid[item.id][day].in += qty; monthlyTotals[item.id].in += qty; }
    });
  });

  const getVal = (item, day) => {
    const g = grid[item.id]?.[day];
    if (!g) return { display: "", color: "#EEE" };
    if (viewType === "out") return { display: g.out || "", color: "#DC2626" };
    if (viewType === "in") return { display: g.in || "", color: "#16A34A" };
    // "all" view — show both
    if (g.in > 0 && g.out > 0) return { display: `+${g.in}/-${g.out}`, color: "#B45309" };
    if (g.in > 0) return { display: `+${g.in}`, color: "#16A34A" };
    if (g.out > 0) return { display: `-${g.out}`, color: "#DC2626" };
    return { display: "", color: "#EEE" };
  };

  const getMthTotal = (item) => {
    const t = monthlyTotals[item.id];
    if (viewType === "out") return t.out;
    if (viewType === "in") return t.in;
    return t.in + t.out; // all
  };

  const categories = [...new Set(items.map((i) => i.category))].sort();
  const filteredItems = selCat ? items.filter((i) => i.category === selCat) : items;

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>📊 Monthly Inventory</h3>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input type="month" value={selMonth} onChange={(e) => setSelMonth(e.target.value)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11, fontFamily: "inherit" }} />
          <ExportBtn onClick={() => {
            const headers = ["Item", "Category", "Unit", "In Total", "Out Total", ...dayNums.flatMap((d) => [`${d} In`, `${d} Out`])];
            const rows = filteredItems.map((item) => [item.name, item.category, item.unit, monthlyTotals[item.id].in, monthlyTotals[item.id].out, ...dayNums.flatMap((d) => [grid[item.id]?.[d]?.in || 0, grid[item.id]?.[d]?.out || 0])]);
            exportCSV(headers, rows, `inventory_${viewType}_${selMonth}.csv`);
          }} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        <button onClick={() => setViewType("all")} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: viewType === "all" ? 700 : 500, border: viewType === "all" ? "1px solid #FDE68A" : "1px solid #E0E0DC", background: viewType === "all" ? "#FFFBEB" : "#fff", color: viewType === "all" ? "#B45309" : "#888", cursor: "pointer", fontFamily: "inherit" }}>All</button>
        <button onClick={() => setViewType("out")} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: viewType === "out" ? 700 : 500, border: viewType === "out" ? "1px solid #FECACA" : "1px solid #E0E0DC", background: viewType === "out" ? "#FEF2F2" : "#fff", color: viewType === "out" ? "#DC2626" : "#888", cursor: "pointer", fontFamily: "inherit" }}>📤 Out</button>
        <button onClick={() => setViewType("in")} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: viewType === "in" ? 700 : 500, border: viewType === "in" ? "1px solid #BBF7D0" : "1px solid #E0E0DC", background: viewType === "in" ? "#F0FDF4" : "#fff", color: viewType === "in" ? "#16A34A" : "#888", cursor: "pointer", fontFamily: "inherit" }}>📥 In</button>
        <div style={{ flex: 1 }} />
        {categories.map((c) => (
          <button key={c} onClick={() => setSelCat(selCat === c ? null : c)} style={{ padding: "6px 10px", borderRadius: 6, fontSize: 10, fontWeight: selCat === c ? 700 : 500, border: selCat === c ? "1px solid #FDE68A" : "1px solid #E0E0DC", background: selCat === c ? "#FFFBEB" : "#fff", color: selCat === c ? "#B45309" : "#888", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{c}</button>
        ))}
      </div>
      {filteredItems.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "#999" }}>No inventory items</div>
      ) : (
        <div style={{ overflowX: "auto", background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: "100%" }}>
            <thead>
              <tr style={{ background: "#FAFAF8" }}>
                <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#666", borderBottom: "2px solid #E0E0DC", position: "sticky", left: 0, background: "#FAFAF8", zIndex: 2, minWidth: 120 }}>Item</th>
                <th style={{ padding: "8px 6px", textAlign: "center", fontSize: 9, fontWeight: 700, color: "#B45309", borderBottom: "2px solid #E0E0DC", minWidth: 40 }}>MTH</th>
                {dayNums.map((d) => (
                  <th key={d} style={{ padding: "8px 4px", textAlign: "center", fontSize: 9, fontWeight: isCurrentMonth && d === todayDay ? 800 : 600, color: isCurrentMonth && d === todayDay ? "#1A1A1A" : "#999", borderBottom: "2px solid #E0E0DC", minWidth: 28, background: isCurrentMonth && d === todayDay ? "#FFFBEB" : "#FAFAF8" }}>{d}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredItems.filter((item) => monthlyTotals[item.id] > 0 || true).map((item, idx) => (
                <tr key={item.id} style={{ borderBottom: "1px solid #F0F0EC" }}>
                  <td style={{ padding: "6px 10px", fontWeight: 600, fontSize: 11, position: "sticky", left: 0, background: "#fff", zIndex: 1, whiteSpace: "nowrap" }}>
                    {item.name}
                    <span style={{ fontSize: 9, color: "#BBB", marginLeft: 4 }}>{item.unit}</span>
                  </td>
                  <td style={{ padding: "6px 4px", textAlign: "center", fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: getMthTotal(item) > 0 ? "#B45309" : "#EEE", fontSize: 11 }}>{getMthTotal(item) || "—"}</td>
                  {dayNums.map((d) => {
                    const v = getVal(item, d);
                    return (<td key={d} style={{ padding: "6px 3px", textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: v.display ? v.color : "#EEE", fontWeight: v.display ? 600 : 400, background: isCurrentMonth && d === todayDay ? "#FFFDF5" : "transparent", whiteSpace: "nowrap" }}>{v.display || ""}</td>);
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  MASTER DATA — Central item & recipe management
// ═════════════════════════════════════════════════════════════════════════════
// Standard units for master data forms (dropdown options)
const UNITS = ["Kg", "Gm", "Ltr", "Ml", "Pcs", "Pkt", "Batch", "Tin", "Box", "Bundle", "Can", "Roll", "Bunch", "Bag", "Dozen"];

const MasterData = () => {
  const [tab, setTab] = useState("demand"); // demand, raw, recipes, inventory
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState(null);
  const [editUnit, setEditUnit] = useState("");
  const [invItems, setInvItems] = useState([]);

  useEffect(() => { api.getInventory().then((d) => setInvItems(d || [])).catch(() => {}); }, []);

  const [addingTo, setAddingTo] = useState(null);
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("Kg");
  const [, forceUpdate] = useState(0);
  const refresh = () => forceUpdate((n) => n + 1);

  const reloadMaster = async () => {
    try {
      const [sections, rawMats, recipes] = await Promise.all([
        api.getMasterSections(), api.getMasterRawMaterials(), api.getMasterRecipes()
      ]);
      if (sections) { DEMAND_SECTIONS.length = 0; sections.forEach((sec) => DEMAND_SECTIONS.push({ id: sec.id, titleHi: sec.title, emoji: sec.emoji || "", color: sec.color || "#1A1A1A", bg: sec.bg || "#fff", border: sec.border || "#E0E0DC", items: (sec.items || []).map((i) => ({ id: i.id, name: i.name, unit: i.unit })) })); }
      if (rawMats) { RAW_MATERIALS.length = 0; rawMats.forEach((r) => RAW_MATERIALS.push({ id: r.id, name: r.name, unit: r.unit, inv_id: r.inventory_item_id })); }
      if (recipes) { Object.keys(RECIPES).forEach((k) => delete RECIPES[k]); Object.assign(RECIPES, recipes); }
      refresh();
    } catch (e) { console.error("Reload failed:", e); }
  };

  const addItem = async (sectionId) => {
    if (!newName.trim()) return;
    const id = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    try {
      await api.addDemandItem({ id, section_id: sectionId, name: newName.trim(), unit: newUnit });
      setNewName(""); setNewUnit("Kg"); setAddingTo(null);
      await reloadMaster();
    } catch (e) { alert("Error: " + e.message); }
  };

  const deleteItem = async (sectionId, itemId) => {
    if (!confirm(`Delete "${itemId}" from ${sectionId}?`)) return;
    try {
      await api.deleteDemandItem(itemId);
      await reloadMaster();
    } catch (e) { alert("Error: " + e.message); }
  };

  const addRawMaterial = async () => {
    if (!newName.trim()) return;
    const id = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    try {
      await api.addRawMaterial({ id, name: newName.trim(), unit: newUnit });
      setNewName(""); setNewUnit("Kg"); setAddingTo(null);
      await reloadMaster();
    } catch (e) { alert("Error: " + e.message); }
  };

  const deleteRawMaterial = async (rawId) => {
    if (!confirm(`Delete raw material "${rawId}"?`)) return;
    try {
      await api.deleteRawMaterial(rawId);
      await reloadMaster();
    } catch (e) { alert("Error: " + e.message); }
  };
  const allDemandItems = DEMAND_SECTIONS.flatMap((sec) => sec.items.map((i) => ({ ...i, section: sec.id, sectionName: sec.titleHi, emoji: sec.emoji })));
  const directSections = DEMAND_SECTIONS.filter((s) => s.id !== "food");
  const foodItems = DEMAND_SECTIONS.find((s) => s.id === "food")?.items || [];

  const thS = { padding: "8px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#666", borderBottom: "2px solid #E0E0DC", whiteSpace: "nowrap" };
  const tdS = { padding: "7px 10px", fontSize: 12, borderBottom: "1px solid #F0F0EC" };

  const saveUnit = async (itemId, section) => {
    try {
      await api.updateDemandItem(itemId, { unit: editUnit });
      await reloadMaster();
    } catch (e) { alert("Error: " + e.message); }
    setEditId(null);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>🗂️ Master Data</h3>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 5, marginBottom: 12, overflowX: "auto" }}>
        {[{ id: "demand", label: "📋 Demand Items", c: "#B45309" }, { id: "raw", label: "🧪 Raw Materials", c: "#2563EB" }, { id: "recipes", label: "📖 Recipes", c: "#16A34A" }, { id: "conversions", label: "🔄 Conversions", c: "#EA580C" }, { id: "inventory", label: "📦 Inventory SKUs", c: "#9333EA" }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: tab === t.id ? 700 : 500, border: tab === t.id ? "none" : "1px solid #E0E0DC", background: tab === t.id ? t.c : "#fff", color: tab === t.id ? "#fff" : "#888", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{t.label}</button>
        ))}
      </div>

      {/* Search */}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items..." style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 12, boxSizing: "border-box" }} />

      {/* ── DEMAND ITEMS TAB ── */}
      {tab === "demand" && (
        <div>
          <p style={{ fontSize: 11, color: "#888", margin: "0 0 10px" }}>All items outlets can demand. Food → Kitchen. Others → Direct to outlets.</p>
          {DEMAND_SECTIONS.map((sec) => {
            const secItems = sec.items.filter((i) => !search || i.name.toLowerCase().includes(search.toLowerCase()));
            if (secItems.length === 0 && search) return null;
            return (
              <div key={sec.id} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: sec.color }}>{sec.emoji} {sec.titleHi} ({sec.items.length})</span>
                  <button onClick={() => { setAddingTo(addingTo === sec.id ? null : sec.id); setNewName(""); setNewUnit("Kg"); }} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{addingTo === sec.id ? "Cancel" : "+ Add"}</button>
                </div>
                {addingTo === sec.id && (
                  <div style={{ display: "flex", gap: 6, marginBottom: 8, padding: "8px 10px", background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0" }}>
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Item name" style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
                    <select value={newUnit} onChange={(e) => setNewUnit(e.target.value)} style={{ width: 75, padding: "6px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit", background: "#fff", cursor: "pointer" }}>
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <button onClick={() => addItem(sec.id)} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Add</button>
                  </div>
                )}
                <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>#</th><th style={thS}>Name</th><th style={thS}>Unit</th><th style={thS}>Type</th><th style={{ ...thS, width: 30 }}></th></tr></thead>
                    <tbody>{secItems.map((item, idx) => (
                      <tr key={item.id}>
                        <td style={{ ...tdS, color: "#BBB", fontSize: 10 }}>{idx + 1}</td>
                        <td style={{ ...tdS, fontWeight: 600 }}>{item.name}<span style={{ fontSize: 9, color: "#CCC", marginLeft: 6 }}>{item.id}</span></td>
                        <td style={tdS}>{editId === `${sec.id}_${item.id}` ? (
                          <div style={{ display: "flex", gap: 3 }}>
                            <select value={editUnit} onChange={(e) => setEditUnit(e.target.value)} style={{ width: 70, padding: "2px 4px", borderRadius: 4, border: "1px solid #B45309", fontSize: 11, fontFamily: "inherit", background: "#fff" }}>
                              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                            </select>
                            <button onClick={() => saveUnit(item.id, sec.id)} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, cursor: "pointer" }}>✓</button>
                          </div>
                        ) : (
                          <span onClick={() => { setEditId(`${sec.id}_${item.id}`); setEditUnit(item.unit); }} style={{ cursor: "pointer", padding: "2px 6px", borderRadius: 4, background: "#F5F5F3", fontSize: 11, fontWeight: 600 }}>{item.unit} ✏️</span>
                        )}</td>
                        <td style={{ ...tdS, fontSize: 10 }}>{sec.id === "food" ? <span style={{ color: "#B45309" }}>🏭 Kitchen</span> : <span style={{ color: "#2563EB" }}>🏪 Direct</span>}</td>
                        <td style={tdS}><button onClick={() => deleteItem(sec.id, item.id)} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#DC2626", fontSize: 12, cursor: "pointer" }}>🗑️</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── RAW MATERIALS TAB ── */}
      {tab === "raw" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <p style={{ fontSize: 11, color: "#888", margin: 0 }}>{RAW_MATERIALS.length} raw materials used in BK recipes.</p>
            <button onClick={() => { setAddingTo(addingTo === "raw" ? null : "raw"); setNewName(""); setNewUnit("Kg"); }} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{addingTo === "raw" ? "Cancel" : "+ Add"}</button>
          </div>
          {addingTo === "raw" && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, padding: "8px 10px", background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0" }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Material name" style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
              <select value={newUnit} onChange={(e) => setNewUnit(e.target.value)} style={{ width: 75, padding: "6px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit", background: "#fff", cursor: "pointer" }}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <button onClick={addRawMaterial} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Add</button>
            </div>
          )}
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>#</th><th style={thS}>Name</th><th style={thS}>Unit</th><th style={thS}>Used In</th><th style={{ ...thS, width: 30 }}></th></tr></thead>
              <tbody>{RAW_MATERIALS.filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase())).map((raw, idx) => {
                const usedIn = Object.entries(RECIPES).filter(([, rec]) => rec.ingredients.some((ing) => ing.rawId === raw.id)).map(([, rec]) => rec.name);
                return (
                  <tr key={raw.id}>
                    <td style={{ ...tdS, color: "#BBB", fontSize: 10 }}>{idx + 1}</td>
                    <td style={{ ...tdS, fontWeight: 600 }}>{raw.name}<span style={{ fontSize: 9, color: "#CCC", marginLeft: 6 }}>{raw.id}</span></td>
                    <td style={tdS}>{editId === `raw_${raw.id}` ? (
                      <div style={{ display: "flex", gap: 3 }}>
                        <select value={editUnit} onChange={(e) => setEditUnit(e.target.value)} style={{ width: 70, padding: "2px 4px", borderRadius: 4, border: "1px solid #B45309", fontSize: 11, background: "#fff" }}>
                          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <button onClick={async () => { try { await api.updateRawMaterial(raw.id, { unit: editUnit }); await reloadMaster(); } catch(e) { alert(e.message); } setEditId(null); }} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, cursor: "pointer" }}>✓</button>
                      </div>
                    ) : (
                      <span onClick={() => { setEditId(`raw_${raw.id}`); setEditUnit(raw.unit); }} style={{ cursor: "pointer", padding: "2px 6px", borderRadius: 4, background: "#F5F5F3", fontSize: 11, fontWeight: 600 }}>{raw.unit} ✏️</span>
                    )}</td>
                    <td style={{ ...tdS, fontSize: 10, color: "#888", maxWidth: 150 }}>{usedIn.length > 0 ? usedIn.join(", ") : <span style={{ color: "#DDD" }}>—</span>}</td>
                    <td style={tdS}><button onClick={() => deleteRawMaterial(raw.id)} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#DC2626", fontSize: 12, cursor: "pointer" }}>🗑️</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── RECIPES TAB ── */}
      {tab === "recipes" && (
        <div>
          <p style={{ fontSize: 11, color: "#888", margin: "0 0 10px" }}>{Object.keys(RECIPES).length} recipes. Tap qty to edit. Changes save to DB.</p>
          {Object.entries(RECIPES).filter(([, r]) => !search || r.name.toLowerCase().includes(search.toLowerCase())).map(([id, recipe]) => {
            const demandItem = foodItems.find((i) => i.id === id);
            const isAdding = addingTo === `recipe_${id}`;
            return (
              <div key={id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", marginBottom: 10, overflow: "hidden" }}>
                <div style={{ padding: "8px 12px", borderBottom: "1px solid #F0F0EC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{recipe.name}</span>
                    <span style={{ fontSize: 10, color: "#888", marginLeft: 6 }}>{demandItem?.unit || "?"}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "#16A34A", fontWeight: 600 }}>Yield: {recipe.yield}</span>
                    <button onClick={() => setAddingTo(isAdding ? null : `recipe_${id}`)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>{isAdding ? "×" : "+"}</button>
                  </div>
                </div>
                {/* Add ingredient form */}
                {isAdding && (
                  <div style={{ padding: "6px 10px", background: "#F0FDF4", borderBottom: "1px solid #BBF7D0", display: "flex", gap: 4, flexWrap: "wrap", position: "relative" }}>
                    <div style={{ position: "relative", flex: 2, minWidth: 100 }}>
                      <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Type raw material..." style={{ width: "100%", padding: "5px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11, fontFamily: "inherit", boxSizing: "border-box" }} />
                      {newName.length > 1 && (
                        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #E0E0DC", borderRadius: 6, maxHeight: 120, overflowY: "auto", zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                          {RAW_MATERIALS.filter((r) => r.name.toLowerCase().includes(newName.toLowerCase()) && !recipe.ingredients.find((i) => i.rawId === r.id)).slice(0, 6).map((r) => (
                            <button key={r.id} onClick={() => { setNewName(r.name); setEditUnit(r.id); setNewUnit(r.unit); }} style={{ width: "100%", padding: "6px 10px", border: "none", background: editUnit === r.id ? "#F0FDF4" : "#fff", textAlign: "left", fontSize: 11, cursor: "pointer", fontFamily: "inherit", borderBottom: "1px solid #F5F5F3" }}>{r.name} <span style={{ color: "#999", fontSize: 9 }}>({r.unit})</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                    <input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="Qty" type="number" step="0.001" style={{ width: 50, padding: "5px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11, textAlign: "center" }} />
                    <button onClick={async () => {
                      if (!editUnit || !newUnit) return;
                      const newIngs = [...recipe.ingredients, { rawId: editUnit, qty: Number(newUnit) }];
                      try {
                        await api.saveRecipe({ id, name: recipe.name, yield_qty: recipe.yieldQty, yield_unit: "Kg", yield_label: recipe.yield, ingredients: newIngs });
                        const recipes = await api.getMasterRecipes(); if (recipes) { Object.keys(RECIPES).forEach((k) => delete RECIPES[k]); Object.assign(RECIPES, recipes); }
                        setNewName(""); setNewUnit(""); setEditUnit(""); setAddingTo(null); refresh();
                      } catch (e) { alert(e.message); }
                    }} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Add</button>
                  </div>
                )}
                {recipe.ingredients.map((ing) => {
                  const raw = RAW_MATERIALS.find((r) => r.id === ing.rawId);
                  const isEditingQty = editId === `rq_${id}_${ing.rawId}`;
                  return (
                    <div key={ing.rawId} style={{ display: "flex", alignItems: "center", padding: "6px 12px", borderBottom: "1px solid #F5F5F3", gap: 6 }}>
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{raw?.name || ing.rawId}</span>
                      {isEditingQty ? (
                        <div style={{ display: "flex", gap: 3 }}>
                          <input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} type="number" step="0.001" style={{ width: 55, padding: "3px 4px", borderRadius: 4, border: "1px solid #B45309", fontSize: 12, textAlign: "center", fontFamily: "'JetBrains Mono'" }} />
                          <button onClick={async () => {
                            const newIngs = recipe.ingredients.map((i) => i.rawId === ing.rawId ? { ...i, qty: Number(editUnit) } : i);
                            try {
                              await api.saveRecipe({ id, name: recipe.name, yield_qty: recipe.yieldQty, yield_unit: "Kg", yield_label: recipe.yield, ingredients: newIngs });
                              const recipes = await api.getMasterRecipes(); if (recipes) { Object.keys(RECIPES).forEach((k) => delete RECIPES[k]); Object.assign(RECIPES, recipes); }
                              setEditId(null); refresh();
                            } catch (e) { alert(e.message); }
                          }} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, cursor: "pointer" }}>✓</button>
                        </div>
                      ) : (
                        <span onClick={() => { setEditId(`rq_${id}_${ing.rawId}`); setEditUnit(String(ing.qty)); }} style={{ cursor: "pointer", padding: "2px 8px", borderRadius: 4, background: "#FFFBEB", fontSize: 12, fontFamily: "'JetBrains Mono'", fontWeight: 700, color: "#B45309" }}>{ing.qty} ✏️</span>
                      )}
                      <span style={{ fontSize: 10, color: "#999", width: 24 }}>{raw?.unit || "Kg"}</span>
                      <button onClick={async () => {
                        if (!confirm(`Remove ${raw?.name || ing.rawId}?`)) return;
                        const newIngs = recipe.ingredients.filter((i) => i.rawId !== ing.rawId);
                        try {
                          await api.saveRecipe({ id, name: recipe.name, yield_qty: recipe.yieldQty, yield_unit: "Kg", yield_label: recipe.yield, ingredients: newIngs });
                          const recipes = await api.getMasterRecipes(); if (recipes) { Object.keys(RECIPES).forEach((k) => delete RECIPES[k]); Object.assign(RECIPES, recipes); }
                          refresh();
                        } catch (e) { alert(e.message); }
                      }} style={{ padding: "1px 4px", border: "none", background: "transparent", color: "#DC2626", fontSize: 11, cursor: "pointer" }}>🗑️</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* ── CONVERSIONS TAB ── */}
      {tab === "conversions" && (
        <div>
          <p style={{ fontSize: 11, color: "#888", margin: "0 0 12px" }}>Define what 1 custom unit equals in base units. Saved to database.</p>
          {Object.entries(UNIT_CONVERSIONS).map(([unitName, items]) => (
            <div key={unitName} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#EA580C" }}>🔄 {unitName} ({items.length} items)</span>
                <button onClick={() => { setAddingTo(addingTo === `conv_${unitName}` ? null : `conv_${unitName}`); setNewName(""); setNewUnit(""); setEditUnit(""); }} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{addingTo === `conv_${unitName}` ? "Cancel" : "+ Add"}</button>
              </div>
              {addingTo === `conv_${unitName}` && (
                <div style={{ display: "flex", gap: 6, marginBottom: 8, padding: "8px 10px", background: "#FFF7ED", borderRadius: 8, border: "1px solid #FED7AA", flexWrap: "wrap" }}>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Item name" style={{ flex: 1, minWidth: 100, padding: "6px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
                  <input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="Qty" type="number" style={{ width: 50, padding: "6px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, textAlign: "center" }} />
                  <input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} placeholder="Base unit" style={{ width: 60, padding: "6px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, textAlign: "center" }} />
                  <button onClick={async () => {
                    if (!newName.trim() || !newUnit) return;
                    const id = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
                    try {
                      await api.addConversion({ unit_type: unitName, item_id: id, item_name: newName.trim(), qty: Number(newUnit), base_unit: editUnit || "Gm" });
                      const conv = await api.getConversions(); if (conv) { Object.keys(UNIT_CONVERSIONS).forEach((k) => delete UNIT_CONVERSIONS[k]); Object.assign(UNIT_CONVERSIONS, conv); }
                      setNewName(""); setNewUnit(""); setEditUnit(""); setAddingTo(null); refresh();
                    } catch (e) { alert("Error: " + e.message); }
                  }} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Add</button>
                </div>
              )}
              <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr style={{ background: "#FAFAF8" }}>
                    <th style={thS}>Item</th>
                    <th style={{ ...thS, textAlign: "center" }}>1 {unitName} =</th>
                    <th style={{ ...thS, textAlign: "center" }}>Base Unit</th>
                    <th style={{ ...thS, width: 30 }}></th>
                  </tr></thead>
                  <tbody>{items.filter((i) => !search || i.item_name.toLowerCase().includes(search.toLowerCase())).map((item) => (
                    <tr key={item.item_id}>
                      <td style={{ ...tdS, fontWeight: 600 }}>{item.item_name}<span style={{ fontSize: 9, color: "#CCC", marginLeft: 6 }}>{item.item_id}</span></td>
                      <td style={tdS}>{editId === `conv_${unitName}_${item.item_id}` ? (
                        <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
                          <input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} type="number" style={{ width: 50, padding: "2px 4px", borderRadius: 4, border: "1px solid #B45309", fontSize: 12, textAlign: "center" }} />
                          <button onClick={async () => {
                            try {
                              await api.updateConversion({ unit_type: unitName, item_id: item.item_id, qty: Number(editUnit), notes: `1 ${unitName} = ${editUnit} ${item.base_unit}` });
                              // If this is a Batch conversion, also update the recipe yield
                              if (unitName === "Batch" && RECIPES[item.item_id]) {
                                const newYield = Number(editUnit);
                                const oldYield = RECIPES[item.item_id].yieldQty;
                                const ratio = newYield / oldYield;
                                // Scale all ingredient quantities proportionally
                                const newIngredients = RECIPES[item.item_id].ingredients.map((ing) => ({ rawId: ing.rawId, qty: Math.round(ing.qty * ratio * 10000) / 10000 }));
                                await api.saveRecipe({ id: item.item_id, name: RECIPES[item.item_id].name, yield_qty: newYield, yield_unit: "Kg", yield_label: `${newYield} Kg (1 Batch)`, ingredients: newIngredients });
                                // Reload recipes
                                const recipes = await api.getMasterRecipes().catch(() => null);
                                if (recipes) { Object.keys(RECIPES).forEach((k) => delete RECIPES[k]); Object.assign(RECIPES, recipes); }
                              }
                              const conv = await api.getConversions(); if (conv) { Object.keys(UNIT_CONVERSIONS).forEach((k) => delete UNIT_CONVERSIONS[k]); Object.assign(UNIT_CONVERSIONS, conv); }
                              setEditId(null); refresh();
                            } catch (e) { alert("Error: " + e.message); }
                          }} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, cursor: "pointer" }}>✓</button>
                        </div>
                      ) : (
                        <span onClick={() => { setEditId(`conv_${unitName}_${item.item_id}`); setEditUnit(String(item.qty)); }} style={{ cursor: "pointer", padding: "3px 10px", borderRadius: 6, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 14, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#B45309", display: "inline-block", textAlign: "center" }}>{item.qty} ✏️</span>
                      )}</td>
                      <td style={{ ...tdS, textAlign: "center", color: "#888", fontSize: 12 }}>{item.base_unit}</td>
                      <td style={tdS}><button onClick={async () => {
                        if (!confirm(`Remove ${item.item_name}?`)) return;
                        try {
                          await api.deleteConversion(unitName, item.item_id);
                          const conv = await api.getConversions(); if (conv) { Object.keys(UNIT_CONVERSIONS).forEach((k) => delete UNIT_CONVERSIONS[k]); Object.assign(UNIT_CONVERSIONS, conv); }
                          refresh();
                        } catch (e) { alert("Error: " + e.message); }
                      }} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#DC2626", fontSize: 12, cursor: "pointer" }}>🗑️</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          ))}
          {/* Add new unit type */}
          <div style={{ marginTop: 16, padding: "12px 14px", background: "#F5F5F3", borderRadius: 10, border: "1px solid #E0E0DC" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 6 }}>Add new unit type</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={addingTo === "new_unit_type" ? newName : ""} onChange={(e) => { setAddingTo("new_unit_type"); setNewName(e.target.value); }} placeholder="e.g. Can, Bottle" style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
              <button onClick={() => { if (!newName.trim()) return; if (UNIT_CONVERSIONS[newName.trim()]) { alert("Already exists"); return; } UNIT_CONVERSIONS[newName.trim()] = []; setNewName(""); setAddingTo(null); refresh(); }} style={{ padding: "8px 14px", borderRadius: 6, border: "none", background: "#EA580C", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+ Add Unit</button>
            </div>
          </div>
        </div>
      )}

      {/* ── INVENTORY SKUs TAB ── */}
      {tab === "inventory" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <p style={{ fontSize: 11, color: "#888", margin: 0 }}>{invItems.length} items in inventory.</p>
            <div style={{ display: "flex", gap: 5 }}>
              <button onClick={() => api.getInventory().then((d) => setInvItems(d || []))} style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid #E0E0DC", background: "#fff", fontSize: 10, cursor: "pointer" }}>🔄</button>
              <button onClick={() => setAddingTo(addingTo === "inv" ? null : "inv")} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{addingTo === "inv" ? "Cancel" : "+ Add"}</button>
            </div>
          </div>
          {addingTo === "inv" && (
            <div style={{ display: "flex", gap: 4, marginBottom: 8, padding: "8px", background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0", flexWrap: "wrap" }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" style={{ flex: 2, minWidth: 80, padding: "5px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11, fontFamily: "inherit" }} />
              <select value={editUnit || "Store"} onChange={(e) => setEditUnit(e.target.value)} style={{ padding: "5px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11 }}>
                <option>Store</option><option>Food</option><option>Cleaning</option><option>Packaging</option>
              </select>
              <select value={newUnit || "Kg"} onChange={(e) => setNewUnit(e.target.value)} style={{ width: 65, padding: "5px 4px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 11, background: "#fff", cursor: "pointer" }}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <button onClick={async () => {
                if (!newName.trim()) return;
                const id = (editUnit || "store").toLowerCase().replace(/[^a-z]/g,"") + "_" + newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
                try {
                  await api.addInventoryItem({ id, name: newName.trim(), category: editUnit || "Store", unit: newUnit || "Kg", threshold: 0 });
                  const d = await api.getInventory(); setInvItems(d || []);
                  setNewName(""); setNewUnit("Kg"); setEditUnit(""); setAddingTo(null);
                } catch (e) { alert("Error: " + e.message); }
              }} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Add</button>
            </div>
          )}
          <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E8E8E4", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ background: "#FAFAF8" }}><th style={thS}>#</th><th style={thS}>Name</th><th style={thS}>Category</th><th style={thS}>Unit</th><th style={thS}>Stock</th><th style={{ ...thS, width: 30 }}></th></tr></thead>
              <tbody>{invItems.filter((i) => !search || i.name.toLowerCase().includes(search.toLowerCase())).map((item, idx) => (
                <tr key={item.id}>
                  <td style={{ ...tdS, color: "#BBB", fontSize: 10 }}>{idx + 1}</td>
                  <td style={{ ...tdS, fontWeight: 600 }}>{editId === `inv_name_${item.id}` ? (
                    <div style={{ display: "flex", gap: 3 }}>
                      <input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} style={{ flex: 1, padding: "3px 6px", borderRadius: 4, border: "1px solid #B45309", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }} />
                      <button onClick={async () => {
                        try { await api.updateInventoryItem(item.id, { name: editUnit }); const d = await api.getInventory(); setInvItems(d || []); setEditId(null); } catch (e) { alert(e.message); }
                      }} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, cursor: "pointer" }}>✓</button>
                    </div>
                  ) : (
                    <span onClick={() => { setEditId(`inv_name_${item.id}`); setEditUnit(item.name); }} style={{ cursor: "pointer" }}>{item.name} <span style={{ fontSize: 8, color: "#CCC" }}>{item.id}</span></span>
                  )}</td>
                  <td style={{ ...tdS, fontSize: 10, color: "#888" }}>{item.category}</td>
                  <td style={{ ...tdS, fontWeight: 600 }}>{item.unit}</td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono'", fontWeight: 700, color: Number(item.current_qty) === 0 ? "#DC2626" : "#16A34A" }}>{item.current_qty}</td>
                  <td style={tdS}><button onClick={async () => {
                    if (!confirm(`Delete "${item.name}"? This will remove all movement history.`)) return;
                    try { await api.deleteInventoryItem(item.id); const d = await api.getInventory(); setInvItems(d || []); } catch (e) { alert("Error: " + e.message); }
                  }} style={{ padding: "2px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#DC2626", fontSize: 12, cursor: "pointer" }}>🗑️</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  RATE CARD — Edit item prices
// ═════════════════════════════════════════════════════════════════════════════
const RateCardPanel = () => {
  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selCat, setSelCat] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editPrice, setEditPrice] = useState("");

  const load = () => { setLoading(true); api.getRateCard().then(setRates).catch(() => setRates([])).finally(() => setLoading(false)); };
  useEffect(load, []);

  const categories = [...new Set(rates.map((r) => r.category))].sort();
  const filtered = rates.filter((r) => {
    if (selCat && r.category !== selCat) return false;
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const savePrice = async (id) => {
    try {
      await api.updateRate(id, { price: Number(editPrice) || 0 });
      setEditId(null);
      load();
    } catch (e) { alert("Error: " + e.message); }
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>💰 Rate Card</h3>
        <p style={{ fontSize: 12, color: "#888", margin: 0 }}>Item prices used for P&L variable cost calculation. {rates.length} items.</p>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items..." style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 12, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4 }}>
        <button onClick={() => setSelCat(null)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: !selCat ? 700 : 500, border: !selCat ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selCat ? "#1A1A1A" : "#fff", color: !selCat ? "#fff" : "#888", whiteSpace: "nowrap" }}>All ({rates.length})</button>
        {categories.map((c) => {
          const cnt = rates.filter((r) => r.category === c).length;
          return <button key={c} onClick={() => setSelCat(c)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: selCat === c ? 700 : 500, border: selCat === c ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selCat === c ? "#1A1A1A" : "#fff", color: selCat === c ? "#fff" : "#888", whiteSpace: "nowrap" }}>{c} ({cnt})</button>;
        })}
      </div>
      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>}
      {!loading && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr style={{ background: "#FAFAF8" }}>
                <th style={thS}>Item</th>
                <th style={{ ...thS, textAlign: "center" }}>Category</th>
                <th style={{ ...thS, textAlign: "center" }}>Unit</th>
                <th style={{ ...thS, textAlign: "right" }}>Price (₹)</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #F0F0EC" }}>
                    <td style={{ ...tdS, fontWeight: 600 }}>{r.name}<span style={{ fontSize: 9, color: "#CCC", marginLeft: 6 }}>{r.id}</span></td>
                    <td style={{ ...tdS, textAlign: "center", fontSize: 11, color: "#888" }}>{r.category}</td>
                    <td style={{ ...tdS, textAlign: "center", fontSize: 11, color: "#888" }}>{r.unit}</td>
                    <td style={{ ...tdS, textAlign: "right" }}>
                      {editId === r.id ? (
                        <div style={{ display: "flex", gap: 3, justifyContent: "flex-end" }}>
                          <input type="number" autoFocus value={editPrice} onChange={(e) => setEditPrice(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") savePrice(r.id); if (e.key === "Escape") setEditId(null); }}
                            style={{ width: 70, padding: "3px 6px", borderRadius: 4, border: "1px solid #B45309", fontSize: 13, textAlign: "right", fontFamily: "'JetBrains Mono'", fontWeight: 700 }} />
                          <button onClick={() => savePrice(r.id)} style={{ padding: "3px 8px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>✓</button>
                        </div>
                      ) : (
                        <span onClick={() => { setEditId(r.id); setEditPrice(String(r.price)); }} style={{ cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: r.price === 0 ? "#DC2626" : "#B45309", fontSize: 14 }}>
                          ₹{Number(r.price).toLocaleString("en-IN")} ✏️
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#999", fontSize: 12 }}>No items found</div>}
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  FIXED COSTS — Monthly costs per outlet, editable
// ═════════════════════════════════════════════════════════════════════════════
const FixedCostsPanel = () => {
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selOutlet, setSelOutlet] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editAmt, setEditAmt] = useState("");
  const [addingTo, setAddingTo] = useState(null);
  const [newHead, setNewHead] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newAmt, setNewAmt] = useState("");

  const load = () => { setLoading(true); api.getFixedCosts().then(setCosts).catch(() => setCosts([])).finally(() => setLoading(false)); };
  useEffect(load, []);

  const outletIds = ["bk", "sec23", "sec31", "sec56", "elan"];
  const outletNames = { bk: "Base Kitchen", sec23: "S-23", sec31: "S-31", sec56: "S-56", elan: "ELAN" };
  const filteredCosts = selOutlet ? costs.filter((c) => c.outlet_id === selOutlet) : costs;

  // Group by outlet
  const grouped = {};
  filteredCosts.forEach((c) => { if (!grouped[c.outlet_id]) grouped[c.outlet_id] = []; grouped[c.outlet_id].push(c); });

  const saveAmount = async (outletId, costHead) => {
    try {
      const item = costs.find((c) => c.outlet_id === outletId && c.cost_head === costHead);
      await api.saveFixedCost({ outlet_id: outletId, cost_head: costHead, label: item?.label || costHead, amount: Number(editAmt) || 0 });
      setEditId(null);
      load();
    } catch (e) { alert("Error: " + e.message); }
  };

  const addCost = async (outletId) => {
    if (!newLabel.trim()) return;
    const head = newHead.trim() || newLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    try {
      await api.saveFixedCost({ outlet_id: outletId, cost_head: head, label: newLabel.trim(), amount: Number(newAmt) || 0 });
      setNewHead(""); setNewLabel(""); setNewAmt(""); setAddingTo(null);
      load();
    } catch (e) { alert("Error: " + e.message); }
  };

  const deleteCost = async (outletId, costHead) => {
    if (!confirm(`Delete ${costHead} for ${outletNames[outletId]}?`)) return;
    try { await api.deleteFixedCost(outletId, costHead); load(); } catch (e) { alert("Error: " + e.message); }
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>🏢 Fixed Costs (Monthly)</h3>
        <p style={{ fontSize: 12, color: "#888", margin: 0 }}>Monthly recurring costs per outlet. Daily P&L uses: monthly ÷ days in month.</p>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        <button onClick={() => setSelOutlet(null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: !selOutlet ? 700 : 500, border: !selOutlet ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: !selOutlet ? "#1A1A1A" : "#fff", color: !selOutlet ? "#fff" : "#888" }}>All</button>
        {outletIds.map((oid) => {
          const total = costs.filter((c) => c.outlet_id === oid).reduce((s, c) => s + Number(c.amount || 0), 0);
          return <button key={oid} onClick={() => setSelOutlet(oid)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: selOutlet === oid ? 700 : 500, border: selOutlet === oid ? "none" : "1px solid #E0E0DC", cursor: "pointer", fontFamily: "inherit", background: selOutlet === oid ? "#1A1A1A" : "#fff", color: selOutlet === oid ? "#fff" : "#888", whiteSpace: "nowrap" }}>{outletNames[oid]} <span style={{ fontSize: 10, opacity: 0.7 }}>₹{Math.round(total / 1000)}K</span></button>;
        })}
      </div>
      {loading && <div style={{ textAlign: "center", padding: 40, color: "#999" }}>⏳ Loading...</div>}
      {!loading && Object.entries(grouped).sort((a, b) => outletIds.indexOf(a[0]) - outletIds.indexOf(b[0])).map(([oid, items]) => {
        const total = items.reduce((s, c) => s + Number(c.amount || 0), 0);
        return (
          <div key={oid} style={{ background: "#fff", borderRadius: 14, border: "1px solid #E8E8E4", overflow: "hidden", marginBottom: 12 }}>
            <div style={{ padding: "10px 16px", background: "#F5F3FF", borderBottom: "1px solid #DDD6FE", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#6D28D9" }}>{outletNames[oid] || oid}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: "#7C3AED" }}>₹{total.toLocaleString("en-IN")}/mo</span>
                <button onClick={() => setAddingTo(addingTo === oid ? null : oid)} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{addingTo === oid ? "Cancel" : "+ Add"}</button>
              </div>
            </div>
            {addingTo === oid && (
              <div style={{ display: "flex", gap: 6, padding: "8px 12px", background: "#F0FDF4", borderBottom: "1px solid #BBF7D0", flexWrap: "wrap" }}>
                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label (e.g., Pest Control)" style={{ flex: "1 1 100px", padding: "6px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
                <input type="number" value={newAmt} onChange={(e) => setNewAmt(e.target.value)} placeholder="₹ Monthly" style={{ width: 80, padding: "6px 8px", borderRadius: 6, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "'JetBrains Mono'", textAlign: "right" }} />
                <button onClick={() => addCost(oid)} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#16A34A", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Add</button>
              </div>
            )}
            {items.sort((a, b) => b.amount - a.amount).map((c) => {
              const key = `${c.outlet_id}_${c.cost_head}`;
              return (
                <div key={key} style={{ display: "flex", alignItems: "center", padding: "8px 16px", borderBottom: "1px solid #F0F0EC" }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{c.label}</span>
                  {editId === key ? (
                    <div style={{ display: "flex", gap: 3 }}>
                      <input type="number" autoFocus value={editAmt} onChange={(e) => setEditAmt(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveAmount(c.outlet_id, c.cost_head); if (e.key === "Escape") setEditId(null); }}
                        style={{ width: 80, padding: "3px 6px", borderRadius: 4, border: "1px solid #7C3AED", fontSize: 13, textAlign: "right", fontFamily: "'JetBrains Mono'", fontWeight: 700 }} />
                      <button onClick={() => saveAmount(c.outlet_id, c.cost_head)} style={{ padding: "3px 8px", borderRadius: 4, border: "none", background: "#16A34A", color: "#fff", fontSize: 10, cursor: "pointer" }}>✓</button>
                    </div>
                  ) : (
                    <span onClick={() => { setEditId(key); setEditAmt(String(c.amount)); }} style={{ cursor: "pointer", fontFamily: "'JetBrains Mono'", fontWeight: 700, color: "#7C3AED", fontSize: 14 }}>
                      ₹{Number(c.amount).toLocaleString("en-IN")} ✏️
                    </span>
                  )}
                  <button onClick={() => deleteCost(c.outlet_id, c.cost_head)} style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#DC2626", fontSize: 12, cursor: "pointer" }}>🗑️</button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  STORE RECIPES VIEW — BK + Outlet recipes in one tab
// ═════════════════════════════════════════════════════════════════════════════
const StoreRecipesView = () => {
  const [tab, setTab] = useState("bk");
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setTab("bk")} style={{ flex: 1, padding: "10px", borderRadius: 10, border: tab === "bk" ? "none" : "1px solid #FDE68A", background: tab === "bk" ? "#B45309" : "#FFFBEB", color: tab === "bk" ? "#fff" : "#B45309", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>🏭 BK Recipes</button>
        <button onClick={() => setTab("outlet")} style={{ flex: 1, padding: "10px", borderRadius: 10, border: tab === "outlet" ? "none" : "1px solid #BBF7D0", background: tab === "outlet" ? "#16A34A" : "#F0FDF4", color: tab === "outlet" ? "#fff" : "#16A34A", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>🍳 Outlet Recipes</button>
      </div>
      {tab === "bk" && <RecipesPanel />}
      {tab === "outlet" && <OutletRecipeManager />}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN — LAUNCHER
// ═════════════════════════════════════════════════════════════════════════════
export default function AnandaCafe() {
  // Auth state
  const [currentUser, setCurrentUser] = useState(() => {
    try { const u = localStorage.getItem("ananda_user"); if (u) { _currentUser = JSON.parse(u); return _currentUser; } } catch (e) {} return null;
  });
  const [loginPhone, setLoginPhone] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [loginErr, setLoginErr] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const doLogin = async () => {
    if (!loginPhone || !loginPin) { setLoginErr("Enter phone and PIN"); return; }
    setLoginLoading(true); setLoginErr(null);
    try {
      const user = await api.login(loginPhone, loginPin);
      localStorage.setItem("ananda_user", JSON.stringify(user));
      _currentUser = user;
      setCurrentUser(user);
      setLoginPhone(""); setLoginPin("");
    } catch (e) { setLoginErr(e.message || "Login failed"); }
    finally { setLoginLoading(false); }
  };

  const doLogout = () => { localStorage.removeItem("ananda_user"); _currentUser = null; setCurrentUser(null); };

  // Check URL for role parameter: ?role=outlet or ?role=store or ?role=owner
  const [urlRole] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const role = params.get("role");
      if (role === "outlet" || role === "store" || role === "owner") return role;
    } catch (e) {}
    return null;
  });

  const [app, setApp] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const role = params.get("role");
      if (role === "outlet" || role === "store" || role === "owner") return role;
    } catch (e) {}
    return "launcher";
  });
  const [ownerTab, setOwnerTab] = useState("pnl");
  const [bkDropdown, setBkDropdown] = useState(false);
  const [auditDropdown, setAuditDropdown] = useState(false);
  const [storeView, setStoreView] = useState("bk");
  const [masterLoaded, setMasterLoaded] = useState(false);

  // Auto-route when user logs in
  useEffect(() => {
    if (currentUser && app === "launcher") {
      if (currentUser.role === "owner") setApp("owner");
      else if (currentUser.role === "store_mgr") setApp("store");
      else if (currentUser.role === "outlet_mgr") setApp("outlet");
    }
  }, [currentUser]);

  // Load master data from DB on startup — updates in-memory arrays
  useEffect(() => {
    Promise.all([
      api.getMasterSections().catch(() => null),
      api.getMasterRawMaterials().catch(() => null),
      api.getMasterRecipes().catch(() => null),
      api.getConversions().catch(() => null),
    ]).then(([sections, rawMats, recipes, conversions]) => {
      if (sections && sections.length > 0) {
        // Replace DEMAND_SECTIONS contents
        DEMAND_SECTIONS.length = 0;
        sections.forEach((sec) => {
          DEMAND_SECTIONS.push({
            id: sec.id,
            titleHi: sec.title,
            emoji: sec.emoji || "",
            color: sec.color || "#1A1A1A",
            bg: sec.bg || "#fff",
            border: sec.border || "#E0E0DC",
            items: (sec.items || []).map((i) => ({ id: i.id, name: i.name, unit: i.unit })),
          });
        });
      }
      if (rawMats && rawMats.length > 0) {
        RAW_MATERIALS.length = 0;
        rawMats.forEach((r) => RAW_MATERIALS.push({ id: r.id, name: r.name, unit: r.unit, inv_id: r.inventory_item_id }));
      }
      if (recipes && Object.keys(recipes).length > 0) {
        Object.keys(RECIPES).forEach((k) => delete RECIPES[k]);
        Object.assign(RECIPES, recipes);
      }
      if (conversions && Object.keys(conversions).length > 0) {
        Object.keys(UNIT_CONVERSIONS).forEach((k) => delete UNIT_CONVERSIONS[k]);
        Object.assign(UNIT_CONVERSIONS, conversions);
      }
      setMasterLoaded(true);
    });
  }, []);

  // Login screen
  if (!currentUser) return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px" }}>
    <div style={{ textAlign: "center", marginBottom: 32 }}>
      <div style={{ fontSize: 56, marginBottom: 8 }}>🍽️</div>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 4px" }}>Ananda Cafe</h1>
      <p style={{ fontSize: 14, color: "#999", margin: 0 }}>Operations Management System</p>
    </div>
    <div style={{ background: "#fff", borderRadius: 18, border: "1px solid #E8E8E4", padding: "28px 24px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, textAlign: "center" }}>Login</div>
      <input type="tel" inputMode="numeric" placeholder="Phone Number" value={loginPhone} onChange={(e) => setLoginPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
        style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 16, fontFamily: "inherit", marginBottom: 10, boxSizing: "border-box", textAlign: "center", letterSpacing: 2 }} />
      <input type="tel" inputMode="numeric" placeholder="4-digit PIN" value={loginPin} onChange={(e) => setLoginPin(e.target.value.replace(/\D/g, "").slice(0, 4))} onKeyDown={(e) => e.key === "Enter" && doLogin()}
        style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #E0E0DC", fontSize: 24, fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, marginBottom: 14, boxSizing: "border-box", textAlign: "center", letterSpacing: 12 }} />
      {loginErr && <div style={{ padding: "8px 12px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 12, color: "#991B1B", marginBottom: 12, textAlign: "center" }}>❌ {loginErr}</div>}
      <button onClick={doLogin} disabled={loginLoading || loginPhone.length < 10 || loginPin.length < 4}
        style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: loginPhone.length >= 10 && loginPin.length >= 4 && !loginLoading ? "#1A1A1A" : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 16, cursor: loginPhone.length >= 10 && loginPin.length >= 4 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
        {loginLoading ? "⏳ Logging in..." : "Login →"}
      </button>
    </div>
  </div></div>);

  if (app === "launcher") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 440, margin: "0 auto", padding: "40px 20px" }}><div style={{ textAlign: "center", marginBottom: 36 }}><div style={{ fontSize: 48, marginBottom: 8 }}>🍽️</div><h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 4px" }}>Ananda Cafe</h1><p style={{ fontSize: 14, color: "#999", margin: 0 }}>Operations Management System</p>{currentUser && <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>👤 {currentUser.name} <button onClick={doLogout} style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600, textDecoration: "underline" }}>Logout</button></div>}</div>
    {[{ id: "owner", icon: "👑", title: "Owner Dashboard", sub: "COGS, Daily P&L, Red Flags", bg: "linear-gradient(135deg, #1A1A1A, #333)", color: "#fff", subC: "rgba(255,255,255,0.6)" }, { id: "outlet", icon: "🏪", title: "Outlet Manager", sub: "Daily demand challan & closing stock", bg: "#fff", color: "#1A1A1A", border: "#E8E8E4", subC: "#888" }, { id: "store", icon: "📦", title: "Store Manager (BK)", sub: "Ration store issuance records", bg: "#fff", color: "#1A1A1A", border: "#E8E8E4", subC: "#888" }].map((a) => (<button key={a.id} onClick={() => setApp(a.id)} style={{ width: "100%", padding: "22px 24px", borderRadius: 18, background: a.bg, border: a.border ? `1px solid ${a.border}` : "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit", marginBottom: 12, display: "flex", alignItems: "center", gap: 16 }}><div style={{ fontSize: 36 }}>{a.icon}</div><div><div style={{ fontSize: 18, fontWeight: 800, color: a.color }}>{a.title}</div><div style={{ fontSize: 13, color: a.subC }}>{a.sub}</div></div></button>))}
  </div></div>);

  if (app === "owner") return (<div style={PAGE}>{FONT}
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 50 }}>{!urlRole && <BackBtn onClick={() => setApp("launcher")} />}<div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 800 }}>👑 Owner Dashboard</div><div style={{ fontSize: 11, color: "#999" }}>Ananda Cafe{currentUser ? ` · ${currentUser.name}` : ""}</div></div>{currentUser && <button onClick={doLogout} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #FECACA", background: "#FEF2F2", fontSize: 10, color: "#DC2626", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Logout</button>}</div>
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", position: "sticky", top: 52, zIndex: 49 }}>
      <div style={{ padding: "0 18px", display: "flex", gap: 0, alignItems: "center", overflowX: "auto" }}>
      {[{ id: "pnl", label: "💰 P&L" }, { id: "stock_usage", label: "📦 Stock" }, { id: "sales", label: "📤 Sales" }, { id: "cogs", label: "📊 COGS" }].map((t) => (<button key={t.id} onClick={() => { setOwnerTab(t.id); setBkDropdown(false); setAuditDropdown(false); }} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: ownerTab === t.id ? 700 : 500, color: ownerTab === t.id ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: ownerTab === t.id ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>{t.label}</button>))}
      <button onClick={() => { setBkDropdown(!bkDropdown); setAuditDropdown(false); }} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: ["kitchen","dispatch","inventory","activity","orders","history"].includes(ownerTab) ? 700 : 500, color: ["kitchen","dispatch","inventory","activity","orders","history"].includes(ownerTab) ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: ["kitchen","dispatch","inventory","activity","orders","history"].includes(ownerTab) ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>🏭 BK & Store ▾</button>
      <button onClick={() => { setAuditDropdown(!auditDropdown); setBkDropdown(false); }} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: ["master","audit","iss_audit","inv_monthly","recipes","pp_recipes","users"].includes(ownerTab) ? 700 : 500, color: ["master","audit","iss_audit","inv_monthly","recipes","pp_recipes","users"].includes(ownerTab) ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: ["master","audit","iss_audit","inv_monthly","recipes","pp_recipes","users"].includes(ownerTab) ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>🔍 Audit ▾</button>
      </div>
    </div>
    {/* BK Dropdown */}
    {bkDropdown && (<>
      <div onClick={() => setBkDropdown(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998, background: "rgba(0,0,0,0.1)" }} />
      <div style={{ position: "fixed", top: 90, left: "50%", transform: "translateX(-50%)", background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", boxShadow: "0 8px 24px rgba(0,0,0,0.15)", zIndex: 999, minWidth: 240, maxWidth: 320, padding: "6px 0" }}>
        {[{ id: "kitchen", label: "🏭 BK Consolidated", sub: "Demand & Stock Out" },
          { id: "dispatch", label: "🚚 Dispatch", sub: "Verify & send to outlets" },
          { id: "inventory", label: "📦 Inventory", sub: "Stock levels & issuance" },
          { id: "activity", label: "🔴 Live Activity", sub: "Real-time submissions" },
          { id: "orders", label: "📋 Orders", sub: "All outlet orders today" },
          { id: "history", label: "📜 History", sub: "Order & Dispatch challans (30 days)" },
        ].map((t) => (
          <button key={t.id} onClick={() => { setOwnerTab(t.id); setBkDropdown(false); }} style={{ width: "100%", padding: "10px 16px", border: "none", background: ownerTab === t.id ? "#F5F5F3" : "transparent", textAlign: "left", cursor: "pointer", fontFamily: "inherit", display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: ownerTab === t.id ? 700 : 500, color: ownerTab === t.id ? "#1A1A1A" : "#555" }}>{t.label}</div>
            <div style={{ fontSize: 10, color: "#999", marginTop: 1 }}>{t.sub}</div>
          </button>
        ))}
      </div>
    </>)}
    {/* Audit Dropdown */}
    {auditDropdown && (<>
      <div onClick={() => setAuditDropdown(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998, background: "rgba(0,0,0,0.1)" }} />
      <div style={{ position: "fixed", top: 90, left: "50%", transform: "translateX(-50%)", background: "#fff", borderRadius: 12, border: "1px solid #E8E8E4", boxShadow: "0 8px 24px rgba(0,0,0,0.15)", zIndex: 999, minWidth: 240, maxWidth: 320, padding: "6px 0" }}>
        {[{ id: "master", label: "🗂️ Master Data", sub: "Items, units, recipes & mappings" },
          { id: "rate_card", label: "💰 Rate Card", sub: "Item prices for P&L calculation" },
          { id: "fixed_costs", label: "🏢 Fixed Costs", sub: "Monthly costs per outlet" },
          { id: "users", label: "👥 Users", sub: "Manage users, PINs & roles" },
          { id: "audit", label: "🔍 RM Audit", sub: "Theoretical vs actual consumption" },
          { id: "iss_audit", label: "📊 Issue Audit", sub: "Calculated vs issued quantities" },
          { id: "inv_monthly", label: "📊 Monthly Inventory", sub: "Daily stock in/out grid" },
          { id: "recipes", label: "📖 BK Recipes", sub: "Standard recipe management" },
          { id: "pp_recipes", label: "🍳 PetPooja Recipes", sub: "Item-level from PetPooja" },
        ].map((t) => (
          <button key={t.id} onClick={() => { setOwnerTab(t.id); setAuditDropdown(false); }} style={{ width: "100%", padding: "10px 16px", border: "none", background: ownerTab === t.id ? "#F5F5F3" : "transparent", textAlign: "left", cursor: "pointer", fontFamily: "inherit", display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: ownerTab === t.id ? 700 : 500, color: ownerTab === t.id ? "#1A1A1A" : "#555" }}>{t.label}</div>
            <div style={{ fontSize: 10, color: "#999", marginTop: 1 }}>{t.sub}</div>
          </button>
        ))}
      </div>
    </>)}
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 18px 40px" }}>
      {ownerTab === "activity" && <LiveActivity />}
      {ownerTab === "sales" && <SalesUpload />}
      {ownerTab === "cogs" && <CogsDash />}
      {ownerTab === "pnl" && <DailyPnL />}
      {ownerTab === "stock_usage" && <DailyStockUsage />}
      {ownerTab === "stock_usage" && <DailyStockUsage />}
      {ownerTab === "orders" && <OutletOrders />}
      {ownerTab === "kitchen" && <BaseKitchen />}
      {ownerTab === "audit" && <RMAuditPanel />}
      {ownerTab === "master" && <MasterData />}
      {ownerTab === "rate_card" && <RateCardPanel />}
      {ownerTab === "fixed_costs" && <FixedCostsPanel />}
      {ownerTab === "iss_audit" && <IssuanceAudit />}
      {ownerTab === "inv_monthly" && <MonthlyInventory />}
      {ownerTab === "dispatch" && <Dispatch />}
      {ownerTab === "inventory" && <Inventory />}
      {ownerTab === "recipes" && <RecipesPanel />}
      {ownerTab === "pp_recipes" && <PetPoojaRecipes />}
      {ownerTab === "history" && <OrderDispatchHistory />}
      {ownerTab === "users" && <UsersPanel />}
    </div>
  </div>);

  if (app === "outlet") return (<div style={PAGE}>{FONT}<div style={{ maxWidth: 500, margin: "0 auto", padding: "24px 18px" }}><OutletMgr onBack={urlRole ? null : () => setApp("launcher")} /></div></div>);
  if (app === "store") return (<div style={PAGE}>{FONT}
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 50 }}>{!urlRole && <BackBtn onClick={() => setApp("launcher")} />}<div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 800 }}>📦 Store Manager (BK)</div><div style={{ fontSize: 11, color: "#999" }}>Ananda Cafe</div></div></div>
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E8E4", padding: "0 18px", display: "flex", gap: 0, position: "sticky", top: 52, zIndex: 49, overflowX: "auto" }}>{[{ id: "bk", label: "🏭 Kitchen" }, { id: "dispatch", label: "🚚 Dispatch" }, { id: "inventory", label: "📦 Inventory" }, { id: "sales", label: "📤 Sales" }, { id: "recipes", label: "🍳 Recipes" }, { id: "actions", label: "🏭 BK Demand" }, { id: "master", label: "🗂️ Master Data" }].map((t) => (<button key={t.id} onClick={() => setStoreView(t.id)} style={{ padding: "11px 14px", border: "none", background: "transparent", fontSize: 12, fontWeight: storeView === t.id ? 700 : 500, color: storeView === t.id ? "#1A1A1A" : "#999", cursor: "pointer", fontFamily: "inherit", borderBottom: storeView === t.id ? "2px solid #1A1A1A" : "2px solid transparent", whiteSpace: "nowrap" }}>{t.label}</button>))}</div>
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 18px 40px" }}>
      {storeView === "bk" && <BaseKitchen />}
      {storeView === "dispatch" && <Dispatch />}
      {storeView === "inventory" && <Inventory />}
      {storeView === "sales" && <SalesUpload />}
      {storeView === "recipes" && <StoreRecipesView />}
      {storeView === "actions" && <StoreMgr onBack={urlRole ? null : () => setApp("launcher")} />}
      {storeView === "master" && <MasterData />}
    </div>
  </div>);
  return null;
}

