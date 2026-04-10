const API = process.env.REACT_APP_API_URL || "http://localhost:3001";

const api = {
  // ── Auth ──
  login: (pin) => post("/api/auth/login", { pin }),

  // ── Outlets ──
  getOutlets: () => get("/api/outlets"),

  // ── Demands ──
  getDemands: (params) => get("/api/demands", params),
  createDemand: (data) => post("/api/demands", data),
  uploadDemandPhoto: (demandId, section, base64) =>
    post(`/api/demands/${demandId}/photos`, { section, base64 }),

  // ── Closing Stock ──
  submitClosingStock: (data) => post("/api/demands/closing-stock", data),
  getClosingStock: (params) => get("/api/demands/closing-stock", params),

  // ── Issuances ──
  getIssuances: (params) => get("/api/issuances", params),
  createIssuance: (data) => post("/api/issuances", data),
  uploadIssuancePhoto: (issuanceId, section, base64) =>
    post(`/api/issuances/${issuanceId}/photos`, { section, base64 }),

  // ── Purchases ──
  getPurchases: (params) => get("/api/purchases", params),
  createPurchase: (data) => post("/api/purchases", data),
  uploadPurchasePhoto: (purchaseId, base64, label) =>
    post(`/api/purchases/${purchaseId}/photos`, { base64, label }),
  getPurchaseSummary: (date) => get("/api/purchases/summary", { date }),

  // ── P&L ──
  getPnl: (params) => get("/api/pnl", params),
  upsertPnl: (data) => post("/api/pnl", data),
  getPnlSummary: (date) => get("/api/pnl/summary", { date }),

  // ── Orders / Dashboard ──
  getOrders: (params) => get("/api/orders", params),
  getConsolidated: (date) => get("/api/orders/consolidated", { date }),
  updateOrderStatus: (id, status, notes) => patch(`/api/orders/${id}/status`, { status, dispatch_notes: notes }),
  getDashboardSummary: (date) => get("/api/orders/dashboard-summary", { date }),

  // ── PetPooja ──
  syncPetpooja: (date) => post("/api/petpooja/sync", { date }),
  getPetpoojaStatus: () => get("/api/petpooja/status"),
};

// ── Helpers ──
async function get(path, params = {}) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(API + path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `PATCH ${path} failed: ${res.status}`);
  }
  return res.json();
}

export default api;
