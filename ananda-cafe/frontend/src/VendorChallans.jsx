import { useState, useEffect, useMemo } from "react";
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
  const [screen, setScreen] = useState("list"); // "list" | "new" | "detail"
  const [selectedId, setSelectedId] = useState(null);

  if (screen === "new") return <ChallanForm onDone={(id) => { setSelectedId(id); setScreen("detail"); }} onCancel={() => setScreen("list")} />;
  if (screen === "detail" && selectedId) return <ChallanDetail id={selectedId} onBack={() => setScreen("list")} />;
  return <ChallanList onNew={() => setScreen("new")} onOpen={(id) => { setSelectedId(id); setScreen("detail"); }} />;
}

function ChallanList({ onNew, onOpen }) {
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState("");
  const [challans, setChallans] = useState(null);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    const params = { from: todayStrMinus(30) };
    if (location) params.location = location;
    if (status) params.status = status;
    api.getChallans(params).then(setChallans).catch((e) => setError(e.message));
  };
  useEffect(load, [location, status]);

  return (
    <div>
      <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400E" }}>
        🆕 New Store Inventory Module — Stage 2 (Beta). Vendor deliveries received here post directly to the new stock ledger.
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["", "store", "bk"].map((loc) => (
            <button key={loc || "all"} onClick={() => setLocation(loc)} style={{ padding: "7px 14px", borderRadius: 8, border: location === loc ? "none" : "1px solid #E0E0DC", background: location === loc ? "#1A1A1A" : "#fff", color: location === loc ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {loc === "" ? "All" : loc === "store" ? "🏬 Store" : "🏭 BK"}
            </button>
          ))}
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #E0E0DC", fontSize: 12, fontFamily: "inherit" }}>
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button onClick={onNew} style={btnPrimary}>+ New Vendor Challan</button>
      </div>

      {error && <div style={{ color: "#DC2626", fontSize: 13, padding: 20, textAlign: "center" }}>{error}</div>}
      {!error && challans === null && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
      {!error && challans && challans.length === 0 && <div style={{ color: "#999", fontSize: 13, padding: 20, textAlign: "center" }}>No challans in the last 30 days.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(challans || []).map((c) => {
          const s = STATUS_COLORS[c.status] || STATUS_COLORS.draft;
          return (
            <div key={c.id} onClick={() => onOpen(c.id)} style={{ background: "#fff", border: "1px solid #E8E8E4", borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{c.vendor_name || "(no vendor)"} <span style={{ fontWeight: 500, color: "#999", fontSize: 11 }}>· {c.location_id === "store" ? "Store" : "BK"}</span></div>
                <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{c.challan_date}{c.challan_number ? ` · #${c.challan_number}` : ""}</div>
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

function todayStrMinus(n) { const d = new Date(); d.setMinutes(d.getMinutes() + 330); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

function ChallanForm({ onDone, onCancel }) {
  const [vendors, setVendors] = useState([]);
  const [items, setItems] = useState([]);
  const [vendorId, setVendorId] = useState("");
  const [newVendorName, setNewVendorName] = useState("");
  const [location, setLocation] = useState("store");
  const [challanNumber, setChallanNumber] = useState("");
  const [challanDate, setChallanDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ item_id: "", unit_entered: "", qty_entered: "", unit_price: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.getVendors().then(setVendors).catch(() => {}); api.getStoreItems().then(setItems).catch(() => {}); }, []);

  const itemById = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);

  const setLine = (idx, patch) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { item_id: "", unit_entered: "", qty_entered: "", unit_price: "" }]);
  const removeLine = (idx) => setLines((ls) => ls.filter((_, i) => i !== idx));

  const total = lines.reduce((sum, l) => { const q = Number(l.qty_entered); const p = Number(l.unit_price); return sum + (q > 0 && p > 0 ? q * p : 0); }, 0);

  const save = async () => {
    setError("");
    const validLines = lines.filter((l) => l.item_id && Number(l.qty_entered) > 0);
    if (!validLines.length) return setError("Add at least one item with a quantity.");
    setSaving(true);
    try {
      const payload = {
        location_id: location, challan_number: challanNumber || undefined, challan_date: challanDate, notes: notes || undefined,
        items: validLines.map((l) => ({ item_id: l.item_id, unit_entered: l.unit_entered || itemById[l.item_id]?.base_unit, qty_entered: Number(l.qty_entered), unit_price: l.unit_price ? Number(l.unit_price) : undefined })),
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
                {idx === 0 && <label style={labelStyle}>Price/unit</label>}
                <input type="number" min="0" step="any" value={l.unit_price} onChange={(e) => setLine(idx, { unit_price: e.target.value })} style={inputStyle} placeholder="₹" />
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

  const load = () => api.getChallan(id).then(setChallan).catch((e) => setError(e.message));
  useEffect(load, [id]);

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
        {(challan.items || []).map((it) => (
          <div key={it.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid #F0F0EE", fontSize: 13 }}>
            <div>{it.item_name}</div>
            <div style={{ color: "#666" }}>{fmtQty(it.qty_entered)} {it.unit_entered}{it.unit_price ? ` @ ₹${it.unit_price}` : ""}</div>
          </div>
        ))}
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
      </div>
      {challan.status === "draft" && !canReceive && <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>Upload the bill (or confirm there isn't one) before receiving.</div>}
      {challan.status === "received" && <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>Received by {challan.received_by} — stock updated.</div>}
    </div>
  );
}
