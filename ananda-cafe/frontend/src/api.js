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

// ── Response cache ────────────────────────────────────────────────────────────
// Every GET funnels through get() below, so ONE cache here makes every screen's
// tab-switch / Back / refresh instant without touching a single call site. The app
// renders screens as `tab === "x" && <Screen/>`, so switching tabs fully unmounts the
// previous screen and its fetched state — this cache is what survives that. Keyed
// per-user (by the same id api.js already sends as x-user-id) so data never crosses
// users; mirrored to sessionStorage so a refresh / Back within the tab paints from cache
// instead of a cold reload. Any write (post/patch/del) nukes the whole cache — writes are
// rare vs reads, and nuke-all guarantees a save is never followed by a stale number (the
// ledgers here are correctness-sensitive). Returned data is always cloned, so a caller
// that mutates its copy (e.g. an in-place sort) can't corrupt the shared cache.
const CACHE_PREFIX = "ananda_cache";
const MASTER_TTL = 600_000;        // 10 min — near-static master data
const VOLATILE_TTL = 30_000;       // 30 s  — live / date-scoped data
const MAX_PERSIST_BYTES = 256 * 1024; // bigger payloads stay memory-only (don't blow quota)
// Request-path prefixes whose data is near-static (long TTL). Everything else is volatile.
const MASTER_PREFIXES = [
  "/api/rate-card", "/api/master/", "/api/outlets", "/api/recipes",
  "/api/store/items", "/api/store/vendors", "/api/store/production/recipes",
  "/api/users", "/api/employees", "/api/crockery", "/api/fixed-cost",
  "/api/franchise-settings", "/api/staff-demand-items", "/api/finance/commission",
  "/api/rm-order-config",
];
const ttlFor = (path) => (MASTER_PREFIXES.some((p) => path.startsWith(p)) ? MASTER_TTL : VOLATILE_TTL);

const memCache = new Map(); // key -> { data, ts }
const inflight = new Map(); // key -> Promise  (collapses identical concurrent GETs)

