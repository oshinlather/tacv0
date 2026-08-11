// authGuards.js — Simple role-based access control for Ananda Cafe backend
//
// Usage inside a route handler:
//
//   router.get('/sensitive-route', async (req, res) => {
//     if (!await requireOwner(req, res)) return;  // blocks non-owners
//     // ... rest of route
//   });
//
//   router.post('/outlet-scoped', async (req, res) => {
//     const user = await requireAuth(req, res);
//     if (!user) return;
//     if (!ensureOutletAccess(user, req.body.outlet_id, res)) return;
//     // ... rest of route
//   });
//
// Every request from the frontend should include header `x-user-id` with the
// logged-in user's UUID. We look them up fresh from the DB (no trust in the
// header alone — the DB is the source of truth for role + active status).

const supabase = require('../supabase');

// In-memory cache to avoid hitting Supabase on every request.
// Invalidated after 30s per user. Keeps role changes fresh-ish without the
// latency of a DB lookup on every call.
const userCache = new Map(); // id -> { user, expires }
const CACHE_TTL_MS = 30_000;

async function fetchUser(userId) {
  const cached = userCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.user;

  const { data, error } = await supabase
    .from('app_users')
    .select('id, name, role, outlet_id, active')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  userCache.set(userId, { user: data, expires: Date.now() + CACHE_TTL_MS });
  return data;
}

// Returns the logged-in user object, or sends a 401 response and returns null.
async function requireAuth(req, res) {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    res.status(401).json({ error: 'Login required' });
    return null;
  }
  const user = await fetchUser(userId);
  if (!user || !user.active) {
    res.status(401).json({ error: 'Invalid or inactive user' });
    return null;
  }
  return user;
}

// Returns true if user is owner, otherwise sends 403 and returns false.
async function requireOwner(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return false;
  if (user.role !== 'owner') {
    res.status(403).json({ error: 'Owners only' });
    return false;
  }
  return true;
}

// Returns the user object if their role is in allowedRoles, otherwise sends 403 and
// returns false. (Returns the user, not just `true`, so callers that need it — e.g. to
// force-scope a query to the caller's own outlet — don't have to look it up twice. Every
// existing `if (!await requireRole(...)) return;` call site still works unchanged since
// a user object is truthy.)
async function requireRole(req, res, ...allowedRoles) {
  const user = await requireAuth(req, res);
  if (!user) return false;
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return false;
  }
  return user;
}

// For routes that return/modify outlet data: outlet_mgr, chef, and bainmarry can only
// touch their own outlet (chef/bainmarry punch category-scoped demand/wastage/closing
// stock for one outlet, same as outlet_mgr). franchise is read-only (see route-level
// requireRole checks) but scoped the same way defensively. Owner and store_mgr are
// unrestricted. Call this AFTER requireAuth has returned a user.
// Returns true if access OK, else sends 403 and returns false.
const OUTLET_SCOPED_ROLES = ['outlet_mgr', 'chef', 'bainmarry', 'franchise'];
function ensureOutletAccess(user, requestedOutletId, res) {
  if (!OUTLET_SCOPED_ROLES.includes(user.role)) return true; // owner & store_mgr unrestricted
  if (!requestedOutletId) return true; // no outlet specified; caller handles
  if (requestedOutletId !== user.outlet_id) {
    res.status(403).json({ error: "Cannot access another outlet's data" });
    return false;
  }
  return true;
}

// For read endpoints that accept an optional ?outlet= filter (P&L, RM Audit, stock
// usage): franchise is confined to their own outlet_id no matter what the client sends
// — the query param is only ever advisory for owner/avp/head_chef, who may legitimately
// ask for 'all' or another outlet. Same OUTLET_SCOPED_ROLES list as ensureOutletAccess,
// but resolves to a value instead of a pass/fail.
function scopedOutletFilter(user, requestedOutlet) {
  return OUTLET_SCOPED_ROLES.includes(user.role) ? user.outlet_id : requestedOutlet;
}

// Clears the cache for a specific user. Call when a user's role is changed.
function invalidateUser(userId) {
  userCache.delete(userId);
}

// Chef/Bainmarry are gated to a subset of DEMAND_SECTIONS' categories in the frontend
// (App.jsx's CATEGORY_SCOPE) — Chef gets food/vegetable/masala/grocery, Bainmarry gets
// packaging, everything else (Dairy/Cleaning/Gas included) stays Outlet Manager-only.
// Mirrored here so the restriction is also enforced server-side, not just by what the
// React UI chooses to send.
const CATEGORY_SCOPE = {
  chef: ['food', 'vegetable', 'masala', 'grocery'],
  bainmarry: ['packaging'],
};

// Cold Drink & Water is a real DEMAND_SECTIONS section in App.jsx (frontend-only —
// BK doesn't stock/dispatch it, so it was never added to the demand_items/
// demand_sections DB tables) but it DOES appear in Closing Stock and Wastage. Without
// this, getDemandItemSectionMap() below can never resolve any item to 'cold_drink' —
// which meant the Performance Dashboard's Punch Score could never award its Closing —
// Cold Drink sub-weight (7.5%) to ANY outlet on ANY day, regardless of what was
// actually submitted. Mirrors COLD_DRINK_ITEMS in salesRoutes.js (same reason that one
// is duplicated from the frontend rather than DB-sourced) — keep both in sync if the
// physical item list ever changes.
const COLD_DRINK_SECTION_IDS = ['cold_drink', 'diet_coke', 'small_water_bottle', 'water_bottle_1l'];

// demand_items.section_id lookup, cached briefly — small table (~150 rows), but no
// need to hit it on every draft/closing-stock save.
let demandItemSectionCache = null; // { map, expires }
const SECTION_CACHE_TTL_MS = 60_000;
async function getDemandItemSectionMap() {
  if (demandItemSectionCache && demandItemSectionCache.expires > Date.now()) return demandItemSectionCache.map;
  const { data } = await supabase.from('demand_items').select('id, section_id');
  const map = {};
  (data || []).forEach((d) => { map[d.id] = d.section_id; });
  COLD_DRINK_SECTION_IDS.forEach((id) => { map[id] = 'cold_drink'; });
  demandItemSectionCache = { map, expires: Date.now() + SECTION_CACHE_TTL_MS };
  return map;
}

// Server-side backstop for Chef/Bainmarry's category gating: drops any item whose
// known category (via demand_items.section_id) falls outside the role's CATEGORY_SCOPE,
// so a direct API call can't write to a category the UI wouldn't have shown. Roles
// without a CATEGORY_SCOPE entry (owner/store_mgr/outlet_mgr) are unrestricted. Items
// missing from the catalog are passed through unchanged — demand_items isn't perfectly
// in sync with the frontend's item list, so treating "unknown" as in-scope avoids
// rejecting a legitimate save over catalog drift. `idPrefix` strips a prefix (e.g. "cs_"
// for closing stock item keys) before the lookup.
async function filterItemsToRoleScope(role, items, idPrefix = '') {
  const scope = CATEGORY_SCOPE[role];
  if (!scope || !items) return items;
  const sectionMap = await getDemandItemSectionMap();
  return Object.fromEntries(Object.entries(items).filter(([key]) => {
    const bareId = idPrefix && key.startsWith(idPrefix) ? key.slice(idPrefix.length) : key;
    const section = sectionMap[bareId];
    return !section || scope.includes(section);
  }));
}

module.exports = {
  requireAuth,
  requireOwner,
  requireRole,
  ensureOutletAccess,
  scopedOutletFilter,
  invalidateUser,
  filterItemsToRoleScope,
  getDemandItemSectionMap,
};
