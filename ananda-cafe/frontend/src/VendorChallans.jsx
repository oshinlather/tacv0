import { useState, useEffect, useMemo, useRef } from "react";
import api from "./api";

// Store Inventory Module — Stage 2: vendor challan (delivery note) -> receive -> auto
// stock-in against the Stage 1 ledger. New, separate file per the "don't rewrite
// App.jsx" rule — App.jsx only imports and tab-wires <VendorChallans />.
//
// Naming: called "Vendor Challan" everywhere in this screen (not just "Challan") to
// stay clear of two OTHER things this app already calls "challan" — the outbound
// "Order Challan" (a PO document to a vendor) and the outlet manager's "Verify Dispatch
// Challan" punch (BK->outlet transfer confirmation). This is neither of those — it's
// the receiving side of what a vendor's delivery driver actually hands over.

const fmtQty = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }); };
const fmtMoney = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() + 330); return d.toISOString().slice(0, 10); };
// Standalone (this file doesn't import from App.jsx — see the header comment on why),
// reading the same localStorage key App.jsx's own getCurrentUser() writes to. Only used to
// gate the Delete-challan button to owner — everything else here already goes through the
// backend's own role checks regardless of what this says.
const getCurrentUser = () => { try { const u = localStorage.getItem("ananda_user"); return u ? JSON.parse(u) : null; } catch (e) { return null; } };

