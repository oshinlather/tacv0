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

// Returns true if user role is in allowedRoles, otherwise 403.
async function requireRole(req, res, ...allowedRoles) {
  const user = await requireAuth(req, res);
  if (!user) return false;
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return false;
  }
  return true;
}

// For routes that return/modify outlet data: outlet_mgr can only touch their
// own outlet. Owner and store_mgr are unrestricted.
// Call this AFTER requireAuth has returned a user.
// Returns true if access OK, else sends 403 and returns false.
function ensureOutletAccess(user, requestedOutletId, res) {
  if (user.role !== 'outlet_mgr') return true; // owner & store_mgr unrestricted
  if (!requestedOutletId) return true; // no outlet specified; caller handles
  if (requestedOutletId !== user.outlet_id) {
    res.status(403).json({ error: "Cannot access another outlet's data" });
    return false;
  }
  return true;
}

// Clears the cache for a specific user. Call when a user's role is changed.
function invalidateUser(userId) {
  userCache.delete(userId);
}

module.exports = {
  requireAuth,
  requireOwner,
  requireRole,
  ensureOutletAccess,
  invalidateUser,
};