const cacheNs = () => `${CACHE_PREFIX}:${getUserId() || "anon"}:`;
const clone = (d) => {
  try { return typeof structuredClone === "function" ? structuredClone(d) : JSON.parse(JSON.stringify(d)); }
  catch (e) { return d; }
};
const readPersisted = (key) => {
  try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
};
const writePersisted = (key, serialized) => {
  if (!serialized || serialized.length > MAX_PERSIST_BYTES) return; // too big → mem-only
  try { sessionStorage.setItem(key, serialized); }
  catch (e) {
    // Quota exceeded (or disabled) — drop this user's namespace and carry on; the
    // in-memory cache still works, we just stop persisting until there's room again.
    try {
      const ns = cacheNs();
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(ns)) sessionStorage.removeItem(k);
      }
    } catch (_) {}
  }
};
// Wipe everything — called on every write and on login/logout (see api.clearCache).
function clearCache() {
  memCache.clear();
  inflight.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX + ":")) sessionStorage.removeItem(k);
    }
  } catch (e) {}
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
  // Chef/Bainmarry save their category-scoped items into today's shared draft (merges,
  // doesn't overwrite); Outlet Manager finalizes it or edits an already-finalized one.
  saveDemandDraft: (data) => patch("/api/demands/draft", data),
  finalizeDemand: (id, data) => patch(`/api/demands/${id}/finalize`, data),
  updateDemand: (id, data) => patch(`/api/demands/${id}`, data),
  cancelDemand: (id, reason) => patch(`/api/demands/${id}/cancel`, { reason }),
  // Owner-only exceptions to the 11:45 AM evening-demand cutoff — Owner Dashboard's
  // Demand Approval screen.
  getDemandExceptions: (params) => get("/api/demand-exceptions", params),
  grantDemandException: (data) => post("/api/demand-exceptions", data),
  revokeDemandException: (id) => del(`/api/demand-exceptions/${id}`),
  // Outlet-side check — "has the owner opened evening ordering for MY outlet today".
  checkMyDemandException: (outlet_id) => get("/api/demand-exceptions/mine", { outlet_id }),

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
  updatePurchaseRecord: (id, data) => patch(`/api/purchases/${id}`, data),
  uploadPurchasePhoto: (purchaseId, base64, label) =>
    post(`/api/purchases/${purchaseId}/photos`, { base64, label }),
  getPurchaseSummary: (date) => get("/api/purchases/summary", { date }),

  // ── Inter-Outlet Transfers ──
  getTransfers: (params) => get("/api/transfers", params),
  createTransfer: (data) => post("/api/transfers", data),
  confirmTransfer: (id, data) => patch(`/api/transfers/${id}/confirm`, data),
  cancelTransfer: (id) => patch(`/api/transfers/${id}/cancel`, {}),
  getOutletMenuItems: (outlet) => get(`/api/sales/menu-items/${outlet}`),

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
    }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error); }); clearCache(); return r.json(); });
  },

  // ── Issuance Audit ──
  saveIssuanceAudit: (entries) => post("/api/issuance-audit", { entries }),
  getIssuanceAudit: (date) => get(`/api/issuance-audit/${date}`),

  // ── RM Audit ──
  getRMAudit: (date, outlet) => get(`/api/audit/${date}`, outlet ? { outlet } : {}),
  // Range/month audit — sum of every day from `from` through `to` (see computeRMAuditRange).
  getRMAuditRange: (from, to, outlet) => get(`/api/audit/${from}`, { to, ...(outlet ? { outlet } : {}) }),
  getColdDrinkAudit: (date) => get(`/api/audit/cold-drink/${date}`),
  getColdDrinkAuditMonthly: (month) => get(`/api/audit/cold-drink-monthly/${month}`),
  getPackagingAudit: (days) => get("/api/audit/packaging", days ? { days } : {}),

  getBkRecipeCosts: () => get("/api/bk-recipe-costs"),
  // ── Franchise Billing corrections (persisted Qty/Rate edits) ──
  getFranchiseBillingCorrections: (outlet_id, month) => get("/api/franchise-billing/corrections", { outlet_id, month }),
  saveFranchiseBillingCorrections: (data) => post("/api/franchise-billing/corrections", data),
  getFranchiseBillingSummary: (params) => get("/api/franchise-billing/summary", params),

  // ── Franchise Settings (markup %, royalty %, per-outlet agreement history) ──
  getFranchiseSettings: (params) => get("/api/franchise-settings", params),
  saveFranchiseSettings: (data) => post("/api/franchise-settings", data),
  deleteFranchiseSettings: (id) => del(`/api/franchise-settings/${id}`),
  patchOutlet: (id, data) => patch(`/api/outlets/${id}`, data),

  // ── PetPooja Recipes ──
  getRecipesPetpooja: () => get("/api/recipes/petpooja"),

  // ── Dish Recipes (editable — Sales x Recipe leakage audit) ──
  getRecipes: (all) => get("/api/recipes", all ? { all: "true" } : {}),
  createRecipe: (data) => post("/api/recipes", data),
  updateRecipe: (id, data) => patch(`/api/recipes/${id}`, data),
  deleteRecipe: (id) => del(`/api/recipes/${id}`),
  addRecipeIngredient: (recipeId, data) => post(`/api/recipes/${recipeId}/ingredients`, data),
  updateRecipeIngredient: (id, data) => patch(`/api/recipes/ingredients/${id}`, data),
  deleteRecipeIngredient: (id) => del(`/api/recipes/ingredients/${id}`),
  getDishCost: (recipeId) => get(`/api/recipes/${recipeId}/cost`),
  getAllDishCosts: () => get("/api/recipes/costs-bulk"),
  getUnitEconomics: () => get("/api/recipes/unit-economics"),

  // ── Orders / Dashboard ──
  getOrders: (params) => get("/api/orders", params),
  getClosingStocks: (params) => get("/api/closing-stocks", params),
  moveSubmissionDate: (data) => post("/api/move-submission-date", data),
  getConsolidated: (date) => get("/api/orders/consolidated", { date }),
  updateOrderStatus: (id, status, notes) => patch(`/api/orders/${id}/status`, { status, dispatch_notes: notes }),
  dispatchOrder: (id, dispatch_items, dispatched_by, remaining_items, items_units) => patch(`/api/orders/${id}/dispatch`, { dispatch_items, dispatched_by, remaining_items, items_units }),
  confirmReceipt: (id, received_items) => patch(`/api/orders/${id}/receive`, { received_items }),
  getChallan: (id) => get(`/api/orders/${id}/challan`),
  getDashboardSummary: (date) => get("/api/orders/dashboard-summary", { date }),

  // ── PetPooja ──
  syncPetpooja: (date) => post("/api/petpooja/sync", { date }),
  getPetpoojaStatus: () => get("/api/petpooja/status"),
  getDailyReviewSummary: (date) => get("/api/petpooja/reviews/daily", { date }),
  saveDailyReviewSummary: (date, rows) => post("/api/petpooja/reviews/daily", { date, rows }),
  getDailyComplaints: (date) => get("/api/petpooja/complaints/daily", { date }),
  saveDailyComplaints: (date, rows) => post("/api/petpooja/complaints/daily", { date, rows }),

  // ── Inventory ──
  getInventory: (params) => get("/api/inventory", params),
  stockIn: (items, reason, submitted_by, po_id) => post("/api/inventory/stock-in", { items, reason, submitted_by, po_id }),
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
  getBkClosingStock: (date) => get(`/api/inventory/closing-stock/${date}`),
  saveBkClosingStock: (date, items, submitted_by) => post("/api/inventory/closing-stock", { date, items, submitted_by }),
  getBkClosingStockRange: (from) => get("/api/inventory/closing-stock", { from }),
  getBkInventoryAudit: (date) => get(`/api/inventory/audit/${date}`),
  getBkAuditFull: (date) => get(`/api/inventory/audit-full/${date}`),
  getStoreAudit: (date) => get(`/api/inventory/store-audit/${date}`),
  // Monthly BK Store Audit — per-item stock-in vs stock-out, out split by BK + each outlet.
  getStoreAuditMonthly: (month) => get(`/api/inventory/store-audit-monthly/${month}`),
  getInventoryLedger: (from, to) => get("/api/inventory/ledger", { from, to }),

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
  recordCashCollection: (data) => patch("/api/outlet-sales/cash-collection", data),

  // ── Staff Demands (Food & Dress) ──
  getStaffDemandItems: () => get("/api/staff-demands/items"),
  getStaffDemands: (params) => get("/api/staff-demands", params),
  submitStaffDemand: (data) => post("/api/staff-demands", data),
  addStaffDemandItem: (data) => post("/api/staff-demands/items", data),
  deleteStaffDemandItem: (id) => del(`/api/staff-demands/items/${id}`),

  // ── Rate Card ──
  getRateCard: () => get("/api/rate-card"),
  // Dated price ledger for one item (challan/purchase/manual/seed changes), newest first.
  getRateCardPriceHistory: (id) => get(`/api/rate-card/${id}/price-history`),
  // Rate Alert spreadsheet — every item with its full dated price series (items × dates).
  getRateCardPriceMatrix: () => get("/api/rate-card/price-matrix"),
  addRate: (data) => post("/api/rate-card", data),
  updateRate: (id, data) => patch(`/api/rate-card/${id}`, data),
  deleteRate: (id) => del(`/api/rate-card/${id}`),

  // ── Crockery/Packaging rule (what's covered by the Sales tab's Packaging/Crockery add-on) ──
  getCrockeryPackagingRules: () => get("/api/crockery-packaging-rules"),
  addCrockeryPackagingRuleItem: (data) => post("/api/crockery-packaging-rules", data),
  deleteCrockeryPackagingRuleItem: (rule_type, item_id) => del(`/api/crockery-packaging-rules?rule_type=${rule_type}&item_id=${item_id}`),

  // ── Fixed Costs ──
  getFixedCosts: (params) => get("/api/fixed-costs", params),
  saveFixedCost: (data) => post("/api/fixed-costs", data),
  deleteFixedCost: (outlet_id, cost_head, month) => del(`/api/fixed-costs?outlet_id=${outlet_id}&cost_head=${cost_head}&month=${month}`),
  getFixedCostHeads: () => get("/api/fixed-cost-heads"),
  addFixedCostHead: (label) => post("/api/fixed-cost-heads", { label }),
  deleteFixedCostHead: (label) => del(`/api/fixed-cost-heads?label=${encodeURIComponent(label)}`),

  // ── Finance — outlet-wise P&L. Two bases: bk_purchase (default, dispatched value at
  // rate-card cost) or consumption (Yesterday Closing + Dispatched − Wastage − Today
  // Closing, same formula RM Audit/Daily P&L use) ──
  getFinanceOutletPnl: (from, to, basis) => get("/api/finance/outlet-pnl", { from, to, basis }),
  // Store Cost tab — total of all vendor challans received into the Store across [from,to],
  // split by category, each expandable to its challans. Sourced from challan line totals.
  getFinanceStoreCost: (from, to) => get("/api/finance/store-cost", { from, to }),
  getFinanceCommissionPct: () => get("/api/finance/commission-pct"),
  setFinanceCommissionPct: (pct) => patch("/api/finance/commission-pct", { pct }),
  getBkPurchaseDetail: (outlet_id, from, to) => get("/api/finance/bk-purchase-detail", { outlet_id, from, to }),
  getConsumptionDetail: (outlet_id, from, to) => get("/api/finance/consumption-detail", { outlet_id, from, to }),
  getMiscDetail: (outlet_id, from, to) => get("/api/finance/misc-detail", { outlet_id, from, to }),

  // ── Live P&L ──
  getLivePnl: (date, outlet) => get(`/api/pnl/live/${date}`, outlet ? { outlet } : {}),
  getStockUsage: (date, outlet) => get(`/api/stock-usage/${date}`, outlet ? { outlet } : {}),
  // Whole month in one request — returns { month, days: [{ date, pnl, stock, audit }] },
  // each day's three payloads identical to getLivePnl/getStockUsage/getRMAudit. Replaces
  // the month view firing 3 calls × ~31 days.
  getPnlMonth: (month, outlet) => get(`/api/pnl/month/${month}`, outlet ? { outlet } : {}),
  getClosingStockDraftAlerts: () => get('/api/closing-stock-draft-alerts'),
  getPunchStatus: (date) => get(`/api/punch-status/${date}`),
  getWastageCost: (from) => get('/api/wastage/cost', { from }),

  // RM Order Config
  getRmOrderConfig: () => get("/api/rm-order-config"),
  saveRmOrderConfig: (items) => post("/api/rm-order-config", { items }),
  getRmUsageSuggestion: () => get("/api/rm-order-config/suggest"),
  // Purchase Orders
  getPurchaseOrders: (params) => get("/api/purchase-orders", params),
  getPurchaseOrder: (id) => get(`/api/purchase-orders/${id}`),
  createPurchaseOrder: (data) => post("/api/purchase-orders", data),
  updatePurchaseOrder: (id, data) => patch(`/api/purchase-orders/${id}`, data),
  deletePurchaseOrder: (id) => del(`/api/purchase-orders/${id}`),
  // System Logs
  getSystemLogs: (params) => get("/api/system-logs", params),
  // History
  getChallanHistory: () => get("/api/history/challans"),
  getDispatchHistory: () => get("/api/history/dispatches"),
  // Paytm Reconciliation
  getPaytmActuals: (month) => get("/api/paytm-actuals", { month }),
  savePaytmActual: (date, outlet_id, actual_amount) => post("/api/paytm-actuals", { date, outlet_id, actual_amount }),
  // Cash Handovers
  getCashHandovers: (params) => get("/api/cash-handovers", params),
  saveCashHandover: (data) => post("/api/cash-handovers", data),
  getCustodianLedger: (name) => get(`/api/cash-handovers/custodian/${encodeURIComponent(name)}`),
  // Books Ledger (Payments › Books)
  getBooksLedger: (params) => get("/api/books", params),
  getBooksAdvances: () => get("/api/books/advances"),
  createBooksEntry: (data) => post("/api/books", data),
  updateBooksEntry: (id, data) => patch(`/api/books/${id}`, data),
  settleBooksAdvance: (id, settled_note) => patch(`/api/books/${id}`, { settled: true, settled_note: settled_note || null }),
  deleteBooksEntry: (id) => del(`/api/books/${id}`),
  // Qty Corrections (owner edit of dispatched/wastage/closing-stock item qty)
  editItemQty: (outlet_id, date, item_id, new_qty, reason, record_type) =>
    patch("/api/qty-edit", { outlet_id, date, item_id, new_qty, reason, record_type }),
  // Batch version — one atomic read-modify-write per date instead of one per cell, so
  // saving many cells for the same date can't race and clobber each other.
  editItemQtyBatch: (outlet_id, date, edits, record_type, reason) =>
    patch("/api/qty-edit-batch", { outlet_id, date, edits, record_type, reason }),
  getCorrections: (params) => get("/api/corrections", params),
  // Owner To Do (sourced from TAC Managers WhatsApp group + manual entries)
  getTodos: (params) => get("/api/todos", params),
  createTodo: (data) => post("/api/todos", data),
  updateTodo: (id, data) => patch(`/api/todos/${id}`, data),
  deleteTodo: (id) => del(`/api/todos/${id}`),
  // Auth
  login: (phone, pin) => post("/api/auth/login", { phone, pin }),
  getUsers: () => get("/api/auth/users"),
  createUser: (data) => post("/api/auth/users", data),
  updateUser: (id, data) => patch(`/api/auth/users/${id}`, data),
  // Employee Master (full staff directory, incl. staff without app login)
  getEmployees: () => get("/api/employees"),
  createEmployee: (data) => post("/api/employees", data),
  updateEmployee: (id, data) => patch(`/api/employees/${id}`, data),
  getAttendance: (params) => get("/api/employees/attendance", params),
  markAttendance: (data) => post("/api/employees/attendance", data),
  deleteAttendance: (id) => del(`/api/employees/attendance/${id}`),
  uploadAttendanceCSV: (file, date) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("date", date);
    return fetch(API + "/api/employees/attendance/bulk", {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error); }); clearCache(); return r.json(); });
  },
  uploadAttendanceCSVMonth: (file, month) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("month", month);
    return fetch(API + "/api/employees/attendance/bulk-month", {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    }).then(r => {
      if (!r.ok) return r.json().then(e => {
        // The "why" (per-row skip reasons — unknown employee, wrong date, etc.) was
        // being computed correctly server-side but silently dropped here, leaving a
        // useless "No matching rows found" with no way to tell why without the raw file
        // — surface a sample of it in the thrown message instead of just e.error.
        const sample = e.skipped?.length ? ` — e.g. ${e.skipped.slice(0, 5).join("; ")}${e.skipped.length > 5 ? ` (+${e.skipped.length - 5} more)` : ""}` : "";
        throw new Error((e.error || "Upload failed") + sample);
      });
      clearCache();
      return r.json();
    });
  },
  giveEmployeeAdvance: (id, data) => post(`/api/employees/${id}/advance`, data),
  getEmployeeAdvances: (id) => get(`/api/employees/${id}/advances`),
  imposeEmployeeFine: (id, data) => post(`/api/employees/${id}/fine`, data),
  getPendingFines: () => get("/api/employees/fines/pending"),
  approveFine: (id) => patch(`/api/employees/fines/${id}/approve`),
  rejectFine: (id, note) => patch(`/api/employees/fines/${id}/reject`, { note }),
  // Employee Profile (particulars + KYC documents)
  getEmployee: (id) => get(`/api/employees/${id}`),
  uploadEmployeeDoc: (id, data) => post(`/api/employees/${id}/documents`, data),
  getEmployeeDocuments: (id) => get(`/api/employees/${id}/documents`),
  // Monthly Payroll
  getPayroll: (month) => get("/api/payroll", { month }),
  setEmployeeOT: (data) => post("/api/payroll/ot", data),
  setPayrollOverride: (data) => patch("/api/payroll/override", data),
  finalizePayroll: (data) => post("/api/payroll/finalize", data),
  reopenPayroll: (data) => post("/api/payroll/reopen", data),

  // ── Store Inventory Module (new item master + stock_movements ledger) ──
  // Separate from the older getInventory()/inventory_items system.
  getStoreStock: (params) => get("/api/store/stock", params),
  getStoreStockMovements: (itemId, location) => get(`/api/store/stock/${itemId}/movements`, location ? { location } : {}),
  getStoreItems: () => get("/api/store/items"),
  addItemUnit: (data) => post("/api/store/item-units", data),
  // Per-vendor display-only unit conversion for the draft challan ("1 Packe = 10 Pcs").
  // Empty vendor_unit clears it. data: { vendor_id, item_id, vendor_unit, factor }
  saveVendorItemUnit: (data) => post("/api/store/vendor-item-units", data),
  getRmOrderSuggestNew: () => get("/api/store/rm-order-suggest"),
  adjustStoreStock: (data) => post("/api/store/adjust", data),
  adjustStoreStockBatch: (data) => post("/api/store/adjust-batch", data),
  saveStoreThresholds: (items) => post("/api/store/thresholds", { items }),

  // Stage 2: vendor challans (receiving) — write flow on top of the same ledger.
  getVendors: () => get("/api/store/vendors"),
  addVendor: (data) => post("/api/store/vendors", data),
  getChallans: (params) => get("/api/store/challans", params),
  getChallan: (id) => get(`/api/store/challans/${id}`),
  createChallan: (data) => post("/api/store/challans", data),
  updateChallan: (id, data) => patch(`/api/store/challans/${id}`, data),
  updateChallanItems: (id, items) => patch(`/api/store/challans/${id}/items`, { items }),
  addChallanItem: (id, item) => post(`/api/store/challans/${id}/items`, item),
  deleteChallanItem: (id, itemId) => del(`/api/store/challans/${id}/items/${itemId}`),
  uploadChallanBill: (id, base64) => post(`/api/store/challans/${id}/bill`, { base64 }),
  receiveChallan: (id) => post(`/api/store/challans/${id}/receive`, {}),
  cancelChallan: (id) => post(`/api/store/challans/${id}/cancel`, {}),
  deleteChallan: (id) => del(`/api/store/challans/${id}`),
  getItemPriceHistory: (itemId) => get(`/api/store/items/${itemId}/price-history`),

  // Stage 4: blind closing count -> audit/variance -> owner rollup.
  startStockCount: (data) => post("/api/store/counts", data),
  getStockCounts: (params) => get("/api/store/counts", params),
  getStockCount: (id) => get(`/api/store/counts/${id}`),
  saveStockCountItems: (id, items) => patch(`/api/store/counts/${id}/items`, { items }),
  submitStockCount: (id) => post(`/api/store/counts/${id}/submit`, {}),
  cancelStockCount: (id) => post(`/api/store/counts/${id}/cancel`, {}),
  getVarianceRollup: (params) => get("/api/store/variance-rollup", params),

  // Stage 5: BK production stock-in (recipe outputs, e.g. sambhar/batters/chutneys).
  getProductionRecipes: () => get("/api/store/production/recipes"),
  recordProduction: (data) => post("/api/store/production", data),
  getProductionRuns: (params) => get("/api/store/production", params),

  // Stage 5 course-correction: Store-only ledger-vs-real-count history.
  getStoreLedgerHistory: () => get("/api/store/store-ledger-history"),
};