// Stage 5 migration: the same vendor-category buckets the old Order Challan screen
// used (App.jsx's ORDER_VENDORS) — duplicated here rather than imported, since App.jsx
// stays "wiring only" per the project's own rule and this is a small, stable list.
// categories match items.category exactly (backfilled as-is from inventory_items).
const ORDER_VENDORS = [
  { id: "vegetable", label: "🥬 Vegetables", categories: ["Vegetable"], period: "daily", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  { id: "dairy", label: "🥛 Dairy", categories: ["Dairy"], period: "daily", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  { id: "gas", label: "🔥 Gas", categories: ["Gas"], period: "daily", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  { id: "grocery_masala", label: "🛒 Grocery & Masala", categories: ["Grocery", "Food", "Masala"], period: "10day", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
  { id: "packaging_cleaning", label: "📦 Packaging & Cleaning", categories: ["Packaging", "Cleaning"], period: "10day", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
];

const STATUS_COLORS = {
  draft: { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E", label: "📝 Draft" },
  received: { bg: "#F0FDF4", border: "#BBF7D0", text: "#166534", label: "✅ Received" },
  cancelled: { bg: "#FEF2F2", border: "#FECACA", text: "#991B1B", label: "🚫 Cancelled" },
};

const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: "none", background: "#1A1A1A", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { padding: "10px 16px", borderRadius: 10, border: "1px solid #E0E0DC", background: "#fff", color: "#555", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };
const labelStyle = { fontSize: 11, fontWeight: 700, color: "#888", marginBottom: 4, display: "block" };

export default function VendorChallans() {
  const [screen, setScreen] = useState("list"); // "list" | "new" | "detail" | "order" | "legacy"
  const [selectedId, setSelectedId] = useState(null);

  if (screen === "order") return <OrderView onCreated={(id) => { setSelectedId(id); setScreen("detail"); }} onBack={() => setScreen("list")} />;
  if (screen === "new") return <ChallanForm onDone={(id) => { setSelectedId(id); setScreen("detail"); }} onCancel={() => setScreen("list")} />;
  if (screen === "detail" && selectedId) return <ChallanDetail id={selectedId} onBack={() => setScreen("list")} />;
  if (screen === "legacy" && selectedId) return <LegacyOrderDetail id={selectedId} onBack={() => setScreen("list")} />;
  return (
    <ChallanList
      onNew={() => setScreen("new")}
      onOrder={() => setScreen("order")}
      onOpen={(id) => { setSelectedId(id); setScreen("detail"); }}
      onOpenLegacy={(id) => { setSelectedId(id); setScreen("legacy"); }}
    />
  );
}

// Same 8 categories the rest of the app uses (demand/rate card/P&L) — just an
// emoji+label lookup for display here, not a source of truth.
const CATEGORY_META = {
  Vegetable: { emoji: "🥬", label: "Vegetables" },
  Dairy: { emoji: "🥛", label: "Dairy" },
  Grocery: { emoji: "🛒", label: "Grocery" },
  Masala: { emoji: "🌶️", label: "Masala" },
  Food: { emoji: "🍛", label: "Food" },
  Packaging: { emoji: "📦", label: "Packaging" },
  Cleaning: { emoji: "🧹", label: "Cleaning" },
  Gas: { emoji: "🔥", label: "Gas" },
};
const catMeta = (cat) => CATEGORY_META[cat] || { emoji: "📦", label: cat };

// Legacy "Order Challan" (purchase_orders table) — the OLD, pre-existing real-purchase
// system, untouched by the new Stage 2 vendor_challans module above. Real orders
// (Grocery ~2x/month, Vegetables daily) have always been recorded here, never in the
// new vendor_challans table (which is genuinely empty until stores start using it).
// Merged into this same list purely as a read view so there's one place to check old
// challans' qty/price — nothing here writes back into the new ledger. Every real order
// checked so far is single-category (a "Vegetables" order, a "Grocery" order, etc — see
// the /purchase-orders data itself), so deriving categories straight from its own items
// (rather than needing a separate vendor mapping) is reliable.
function normalizeLegacyPO(po) {
  const items = Object.values(po.items || {});
  let totalAmount = null;
  items.forEach((it) => { if (it.total_price != null) totalAmount = (totalAmount || 0) + Number(it.total_price); });
  const categories = [...new Set(items.map((it) => it.category).filter(Boolean))];
  const catLabel = categories.map((c) => catMeta(c).label).join("/") || null;
  const catEmoji = categories.map((c) => catMeta(c).emoji).join("") || "📜";
  return {
    id: po.id, _legacy: true, categories,
    vendor_name: `${catEmoji} ${catLabel ? catLabel + " — " : ""}Order Challan #${po.order_number || po.id.slice(0, 8)}`,
    location_id: "store", // legacy orders were always the central Store
    challan_date: po.date, challan_number: po.order_number,
    total_amount: totalAmount,
    status: po.status === "received" ? "received" : po.status === "cancelled" ? "cancelled" : "draft",
  };
}

function ChallanList({ onNew, onOrder, onOpen, onOpenLegacy }) {
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [challans, setChallans] = useState(null);
  const [legacy, setLegacy] = useState(null);
  const [error, setError] = useState("");
  // Was hardcoded to the last 30 days only — "need all the challans from july to till
  // date here". Neither backend route caps how far back `from` can reach (vendor_challans
  // has a 200-row .limit(), purchase_orders has none), so this just widens the default
  // window and lets the owner move it further back (or narrower) at will instead of a
  // fixed cutoff nobody could see past.
  const [fromDate, setFromDate] = useState("2026-07-01");

  const load = () => {
    setError("");
    const params = { from: fromDate };
    if (status) params.status = status;
    api.getChallans(params).then(setChallans).catch((e) => setError(e.message));
    api.getPurchaseOrders({ from: fromDate }).then((rows) => setLegacy((rows || []).map(normalizeLegacyPO))).catch(() => setLegacy([]));
  };
  useEffect(load, [status, fromDate]);

  const merged = useMemo(() => {
    let list = [...(challans || []), ...(legacy || [])];
    if (status) list = list.filter((c) => c.status === status);
    if (category) list = list.filter((c) => (c.categories || []).includes(category));
    return list;
  }, [challans, legacy, status, category]);
  merged.sort((a, b) => (b.challan_date || "").localeCompare(a.challan_date || ""));
  const loaded = challans !== null && legacy !== null;
  // Was legacy-only — a category that only ever appears on new-system vendor_challans
  // (e.g. a "Grocery & Masala" vendor's items individually categorized "Food", not
  // "Grocery" — the vendor bucket name and the item's own category are two different
  // things) would have no pill to filter by at all, leaving that challan visible under
  // "All" but permanently unreachable through any category filter.
  const availableCategories = useMemo(() => [...new Set([...(challans || []), ...(legacy || [])].flatMap((c) => c.categories || []))].sort(), [challans, legacy]);

  return (
    <div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400E" }}>
        🆕 New Store Inventory Module — Stage 2 (Beta). Vendor deliveries received here post directly to the new stock ledger. Older real purchases (📜 Order Challan) are shown alongside for reference — read-only, they still live in the old system.
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#888" }}>
            From
            <input type="date" value={fromDate} max={todayStr()} onChange={(e) => setFromDate(e.target.value)}
              style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }} />
          </label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }}>
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onOrder} style={{ ...btnPrimary, background: "#16A34A" }}>📝 Order from Vendor</button>
          <button onClick={onNew} style={btnGhost}>+ Log a Delivery</button>
        </div>
      </div>
      {availableCategories.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          <button onClick={() => setCategory("")} style={{ padding: "6px 12px", borderRadius: 8, border: category === "" ? "none" : "1px solid #E0E0DC", background: category === "" ? "#1A1A1A" : "#fff", color: category === "" ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>All</button>
          {availableCategories.map((c) => {
            const m = catMeta(c);
            return (
              <button key={c} onClick={() => setCategory(c)} style={{ padding: "6px 12px", borderRadius: 8, border: category === c ? "none" : "1px solid #E0E0DC", background: category === c ? "#1A1A1A" : "#fff", color: category === c ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{m.emoji} {m.label}</button>
            );
          })}
        </div>
      )}

      {error && <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>}
      {!error && !loaded && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
      {!error && loaded && merged.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No challans since {fromDate}.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {merged.map((c) => {
          const s = STATUS_COLORS[c.status] || STATUS_COLORS.draft;
          return (
            <div key={(c._legacy ? "po_" : "vc_") + c.id} onClick={() => (c._legacy ? onOpenLegacy(c.id) : onOpen(c.id))} style={{ background: "#fff", border: c._legacy ? "1px dashed #D0D0CC" : "1px solid #E8E8E4", borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{c.vendor_name || "(no vendor)"} <span style={{ fontWeight: 500, color: "#999", fontSize: 11 }}>· {c.location_id === "store" ? "Store" : "BK"}</span></div>
                <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{c.challan_date}{c.challan_number && !c._legacy ? ` · #${c.challan_number}` : ""}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                {c.total_amount != null && <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(c.total_amount)}</div>}
                <div style={{ fontSize: 10, fontWeight: 700, color: s.text, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: "2px 6px", display: "inline-block", marginTop: 3 }}>{s.label}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Detail view for a legacy purchase_orders row. Shows order_qty (what was asked for),
// bought_qty (what the driver actually bought — Vegetables orders had this recorded live
// via the old PATCH /purchase-orders/:id flow; Grocery orders mostly don't), received_qty
// (what store confirmed receiving), and total_price. Grocery orders in particular were
// never priced per-item in this old system (billed separately, not cash-paid by a
// driver) — "Edit" lets the owner go back and fill in the real numbers from the actual
// bill/receipt now, closing that gap rather than leaving it permanently blank.
function LegacyOrderDetail({ id, onBack }) {
  const [po, setPo] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({}); // itemId -> { bought_qty, received_qty, total_price } strings
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Add-item (typeahead) — for items that were physically received but never on the
  // original order, so the owner can back-fill their qty + price here too. itemMaster is
  // the same store item list the New Challan form picks from, so names/units/ids stay
  // consistent (no free-typed spelling that wouldn't match any real item).
  const [itemMaster, setItemMaster] = useState([]);
  const [added, setAdded] = useState([]); // [{ itemId, name, unit }] not on the original order
  const [addQuery, setAddQuery] = useState("");
  useEffect(() => { api.getStoreItems().then((l) => setItemMaster(l || [])).catch(() => setItemMaster([])); }, []);
  // Sortable columns — click a header to sort, click again to flip direction. Same
  // toggle convention used elsewhere (Rate Alert, Item-wise Sales): first click on a
  // column is descending, nulls (no price yet, mostly) always sort last regardless of
  // direction so unpriced items don't scatter to the top of a descending Price sort.
  const [sort, setSort] = useState({ key: null, dir: "desc" });
  const toggleSort = (key) => setSort((s) => s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });

  // Block body (not `() => api...then...catch(...)`) is deliberate — an expression-body
  // arrow function here would return the promise chain itself, and passed straight to
  // useEffect as its effect callback, React treats ANY non-undefined return value as a
  // cleanup function and calls it on unmount — crashing with "destroy is not a function"
  // every single time this screen was left via Back, since a Promise obviously isn't
  // callable. Block body with no `return` makes `load()` return undefined instead, which
  // is what an effect callback (and .then(load) at various call sites below) both expect.
  const load = () => { api.getPurchaseOrder(id).then(setPo).catch((e) => setError(e.message)); };
  useEffect(load, [id]);

  if (error) return <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>;
  if (!po) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>;

  const items = Object.entries(po.items || {}).map(([itemId, it]) => ({ itemId, ...it }));
  const sortedItems = (() => {
    if (!sort.key) return items;
    const dir = sort.dir === "asc" ? 1 : -1;
    const field = { item: "name", ordered: "order_qty", price: "total_price" }[sort.key];
    return [...items].sort((a, b) => {
      const av = a[field], bv = b[field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  })();
  const sortArrow = (key) => <span style={{ marginLeft: 4, fontSize: 9, color: sort.key === key ? "#1A1A1A" : "#CCC" }}>{sort.key === key ? (sort.dir === "desc" ? "▼" : "▲") : "⇅"}</span>;
  const anyPrice = items.some((it) => it.total_price != null);
  const grandTotal = items.reduce((sum, it) => sum + (Number(it.total_price) || 0), 0);
  const s = STATUS_COLORS[po.status === "received" ? "received" : po.status === "cancelled" ? "cancelled" : "draft"];

  const startEdit = () => {
    const d = {};
    items.forEach((it) => { d[it.itemId] = { bought_qty: it.bought_qty ?? "", received_qty: it.received_qty ?? "", total_price: it.total_price ?? "" }; });
    setDraft(d);
    setAdded([]);
    setAddQuery("");
    setEditing(true);
  };

  const setField = (itemId, field, val) => setDraft((p) => ({ ...p, [itemId]: { ...p[itemId], [field]: val } }));

  // Items already on the order or already added — excluded from the typeahead so the same
  // item can't be added twice.
  const takenIds = new Set([...Object.keys(po.items || {}), ...added.map((a) => a.itemId)]);
  const q = addQuery.trim().toLowerCase();
  const suggestions = q ? itemMaster.filter((i) => !takenIds.has(i.id) && (i.name || "").toLowerCase().includes(q)).slice(0, 8) : [];
  const addItem = (i) => {
    setAdded((a) => [...a, { itemId: i.id, name: i.name, unit: i.base_unit || i.unit || "" }]);
    setDraft((p) => ({ ...p, [i.id]: { bought_qty: "", received_qty: "", total_price: "" } }));
    setAddQuery("");
  };
  const removeAdded = (itemId) => {
    setAdded((a) => a.filter((x) => x.itemId !== itemId));
    setDraft((p) => { const n = { ...p }; delete n[itemId]; return n; });
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const newItems = { ...po.items };
      Object.entries(draft).forEach(([itemId, d]) => {
        const addedMeta = added.find((a) => a.itemId === itemId);
        newItems[itemId] = {
          ...(newItems[itemId] || {}),
          // A newly-added item has no original order row — stamp its name/unit and
          // order_qty 0 (it was never ordered, only received) so it renders like the rest.
          ...(addedMeta ? { name: addedMeta.name, unit: addedMeta.unit, order_qty: newItems[itemId]?.order_qty ?? 0 } : {}),
          bought_qty: d.bought_qty === "" ? undefined : Number(d.bought_qty),
          received_qty: d.received_qty === "" ? undefined : Number(d.received_qty),
          total_price: d.total_price === "" ? undefined : Number(d.total_price),
        };
      });
      await api.updatePurchaseOrder(id, { items: newItems });
      setEditing(false);
      setAdded([]);
      load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  // Owner-only, for a genuine duplicate entry (e.g. the same order logged twice by
  // mistake). Irreversible — also strips any price it recorded in the rate-card ledger
  // server-side (see the backend route's own comment) — so this is a hard confirm.
  const isOwner = getCurrentUser()?.role === "owner";
  const deletePO = () => {
    if (!window.confirm("Delete this Order Challan permanently? This cannot be undone.")) return;
    setDeleting(true);
    api.deletePurchaseOrder(id).then(onBack).catch((e) => { setError(e.message); setDeleting(false); });
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>📜 Order Challan #{po.order_number}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: s.text, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: "3px 8px" }}>{s.label}</div>
      </div>

      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#92400E" }}>
        Old Order Challan system. {!anyPrice && !editing && "No per-item price was recorded on this order (that's normal for Grocery — it's billed separately, not cash-paid by a driver) — tap Edit to back-fill it from the real bill."}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "#999" }}>{po.date} · Store</div>
        {!editing ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={startEdit} style={btnGhost}>✏️ Edit — Back-fill Qty/Price</button>
            {isOwner && <button onClick={deletePO} disabled={deleting} style={{ ...btnGhost, color: "#DC2626", borderColor: "#FECACA", background: "#FEF2F2" }}>{deleting ? "…" : "🗑️ Delete (duplicate)"}</button>}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setEditing(false); setAdded([]); setAddQuery(""); }} disabled={saving} style={btnGhost}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "💾 Save"}</button>
          </div>
        )}
      </div>
      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", padding: "8px 14px", background: "#FAFAF8", fontSize: 10, fontWeight: 800, color: "#888", borderBottom: "1px solid #F0F0EE" }}>
          <div style={{ flex: 2, cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort("item")}>ITEM{sortArrow("item")}</div>
          <div style={{ flex: 1, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort("ordered")}>ORDERED{sortArrow("ordered")}</div>
          <div style={{ flex: 1, textAlign: "right" }}>BOUGHT</div>
          <div style={{ flex: 1, textAlign: "right" }}>RECEIVED</div>
          <div style={{ flex: editing ? "1 1 100px" : 1, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort("price")}>PRICE (₹){sortArrow("price")}</div>
        </div>
        {sortedItems.map((it, idx) => {
          const bought = it.bought_qty != null ? it.bought_qty : it.received_qty;
          const perUnit = it.total_price != null && bought > 0 ? it.total_price / bought : null;
          const d = draft[it.itemId] || {};
          return (
            <div key={it.itemId} style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderTop: idx === 0 ? "none" : "1px solid #F0F0EE", fontSize: 13 }}>
              <div style={{ flex: 2, fontWeight: 600 }}>{it.name}</div>
              <div style={{ flex: 1, textAlign: "right", color: "#999" }}>{fmtQty(it.order_qty)} {it.unit}</div>
              {editing ? (
                <>
                  <div style={{ flex: 1, textAlign: "right" }}><input type="number" min="0" step="any" value={d.bought_qty} onChange={(e) => setField(it.itemId, "bought_qty", e.target.value)} style={{ ...inputStyle, width: 64, textAlign: "right", display: "inline-block" }} /></div>
                  <div style={{ flex: 1, textAlign: "right" }}><input type="number" min="0" step="any" value={d.received_qty} onChange={(e) => setField(it.itemId, "received_qty", e.target.value)} style={{ ...inputStyle, width: 64, textAlign: "right", display: "inline-block" }} /></div>
                  <div style={{ flex: "1 1 100px", textAlign: "right" }}><input type="number" min="0" step="any" placeholder="₹ total" value={d.total_price} onChange={(e) => setField(it.itemId, "total_price", e.target.value)} style={{ ...inputStyle, width: 90, textAlign: "right", display: "inline-block" }} /></div>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, textAlign: "right" }}>{it.bought_qty != null ? `${fmtQty(it.bought_qty)} ${it.unit}` : "—"}</div>
                  <div style={{ flex: 1, textAlign: "right" }}>{it.received_qty != null ? `${fmtQty(it.received_qty)} ${it.unit}` : "—"}</div>
                  <div style={{ flex: 1, textAlign: "right", fontWeight: 700 }}>
                    {it.total_price != null ? (<>{fmtMoney(it.total_price)}{perUnit != null && <div style={{ fontWeight: 500, fontSize: 10, color: "#999" }}>@₹{perUnit.toLocaleString("en-IN", { maximumFractionDigits: 1 })}/{it.unit}</div>}</>) : "—"}
                  </div>
                </>
              )}
            </div>
          );
        })}
        {/* Newly-added items (received but never ordered) — same qty/price inputs as the
            rows above, tinted green + a remove (✕) so an accidental add can be undone. */}
        {editing && added.map((a) => {
          const d = draft[a.itemId] || {};
          return (
            <div key={a.itemId} style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderTop: "1px solid #F0F0EE", fontSize: 13, background: "#F0FDF4" }}>
              <div style={{ flex: 2, fontWeight: 600 }}>{a.name} <span style={{ fontSize: 9, color: "#16A34A", fontWeight: 800 }}>NEW</span>
                <button onClick={() => removeAdded(a.itemId)} title="Remove this item" style={{ marginLeft: 6, border: "none", background: "none", color: "#DC2626", cursor: "pointer", fontSize: 12, padding: 0 }}>✕</button>
              </div>
              <div style={{ flex: 1, textAlign: "right", color: "#BBB" }}>— {a.unit}</div>
              <div style={{ flex: 1, textAlign: "right" }}><input type="number" min="0" step="any" value={d.bought_qty} onChange={(e) => setField(a.itemId, "bought_qty", e.target.value)} style={{ ...inputStyle, width: 64, textAlign: "right", display: "inline-block" }} /></div>
              <div style={{ flex: 1, textAlign: "right" }}><input type="number" min="0" step="any" value={d.received_qty} onChange={(e) => setField(a.itemId, "received_qty", e.target.value)} style={{ ...inputStyle, width: 64, textAlign: "right", display: "inline-block" }} /></div>
              <div style={{ flex: "1 1 100px", textAlign: "right" }}><input type="number" min="0" step="any" placeholder="₹ total" value={d.total_price} onChange={(e) => setField(a.itemId, "total_price", e.target.value)} style={{ ...inputStyle, width: 90, textAlign: "right", display: "inline-block" }} /></div>
            </div>
          );
        })}
        {anyPrice && !editing && <div style={{ padding: "10px 14px", textAlign: "right", fontSize: 14, fontWeight: 800, borderTop: "1px solid #F0F0EE" }}>Total: {fmtMoney(grandTotal)}</div>}
      </div>

      {/* Add-item typeahead — deliberately OUTSIDE the table's overflow:hidden wrapper above,
          so its suggestion dropdown isn't clipped (it used to only show a sliver). Type to
          search the store item master (no free-typed names, so nothing gets misspelled). */}
      {editing && (
        <div style={{ marginTop: 10, position: "relative" }}>
          <input value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder="+ Add an item received but not ordered — type to search…" style={inputStyle} />
          {suggestions.length > 0 && (
            <div style={{ position: "absolute", left: 0, right: 0, top: 46, background: "#fff", border: "1px solid #E0E0DC", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", zIndex: 20, maxHeight: 260, overflowY: "auto" }}>
              {suggestions.map((i) => (
                <div key={i.id} onClick={() => addItem(i)} style={{ padding: "10px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #F5F5F3" }}>
                  {i.name} <span style={{ fontSize: 10, color: "#999" }}>· {i.base_unit || i.unit || ""}</span>
                </div>
              ))}
            </div>
          )}
          {addQuery.trim() && suggestions.length === 0 && <div style={{ fontSize: 11, color: "#999", marginTop: 6 }}>No matching item in the store master — it must be added there first.</div>}
        </div>
      )}
    </div>
  );
}

function todayStrMinus(n) { const d = new Date(); d.setMinutes(d.getMinutes() + 330); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
function tomorrowStr() { const d = new Date(); d.setMinutes(d.getMinutes() + 330); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

// Stage 5 migration: the old Order Challan's core loop (pick a vendor, see
// Requirement − Stock auto-suggested quantities, WhatsApp or save) ported onto the new
// ledger. Ordering always targets Store (an external vendor delivery arrives at the
// central store, not directly at BK — matches how the old flow always worked; BK gets
// its own supply from Store via BK Demand, a different, already-existing flow, not this
// one). Saving here creates a DRAFT vendor challan with no prices yet — those get filled
// in on the challan detail screen once you know what was actually bought and for how
// much, same two-step timing the old flow had (order now, price later).
function OrderView({ onCreated, onBack }) {
  const [items, setItems] = useState([]);
  const [stock, setStock] = useState({}); // item_id -> store qty
  const [rmConfig, setRmConfig] = useState({});
  const [usage, setUsage] = useState({});
  const [loading, setLoading] = useState(true);
  const [selVendorId, setSelVendorId] = useState(null);
  const [pendingVendorId, setPendingVendorId] = useState(null); // daily vendors ask today/tomorrow first
  const [selDate, setSelDate] = useState(todayStr());
  const [orderQty, setOrderQty] = useState({}); // item_id -> string override
  const [rmEditing, setRmEditing] = useState(false);
  const [rmDraft, setRmDraft] = useState({});
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getStoreItems().catch(() => []),
      api.getStoreStock({ location: "store" }).catch(() => []),
      api.getRmOrderConfig().catch(() => []),
      api.getRmOrderSuggestNew().catch(() => ({})),
    ]).then(([itemList, stockList, config, usageMap]) => {
      setItems(itemList);
      const stockMap = {}; (stockList || []).forEach((s) => { stockMap[s.id] = Number(s.current_qty) || 0; });
      setStock(stockMap);
      const cfgMap = {}; (config || []).forEach((c) => { cfgMap[c.item_id] = Number(c.rm_qty) || 0; });
      setRmConfig(cfgMap); setRmDraft(cfgMap);
      setUsage(usageMap || {});
    }).finally(() => setLoading(false));
  }, []);

  const vendorItems = (v) => items.filter((i) => v.categories.includes(i.category)).map((item) => {
    const rmQty = Number(rmConfig[item.id]) || 0;
    const currentQty = Number(stock[item.id]) || 0;
    // Rounded to 6dp — found by clicking through this exact screen: plain JS
    // subtraction leaks float noise into the UI (5 - 3.3 = 1.7000000000000002), same
    // class of bug as the backend ledger fix, just on the frontend's own arithmetic.
    const orderQtyCalc = Math.round(Math.max(0, rmQty - currentQty) * 1e6) / 1e6;
    return { ...item, rmQty, currentQty, orderQtyCalc };
  });

  const saveRmConfig = async (v) => {
    const vi = items.filter((i) => v.categories.includes(i.category));
    const entries = vi.filter((i) => rmDraft[i.id] > 0).map((i) => ({ item_id: i.id, rm_qty: rmDraft[i.id], rm_unit: i.base_unit }));
    try {
      await api.saveRmOrderConfig(entries);
      setRmConfig((p) => { const n = { ...p }; entries.forEach((e) => { n[e.item_id] = e.rm_qty; }); return n; });
      setRmEditing(false);
    } catch (e) { setError(e.message); }
  };

  const shareWA = (v) => {
    const vi = vendorItems(v);
    const lines = [`*🛒 The Ananda Cafe — ${v.label} Order*`, `📅 ${selDate}`, ""];
    vi.forEach((item) => { const eq = Number(orderQty[item.id]); const fq = !isNaN(eq) && eq >= 0 ? eq : item.orderQtyCalc; if (fq > 0) lines.push(`• ${item.name}: *${fq} ${item.base_unit}*`); });
    lines.push("", `Total: ${lines.filter((l) => l.startsWith("•")).length} items`);
    window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank");
  };

  const createOrder = async (v) => {
    setError("");
    const vi = vendorItems(v);
    const lines = vi.map((item) => { const eq = Number(orderQty[item.id]); const fq = !isNaN(eq) && eq >= 0 ? eq : item.orderQtyCalc; return fq > 0 ? { item_id: item.id, qty_entered: fq, unit_entered: item.base_unit } : null; }).filter(Boolean);
    if (!lines.length) return setError("No items to order.");
    setSaving(true);
    try {
      const challan = await api.createChallan({ location_id: "store", challan_date: selDate, vendor_name: v.label, items: lines });
      onCreated(challan.id);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  if (loading) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>;

  if (pendingVendorId) {
    const pv = ORDER_VENDORS.find((x) => x.id === pendingVendorId);
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}><button onClick={() => setPendingVendorId(null)} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button><div style={{ fontSize: 15, fontWeight: 800 }}>{pv.label} Order</div></div>
        <div style={{ textAlign: "center", marginBottom: 24, fontSize: 15, fontWeight: 700 }}>Ordering for today or tomorrow?</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={() => { setSelDate(todayStr()); setSelVendorId(pendingVendorId); setPendingVendorId(null); }} style={{ padding: 18, borderRadius: 14, border: "none", background: pv.color, color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit" }}>📅 Today ({todayStr()})</button>
          <button onClick={() => { setSelDate(tomorrowStr()); setSelVendorId(pendingVendorId); setPendingVendorId(null); }} style={{ padding: 18, borderRadius: 14, border: `2px solid ${pv.border}`, background: pv.bg, color: pv.color, fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit" }}>📅 Tomorrow ({tomorrowStr()})</button>
        </div>
      </div>
    );
  }

  if (rmEditing && selVendorId) {
    const v = ORDER_VENDORS.find((x) => x.id === selVendorId);
    const vi = items.filter((i) => v.categories.includes(i.category));
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><button onClick={() => setRmEditing(false)} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button><div style={{ fontSize: 15, fontWeight: 800 }}>⚙️ Set {v.label} Requirement</div></div>
        <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "#1D4ED8", marginBottom: 14 }}>Set qty needed for {v.period === "daily" ? "1 day" : "10 days"}. Last 10d usage shown as reference.</div>
        {vi.map((item) => {
          const u = Math.round((usage[item.id] || 0) * 100) / 100;
          return (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: rmDraft[item.id] > 0 ? "#EFF6FF" : "#FAFAF8", marginBottom: 3 }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div><div style={{ fontSize: 10, color: "#999" }}>10d usage: <strong>{u || "—"}</strong></div></div>
              <input type="number" min="0" value={rmDraft[item.id] || ""} onChange={(e) => setRmDraft((p) => ({ ...p, [item.id]: Math.max(0, +e.target.value || 0) }))} style={{ ...inputStyle, width: 70, textAlign: "center" }} />
              <span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.base_unit}</span>
            </div>
          );
        })}
        <button onClick={() => saveRmConfig(v)} style={{ ...btnPrimary, width: "100%", marginTop: 12, background: v.color }}>💾 Save {v.label} Requirement</button>
      </div>
    );
  }

  if (selVendorId) {
    const v = ORDER_VENDORS.find((x) => x.id === selVendorId);
    const vi = vendorItems(v);
    const viVisible = vi.filter((i) => !search.trim() || i.name.toLowerCase().includes(search.trim().toLowerCase()));
    const tot = vi.filter((i) => { const e = Number(orderQty[i.id]); return (!isNaN(e) ? e : i.orderQtyCalc) > 0; }).length;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <button onClick={() => { setSelVendorId(null); setOrderQty({}); setSearch(""); }} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
          <div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 800 }}>{v.label} Order</div><div style={{ fontSize: 11, color: "#888" }}>{v.period === "daily" ? "Daily order" : "10-day RM order"} · {selDate}</div></div>
          <button onClick={() => setRmEditing(true)} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${v.border}`, background: v.bg, fontSize: 10, fontWeight: 700, color: v.color, cursor: "pointer", fontFamily: "inherit" }}>⚙️ Set Req</button>
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Search items…" style={{ ...inputStyle, marginBottom: 10 }} />
        <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10, padding: "8px 12px", fontSize: 11, color: "#166534", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span>Order = Requirement − Store Stock</span><span style={{ fontWeight: 700 }}>{tot} items</span>
        </div>
        {viVisible.map((item) => {
          const e = Number(orderQty[item.id]); const fq = !isNaN(e) && e >= 0 ? e : item.orderQtyCalc; const need = fq > 0;
          return (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, background: need ? v.bg : "#FAFAF8", marginBottom: 3, border: need ? `1px solid ${v.border}` : "1px solid transparent" }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div><div style={{ fontSize: 10, color: "#999" }}>Req: <strong>{item.rmQty}</strong> − Stock: <strong style={{ color: item.currentQty === 0 ? "#DC2626" : "#888" }}>{item.currentQty}</strong> = <strong style={{ color: v.color }}>{item.orderQtyCalc}</strong> {item.base_unit}</div></div>
              <input type="number" min="0" step="any" placeholder={String(item.orderQtyCalc)} value={orderQty[item.id] ?? ""} onChange={(e) => setOrderQty((p) => ({ ...p, [item.id]: e.target.value }))} style={{ width: 64, padding: 6, borderRadius: 8, border: need ? `2px solid ${v.color}` : "1px solid #E0E0DC", fontSize: 15, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 800 }} />
              <span style={{ fontSize: 10, color: "#999", width: 28 }}>{item.base_unit}</span>
            </div>
          );
        })}
        {error && <div style={{ color: "#DC2626", fontSize: 12, margin: "10px 0" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12, position: "sticky", bottom: 0, paddingBottom: 8, background: "linear-gradient(transparent, #FAF9F6 20%)" }}>
          <button onClick={() => shareWA(v)} style={{ flex: 1, padding: 12, borderRadius: 12, border: "1px solid #BBF7D0", background: "#F0FDF4", color: "#16A34A", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>💬 WhatsApp</button>
          <button onClick={() => createOrder(v)} disabled={saving || tot === 0} style={{ flex: 2, padding: 12, borderRadius: 12, border: "none", background: tot > 0 && !saving ? v.color : "#D0D0CC", color: "#fff", fontWeight: 800, fontSize: 14, cursor: tot > 0 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{saving ? "⏳…" : `📝 Create Order (${tot})`}</button>
        </div>
      </div>
    );
  }

  const dailyV = ORDER_VENDORS.filter((v) => v.period === "daily");
  const rmV = ORDER_VENDORS.filter((v) => v.period === "10day");
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800 }}>📝 Order from Vendor</div>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#16A34A", marginBottom: 8 }}>🔄 Daily Orders</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 20 }}>
        {dailyV.map((v) => { const vi = vendorItems(v); const need = vi.filter((i) => i.orderQtyCalc > 0).length; return (
          <button key={v.id} onClick={() => setPendingVendorId(v.id)} style={{ padding: "14px 8px", borderRadius: 14, border: `1px solid ${v.border}`, background: v.bg, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
            <div style={{ fontSize: 24, marginBottom: 2 }}>{v.label.split(" ")[0]}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: v.color }}>{v.label.split(" ").slice(1).join(" ")}</div>
            <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>{vi.length} items</div>
            {need > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: v.color, marginTop: 2 }}>{need} to order</div>}
          </button>
        ); })}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#B45309", marginBottom: 8 }}>📦 10-Day RM Orders</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {rmV.map((v) => { const vi = vendorItems(v); const need = vi.filter((i) => i.orderQtyCalc > 0).length; return (
          <button key={v.id} onClick={() => { setSelVendorId(v.id); setSelDate(todayStr()); }} style={{ padding: "14px 8px", borderRadius: 14, border: `1px solid ${v.border}`, background: v.bg, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
            <div style={{ fontSize: 24, marginBottom: 2 }}>{v.label.split(" ")[0]}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: v.color }}>{v.label.split(" ").slice(1).join(" ")}</div>
            <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>{vi.length} items</div>
            {need > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: v.color, marginTop: 2 }}>{need} to order</div>}
          </button>
        ); })}
      </div>
    </div>
  );
}

function ChallanForm({ onDone, onCancel }) {
  const [vendors, setVendors] = useState([]);
  const [items, setItems] = useState([]);
  const [vendorId, setVendorId] = useState("");
  const [newVendorName, setNewVendorName] = useState("");
  const [location, setLocation] = useState("store");
  const [challanNumber, setChallanNumber] = useState("");
  const [challanDate, setChallanDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ item_id: "", unit_entered: "", qty_entered: "", total_price: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.getVendors().then(setVendors).catch(() => {}); api.getStoreItems().then(setItems).catch(() => {}); }, []);

  const itemById = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);

  const setLine = (idx, patch) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { item_id: "", unit_entered: "", qty_entered: "", total_price: "" }]);
  const removeLine = (idx) => setLines((ls) => ls.filter((_, i) => i !== idx));

  const total = lines.reduce((sum, l) => sum + (Number(l.total_price) || 0), 0);

  const save = async () => {
    setError("");
    const validLines = lines.filter((l) => l.item_id && Number(l.qty_entered) > 0);
    if (!validLines.length) return setError("Add at least one item with a quantity.");
    setSaving(true);
    try {
      const payload = {
        location_id: location, challan_number: challanNumber || undefined, challan_date: challanDate, notes: notes || undefined,
        items: validLines.map((l) => ({ item_id: l.item_id, unit_entered: l.unit_entered || itemById[l.item_id]?.base_unit, qty_entered: Number(l.qty_entered), total_price: l.total_price ? Number(l.total_price) : undefined })),
      };
      if (vendorId) payload.vendor_id = vendorId; else if (newVendorName.trim()) payload.vendor_name = newVendorName.trim();
      const challan = await api.createChallan(payload);
      onDone(challan.id);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onCancel} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800 }}>New Vendor Challan</div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={labelStyle}>Vendor</label>
            <select value={vendorId} onChange={(e) => { setVendorId(e.target.value); if (e.target.value) setNewVendorName(""); }} style={inputStyle}>
              <option value="">— Select or type new below —</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            {!vendorId && <input placeholder="New vendor name" value={newVendorName} onChange={(e) => setNewVendorName(e.target.value)} style={{ ...inputStyle, marginTop: 6 }} />}
          </div>
          <div>
            <label style={labelStyle}>Location</label>
            <div style={{ display: "flex", gap: 6 }}>
              {["store", "bk"].map((loc) => (
                <button key={loc} onClick={() => setLocation(loc)} style={{ flex: 1, padding: "9px", borderRadius: 8, border: location === loc ? "none" : "1px solid #E0E0DC", background: location === loc ? "#1A1A1A" : "#fff", color: location === loc ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{loc === "store" ? "🏬 Store" : "🏭 BK"}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={labelStyle}>Challan Date</label>
            <input type="date" value={challanDate} onChange={(e) => setChallanDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Vendor's Challan # (optional)</label>
            <input value={challanNumber} onChange={(e) => setChallanNumber(e.target.value)} style={inputStyle} placeholder="e.g. INV-4521" />
          </div>
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#666", marginBottom: 10 }}>ITEMS</div>
        {lines.map((l, idx) => {
          const item = itemById[l.item_id];
          const units = item?.units || [];
          return (
            <div key={idx} style={{ display: "flex", gap: 6, alignItems: "flex-end", marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "2 1 160px" }}>
                {idx === 0 && <label style={labelStyle}>Item</label>}
                <select value={l.item_id} onChange={(e) => setLine(idx, { item_id: e.target.value, unit_entered: itemById[e.target.value]?.base_unit || "" })} style={inputStyle}>
                  <option value="">Select item…</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
              <div style={{ flex: "1 1 70px" }}>
                {idx === 0 && <label style={labelStyle}>Qty</label>}
                <input type="number" min="0" step="any" value={l.qty_entered} onChange={(e) => setLine(idx, { qty_entered: e.target.value })} style={inputStyle} />
              </div>
              <div style={{ flex: "1 1 80px" }}>
                {idx === 0 && <label style={labelStyle}>Unit</label>}
                <select value={l.unit_entered} onChange={(e) => setLine(idx, { unit_entered: e.target.value })} style={inputStyle} disabled={!item}>
                  {units.map((u) => <option key={u.unit} value={u.unit}>{u.unit}</option>)}
                </select>
              </div>
              <div style={{ flex: "1 1 90px" }}>
                {idx === 0 && <label style={labelStyle}>Total paid</label>}
                <input type="number" min="0" step="any" value={l.total_price} onChange={(e) => setLine(idx, { total_price: e.target.value })} style={inputStyle} placeholder="₹" />
              </div>
              {lines.length > 1 && <button onClick={() => removeLine(idx)} style={{ ...btnGhost, padding: "9px 10px", color: "#DC2626" }}>✕</button>}
            </div>
          );
        })}
        <button onClick={addLine} style={{ ...btnGhost, marginTop: 4 }}>+ Add Item</button>
        {total > 0 && <div style={{ marginTop: 12, textAlign: "right", fontSize: 14, fontWeight: 800 }}>Total: {fmtMoney(total)}</div>}
      </div>

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <label style={labelStyle}>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} />
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save Draft"}</button>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
      </div>
      <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>You'll upload the bill photo (or confirm there isn't one) and receive it on the next screen.</div>
    </div>
  );
}

function ChallanDetail({ id, onBack }) {
  const [challan, setChallan] = useState(null);
  const [error, setError] = useState("");
  const [noBillReason, setNoBillReason] = useState("");
  const [showNoBill, setShowNoBill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState({}); // item_id -> { qty_entered, unit_price } draft while typing
  const saveTimer = useRef(null);

  // Block body — see the identical fix + comment on LegacyOrderDetail's own `load` above.
  // Same bug, same shape: an expression-body arrow here returns the promise chain, which
  // useEffect below wrongly treats as its unmount cleanup function and tries to call.
  const load = () => { api.getChallan(id).then(setChallan).catch((e) => setError(e.message)); };
  useEffect(load, [id]);

  const editLine = (itemId, patch) => {
    setEditing((e) => ({ ...e, [itemId]: { ...e[itemId], ...patch } }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateChallanItems(id, { [itemId]: { ...editing[itemId], ...patch } }).then(load).catch((e) => setError(e.message));
    }, 700);
  };

  const uploadBill = (dataUrl) => {
    setBusy(true);
    api.uploadChallanBill(id, dataUrl).then(() => load()).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  const onFilePick = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => uploadBill(ev.target.result);
    r.readAsDataURL(f);
  };

  const saveNoBillReason = () => {
    if (!noBillReason.trim()) return;
    setBusy(true);
    api.updateChallan(id, { no_bill_reason: noBillReason.trim() }).then(() => { setShowNoBill(false); load(); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const receive = () => {
    setBusy(true);
    api.receiveChallan(id).then(() => load()).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const cancel = () => {
    setBusy(true);
    api.cancelChallan(id).then(() => load()).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  // Owner-only, for a genuine duplicate entry — the same delivery logged twice by
  // mistake. Irreversible (reverses any stock-in/price-ledger effects server-side, then
  // deletes outright — see the backend route's own comment), so this is a hard confirm,
  // not just a click.
  const isOwner = getCurrentUser()?.role === "owner";
  const deleteChallan = () => {
    if (!window.confirm(`Delete this challan permanently? ${challan.status === "received" ? "This will also reverse the stock it added and any price it recorded. " : ""}This cannot be undone.`)) return;
    setBusy(true);
    api.deleteChallan(id).then(onBack).catch((e) => { setError(e.message); setBusy(false); });
  };

  const shareWA = () => {
    if (!challan) return;
    const lines = [`*🧾 Vendor Challan — ${challan.vendor_name || "Vendor"}*`, `📅 ${challan.challan_date} · ${challan.location_id === "store" ? "Store" : "BK"}`, ""];
    (challan.items || []).forEach((it) => { lines.push(`• ${it.item_name}: *${fmtQty(it.qty_entered)} ${it.unit_entered}*${it.unit_price ? ` @ ₹${it.unit_price}` : ""}`); });
    if (challan.total_amount) lines.push("", `Total: ${fmtMoney(challan.total_amount)}`);
    window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank");
  };

  if (error) return <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>;
  if (!challan) return <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>;

  const s = STATUS_COLORS[challan.status] || STATUS_COLORS.draft;
  const canReceive = challan.status === "draft" && (challan.bill_photo_path || challan.no_bill_reason);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...btnGhost, padding: "8px 12px" }}>← Back</button>
        <div style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{challan.vendor_name || "(no vendor)"}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: s.text, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: "3px 8px" }}>{s.label}</div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>{challan.challan_date} · {challan.location_id === "store" ? "Store" : "BK"}{challan.challan_number ? ` · #${challan.challan_number}` : ""}</div>
        {challan.status === "draft" && <div style={{ fontSize: 11, color: "#B45309", marginBottom: 6 }}>Fill in what was actually bought and for how much — edits save automatically.</div>}
        {(challan.items || []).map((it) => {
          const draft = editing[it.item_id] || {};
          return (
            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: "1px solid #F0F0EE", fontSize: 13, gap: 8 }}>
              <div style={{ flex: 1 }}>{it.item_name}</div>
              {challan.status === "draft" ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="number" min="0" step="any" value={draft.qty_entered ?? it.qty_entered} onChange={(e) => editLine(it.item_id, { qty_entered: e.target.value })} style={{ ...inputStyle, width: 60, textAlign: "right" }} />
                    <span style={{ fontSize: 10, color: "#999" }}>{it.unit_entered}</span>
                    <span style={{ fontSize: 10, color: "#999" }}>₹</span>
                    {/* Total paid for this whole line, straight off the vendor's bill (e.g.
                        "Potato 250 Kg — ₹6,250") — the per-Kg rate below is computed by the
                        server, never something the store has to work out themselves. */}
                    <input type="number" min="0" step="any" value={draft.total_price ?? it.line_total ?? ""} onChange={(e) => editLine(it.item_id, { total_price: e.target.value })} placeholder="total paid" style={{ ...inputStyle, width: 84, textAlign: "right" }} />
                  </div>
                  {it.unit_price != null && <div style={{ fontSize: 10, color: "#999" }}>@₹{Number(it.unit_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}/{it.unit_entered}</div>}
                </div>
              ) : (
                <div style={{ color: "#666", textAlign: "right" }}>
                  {fmtQty(it.qty_entered)} {it.unit_entered}
                  {it.line_total != null && <div style={{ fontSize: 11, fontWeight: 600 }}>{fmtMoney(it.line_total)}{it.unit_price != null && <span style={{ fontWeight: 500, color: "#999" }}> (@₹{Number(it.unit_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}/{it.unit_entered})</span>}</div>}
                </div>
              )}
            </div>
          );
        })}
        {challan.total_amount != null && <div style={{ marginTop: 10, textAlign: "right", fontSize: 14, fontWeight: 800 }}>Total: {fmtMoney(challan.total_amount)}</div>}
        {challan.notes && <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>Note: {challan.notes}</div>}
      </div>

      {challan.status === "draft" && (
        <div style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 12, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#666", marginBottom: 10 }}>BILL</div>
          {challan.bill_url ? (
            <a href={challan.bill_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#2563EB" }}>📎 View uploaded bill</a>
          ) : challan.no_bill_reason ? (
            <div style={{ fontSize: 12, color: "#888" }}>No bill — {challan.no_bill_reason}</div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ ...btnGhost, display: "inline-block" }}>
                📷 Upload Bill
                <input type="file" accept="image/*" capture="environment" onChange={onFilePick} style={{ display: "none" }} />
              </label>
              {!showNoBill ? (
                <button onClick={() => setShowNoBill(true)} style={btnGhost}>No bill given</button>
              ) : (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input placeholder="Why no bill?" value={noBillReason} onChange={(e) => setNoBillReason(e.target.value)} style={{ ...inputStyle, width: 160 }} />
                  <button onClick={saveNoBillReason} style={btnGhost}>Confirm</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {challan.status === "draft" && <button onClick={receive} disabled={!canReceive || busy} style={{ ...btnPrimary, opacity: canReceive && !busy ? 1 : 0.5 }}>{busy ? "…" : "✅ Receive → Stock In"}</button>}
        {challan.status === "draft" && <button onClick={cancel} disabled={busy} style={{ ...btnGhost, color: "#DC2626" }}>Cancel Challan</button>}
        <button onClick={shareWA} style={btnGhost}>📤 Share on WhatsApp</button>
        {isOwner && <button onClick={deleteChallan} disabled={busy} style={{ ...btnGhost, color: "#DC2626", borderColor: "#FECACA", background: "#FEF2F2" }}>🗑️ Delete (duplicate)</button>}
      </div>
      {challan.status === "draft" && !canReceive && <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>Upload the bill (or confirm there isn't one) before receiving.</div>}
      {challan.status === "received" && <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>Received by {challan.received_by} — stock updated.</div>}
    </div>
  );
}
