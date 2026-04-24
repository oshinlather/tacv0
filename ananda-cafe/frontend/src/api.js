const API = process.env.REACT_APP_API_URL || "http://localhost:3001";

// Read the logged-in user's ID from localStorage on every request.
// Returns null if not logged in — the backend will 401 those requests on
// protected routes, 200 them on public ones (like /auth/login).
function getUserId() {
  try {
    const u = localStorage.getItem("ananda_user");
    if (!u) return null;
    const parsed = JSON.parse(u);
    return parsed?.id || null;
  } catch (e) {
    return null;
  }
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  const id = getUserId();
  if (id) h["x-user-id"] = id;
  return h;
}

const api = {
  // ── Outlets ──
  getOutlets: () => get("/api/outlets"),

  // ── Demands ──
  getDemands: (params) => get("/api/demands", params),
  createDemand: (data) => post("/api/demands", data),
  updateDemandDraft: (id, data) => patch(`/api/demands/${id}/draft`, data),
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
  getComputedPnl: (date) => get(`/api/pnl/computed/${date}`),

  // ── Sales ──
  getSales: (params) => get("/api/sales", params),
  uploadSalesCSV: (file, date) => {
    const formData = new FormData();
    formData.append("file", file);
    if (date) formData.append("date", date);
    return fetch(API + "/api/sales/upload", {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error); }); return r.json(); });
  },

  // ── Issuance Audit ──
  saveIssuanceAudit: (entries) => post("/api/issuance-audit", { entries }),
  getIssuanceAudit: (date) => get(`/api/issuance-audit/${date}`),

  // ── RM Audit ──
  getRMAudit: (date) => get(`/api/audit/${date}`),

  // ── PetPooja Recipes ──
  getRecipesPetpooja: () => get("/api/recipes/petpooja"),

  // ── Orders / Dashboard ──
  getOrders: (params) => get("/api/orders", params),
  getConsolidated: (date) => get("/api/orders/consolidated", { date }),
  updateOrderStatus: (id, status, notes) => patch(`/api/orders/${id}/status`, { status, dispatch_notes: notes }),
  dispatchOrder: (id, dispatch_items, dispatched_by, remaining_items) => patch(`/api/orders/${id}/dispatch`, { dispatch_items, dispatched_by, remaining_items }),
  getChallan: (id) => get(`/api/orders/${id}/challan`),
  getDashboardSummary: (date) => get("/api/orders/dashboard-summary", { date }),

  // ── PetPooja ──
  syncPetpooja: (date) => post("/api/petpooja/sync", { date }),
  getPetpoojaStatus: () => get("/api/petpooja/status"),

  // ── Inventory ──
  getInventory: (params) => get("/api/inventory", params),
  stockIn: (items, reason, submitted_by) => post("/api/inventory/stock-in", { items, reason, submitted_by }),
  stockOut: (items, reason, submitted_by) => post("/api/inventory/stock-out", { items, reason, submitted_by }),
  adjustStock: (item_id, new_qty, reason) => post("/api/inventory/adjust", { item_id, new_qty, reason }),
  updateThreshold: (id, threshold) => patch(`/api/inventory/threshold/${id}`, { threshold }),
  bulkUpdateThresholds: (items) => post("/api/inventory/thresholds", { items }),
  getMovements: (item_id) => get(`/api/inventory/movements/${item_id}`),
  getTodayMovements: (date) => get("/api/inventory/movements", { date }),
  getInventorySummary: () => get("/api/inventory/summary"),
  addInventoryItem: (data) => post("/api/inventory/items", data),
  updateInventoryItem: (id, data) => patch(`/api/inventory/items/${id}`, data),
  deleteInventoryItem: (id) => del(`/api/inventory/items/${id}`),

  // ── Master Data ──
  getMasterSections: () => get("/api/master/sections"),
  getMasterRawMaterials: () => get("/api/master/raw-materials"),
  getMasterRecipes: () => get("/api/master/recipes"),
  addDemandItem: (data) => post("/api/master/demand-items", data),
  updateDemandItem: (id, data) => patch(`/api/master/demand-items/${id}`, data),
  deleteDemandItem: (id) => del(`/api/master/demand-items/${id}`),
  addRawMaterial: (data) => post("/api/master/raw-materials", data),
  updateRawMaterial: (id, data) => patch(`/api/master/raw-materials/${id}`, data),
  deleteRawMaterial: (id) => del(`/api/master/raw-materials/${id}`),
  saveRecipe: (data) => post("/api/master/recipes", data),
  deleteRecipe: (id) => del(`/api/master/recipes/${id}`),
  getConversions: () => get("/api/master/conversions"),
  addConversion: (data) => post("/api/master/conversions", data),
  updateConversion: (data) => patch("/api/master/conversions", data),
  deleteConversion: (unit_type, item_id) => del(`/api/master/conversions?unit_type=${unit_type}&item_id=${item_id}`),

  // ── Outlet Daily Sales ──
  getOutletSales: (params) => get("/api/outlet-sales", params),
  getLatestCash: (outlet_id, before_date) => get("/api/outlet-sales/latest-cash", { outlet_id, before_date }),
  submitOutletSales: (data) => post("/api/outlet-sales", data),
  verifyOutletSales: (data) => patch("/api/outlet-sales/verify", data),

  // ── Staff Demands (Food & Dress) ──
  getStaffDemandItems: () => get("/api/staff-demands/items"),
  getStaffDemands: (params) => get("/api/staff-demands", params),
  submitStaffDemand: (data) => post("/api/staff-demands", data),
  addStaffDemandItem: (data) => post("/api/staff-demands/items", data),
  deleteStaffDemandItem: (id) => del(`/api/staff-demands/items/${id}`),

  // ── Rate Card ──
  getRateCard: () => get("/api/rate-card"),
  addRate: (data) => post("/api/rate-card", data),
  updateRate: (id, data) => patch(`/api/rate-card/${id}`, data),
  deleteRate: (id) => del(`/api/rate-card/${id}`),

  // ── Fixed Costs ──
  getFixedCosts: (params) => get("/api/fixed-costs", params),
  saveFixedCost: (data) => post("/api/fixed-costs", data),
  deleteFixedCost: (outlet_id, cost_head) => del(`/api/fixed-costs?outlet_id=${outlet_id}&cost_head=${cost_head}`),

  // ── Live P&L ──
  getLivePnl: (date, outlet) => get(`/api/pnl/live/${date}`, outlet ? { outlet } : {}),
  getStockUsage: (date, outlet) => get(`/api/stock-usage/${date}`, outlet ? { outlet } : {}),

  // ── Outlet Recipes ──
  getOutletRecipes: () => get("/api/outlet-recipes"),
  addOutletRecipe: (data) => post("/api/outlet-recipes", data),
  updateOutletRecipe: (id, data) => patch(`/api/outlet-recipes/${id}`, data),
  deleteOutletRecipe: (id) => del(`/api/outlet-recipes/${id}`),
  saveOutletRecipeIngredients: (id, ingredients) => post(`/api/outlet-recipes/${id}/ingredients`, { ingredients }),
  deleteOutletRecipeIngredient: (recipeId, ingredientId) => del(`/api/outlet-recipes/${recipeId}/ingredients/${ingredientId}`),
  // RM Order Config
  getRmOrderConfig: () => get("/api/rm-order-config"),
  saveRmOrderConfig: (items) => post("/api/rm-order-config", { items }),
  getRmUsageSuggestion: () => get("/api/rm-order-config/suggest"),
  // Purchase Orders
  getPurchaseOrders: (params) => get("/api/purchase-orders", params),
  getPurchaseOrder: (id) => get(`/api/purchase-orders/${id}`),
  createPurchaseOrder: (data) => post("/api/purchase-orders", data),
  updatePurchaseOrder: (id, data) => patch(`/api/purchase-orders/${id}`, data),
  // History
  getChallanHistory: () => get("/api/history/challans"),
  getDispatchHistory: () => get("/api/history/dispatches"),
  // Paytm Reconciliation
  getPaytmActuals: (month) => get("/api/paytm-actuals", { month }),
  savePaytmActual: (date, outlet_id, actual_amount) => post("/api/paytm-actuals", { date, outlet_id, actual_amount }),
  // Cash Handovers
  getCashHandovers: (params) => get("/api/cash-handovers", params),
  saveCashHandover: (data) => post("/api/cash-handovers", data),
  // Qty Corrections (owner edit of dispatched item qty)
  editOrderItemQty: (demand_id, item_id, new_qty, reason) =>
    patch(`/api/orders/${demand_id}/item/${item_id}`, { new_qty, reason }),
  getCorrections: (params) => get("/api/corrections", params),
  // Auth
  login: (phone, pin) => post("/api/auth/login", { phone, pin }),
  getUsers: () => get("/api/auth/users"),
  createUser: (data) => post("/api/auth/users", data),
  updateUser: (id, data) => patch(`/api/auth/users/${id}`, data),
};

// ── Helpers ──
async function get(path, params = {}) {
  const url = new URL(API + path);
  // Guard: if params is a string (e.g. a date), wrap it as { date: params }
  const safeParams = typeof params === "string" ? { date: params } : params;
  Object.entries(safeParams).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `GET ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
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
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `PATCH ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function del(path) {
  const res = await fetch(API + path, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `DELETE ${path} failed: ${res.status}`);
  }
  return res.json();
}

export default api;