// ── Helpers ──
async function get(path, params = {}) {
  const url = new URL(API + path);
  // Guard: if params is a string (e.g. a date), wrap it as { date: params }
  const safeParams = typeof params === "string" ? { date: params } : params;
  // Sort params so {a,b} and {b,a} produce the same cache key (and the same URL).
  const entries = Object.entries(safeParams)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  entries.forEach(([k, v]) => url.searchParams.set(k, v));
  const urlStr = url.toString();
  const key = cacheNs() + urlStr;
  const ttl = ttlFor(path);
  const now = Date.now();

  // 1. Fresh in-memory hit → instant, no network.
  const mem = memCache.get(key);
  if (mem && now - mem.ts < ttl) return clone(mem.data);

  // 2. Fresh persisted hit (survives refresh / Back within the tab) → hydrate + instant.
  if (!mem) {
    const persisted = readPersisted(key);
    if (persisted && now - persisted.ts < ttl) {
      memCache.set(key, persisted);
      return clone(persisted.data);
    }
  }

  // 3. Collapse an identical in-flight request instead of firing a duplicate.
  if (inflight.has(key)) return clone(await inflight.get(key));

  const p = (async () => {
    const res = await fetch(urlStr, { headers: authHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `GET ${path} failed: ${res.status}`);
    }
    const data = await res.json();
    const entry = { data, ts: Date.now() };
    memCache.set(key, entry);
    let serialized = null;
    try { serialized = JSON.stringify(entry); } catch (e) { /* non-serializable → mem-only */ }
    writePersisted(key, serialized);
    return data;
  })();
  inflight.set(key, p);
  try { return clone(await p); }
  finally { inflight.delete(key); }
}

// Every mutation clears the whole cache so the next reads are guaranteed fresh — see the
// cache-module comment above for why nuke-all over scoped invalidation.
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
  clearCache();
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
  clearCache();
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
  clearCache();
  return res.json();
}

// Exposed so the app can bust the cache on login/logout (App.jsx auth seams).
api.clearCache = clearCache;

export default api;
