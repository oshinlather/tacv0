// Finance module — starts with one view: outlet-wise P&L, all 6 outlets side by side
// for a date range (typically a whole month, to match how Rent/Salary/etc. are actually
// billed).
//   Effective Sale = Total Sale − Delivery Commission (editable %, default 40%)
//   − BK Purchase / Consumption — the one material-cost figure the whole formula pivots
//     on, picked per-request via ?basis=bk_purchase (default) or ?basis=consumption:
//       bk_purchase: what was actually DISPATCHED from Base Kitchen this period, priced
//         at rate card / BK-recipe cost. Deliberately simpler than Daily P&L's own
//         figure — the owner's own framing: "i dont want to focus on closing and
//         wastage, its simple what was total ordered from base kitchen".
//       consumption: Yesterday Closing + Dispatched − Wastage − Today Closing, the
//         same "actual consumption" formula RM Audit/Daily P&L use
//         (computeStockUsageForDate), summed day by day across the range. A second
//         pill next to bk_purchase — same table shape, same columns, this one figure
//         (and everything downstream of it) computed the rigorous way instead.
//     Response field names stay bk_purchase/bk_fixed_share either way — `basis` in the
//     response says which one actually populated them.
//   − Wastage (Consumption basis only) — the formula above already subtracts wastage
//     OUT of what counts as material cost, so without adding it back as its own line
//     it would vanish from the P&L instead of showing up as a real expense (verified
//     against real data: material that was bought and thrown away, not reflected
//     anywhere). Zero under bk_purchase basis, which stays the owner's own
//     deliberately simplified view — see computeWastageCostByOutlet.
//   − BK Fixed Cost Share (Base Kitchen's OWN rent/salary/etc — outlet_id='bk' rows in
//     fixed_costs — prorated across the range same as every other fixed cost, then split
//     across outlets proportional to each outlet's BK Purchase/Consumption above
//     (whichever basis is active), not split equally. An outlet that bought/consumed
//     nothing this period carries none of BK's fixed cost; an outlet that bought/
//     consumed more carries more. Falls back to an equal split only when the total
//     across every outlet is zero — nothing to prorate against.)
//   − Rent, Salary, Electricity, GST, Misc (from the same fixed_costs table FixedCostsPanel
//     already writes to — this view pivots those rows into named columns and prorates each
//     row's monthly amount across the selected range). Misc is every cost head that isn't
//     one of the four named ones — Transport, Water, Internet, Mala Decoration, Staff Room
//     Rent, Waste Collection, and anything else configured in FixedCostsPanel — nothing
//     silently excluded from the P&L; Misc expands (see /misc-detail) to show exactly which
//     heads make it up and how much each contributed, same drill-down as BK Purchase.
//   = Net P&L
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireRole } = require("./authGuards");
const { computeDailySalesRevenue, buildCostingContext, computeBkPurchaseByOutlet, computeBkPurchaseDetail, resolveFixedCostsForMonth, computeStockUsageForDate } = require("./salesRoutes");

const OUTLET_IDS = ["sec23", "sec31", "sec56", "sec14", "elan", "gaursid"];

function daysInMonthOf(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
function daysInRange(from, to) {
  const days = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return days;
}
// Prorated total for one (outlet_id, cost_head) across [from, to] — each day resolves
// THAT DAY'S month's applicable amount independently via resolveFixedCostsForMonth
// (walking back to the latest entry at-or-before that month, same rule FixedCostsPanel
// itself displays), instead of blindly prorating whatever the CURRENT value happens to
// be. So viewing July's P&L after August's electricity bill was entered still uses
// July's real figure, not August's, and a range that straddles a month boundary uses
// each side's own value. `allRows` is fetched ONCE per request (full history, every
// month) — resolveFixedCostsForMonth is a pure in-memory walk-back, no extra queries.
function proratedFixedCost(allRows, outletId, costHead, from, to) {
  let total = 0;
  const monthCache = {};
  daysInRange(from, to).forEach((ds) => {
    const month = ds.slice(0, 7);
    if (!monthCache[month]) {
      const map = {};
      resolveFixedCostsForMonth(allRows, month).forEach((r) => { map[`${r.outlet_id}|${r.cost_head}`] = r; });
      monthCache[month] = map;
    }
    const row = monthCache[month][`${outletId}|${costHead}`];
    if (row) total += Number(row.amount || 0) / daysInMonthOf(ds);
  });
  return total;
}

// cost_head → named P&L column. Anything not listed here (Transport, Water, Internet,
// Mala Decoration, Staff Room Rent, Waste Collection, the "misc" head itself, or any
// future head added via FixedCostsPanel) rolls into Misc — the owner asked for exactly
// these 5 expense columns, not one column per configured head. Every head that lands in
// Misc is still fully visible via GET /misc-detail's per-head breakdown below.
const FIXED_HEAD_BUCKET = { rent: "rent", salary: "salary", electricity: "electricity", gst: "gst" };

// computeBkPurchaseByOutlet now lives in salesRoutes.js (exported alongside
// computeDailySalesRevenue/buildCostingContext) so /pnl/live's per-outlet cards can
// reuse the exact same "what did we actually order from Base Kitchen" figure instead
// of a second, possibly-drifting copy — see the comment there for the full formula.

// Firing every day in a month at computeStockUsageForDate via a single unbounded
// Promise.all measured 17-42s for just 14 days in practice (each day is itself an
// 8-query Promise.all, so a whole month can burst 150-250 concurrent outbound Supabase
// calls at once) — 14 SEPARATE HTTP requests hitting the same endpoint one-per-day
// concurrently measured ~9s for the identical work, so the bottleneck is bursting too
// much at once in a single Node tick, not the total work. This caps how many days run
// concurrently at a time instead.
const DAY_BATCH_CONCURRENCY = 5;
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Consumption basis (the second Finance pill) — Yesterday Closing + Dispatched −
// Wastage − Today Closing, the same "actual consumption" formula Daily P&L/RM Audit
// use (computeStockUsageForDate), which the owner deliberately set aside for BK
// Purchase's simpler "what was ordered" figure above. Inherently a per-day formula
// (needs that day's own opening/closing pair) — summed day by day, matching exactly
// how DailyPnL's own month view already sums its per-day stock-usage calls, rather
// than a range-level shortcut (verified those aren't the same number — see
// computeStockUsageForDate's own comment for why). costingContext is reused across
// every day instead of rebuilt each time. outlet=null pulls every outlet in one call
// per day (cheaper than 6 single-outlet calls per day for the whole-table figure).
async function computeConsumptionByOutlet(from, to, costingContext) {
  const byOutlet = {};
  const dayResults = await mapWithConcurrency(daysInRange(from, to), DAY_BATCH_CONCURRENCY, (ds) => computeStockUsageForDate(ds, null, costingContext));
  dayResults.forEach(({ outlets }) => {
    (outlets || []).forEach((o) => {
      if (o.outlet_id === "all" || o.outlet_id === "bk") return;
      byOutlet[o.outlet_id] = (byOutlet[o.outlet_id] || 0) + (o.total_used_cost || 0);
    });
  });
  return byOutlet;
}

// Item x date breakdown for the Consumption pill's drill-down — same {dates, items}
// shape computeBkPurchaseDetail returns, so the frontend's existing drill-down
// rendering works unchanged regardless of which basis is active. Scoped to one outlet
// per call (computeStockUsageForDate's own outlet filter), cheaper than pulling all 6
// and discarding 5.
async function computeConsumptionDetail(outletId, from, to, costingContext) {
  const dates = daysInRange(from, to);
  const dayResults = await mapWithConcurrency(dates, DAY_BATCH_CONCURRENCY, (ds) => computeStockUsageForDate(ds, outletId, costingContext));
  const itemsById = {};
  dayResults.forEach(({ outlets }, i) => {
    const ds = dates[i];
    const row = (outlets || []).find((o) => o.outlet_id === outletId);
    (row?.items || []).forEach((it) => {
      if (!it.used) return;
      if (!itemsById[it.item_id]) itemsById[it.item_id] = { item_id: it.item_id, name: it.name, unit: it.unit, byDate: {}, total_qty: 0, total_amount: 0 };
      const bucket = itemsById[it.item_id];
      bucket.byDate[ds] = { qty: it.used, amount: it.used_cost };
      bucket.total_qty += it.used;
      bucket.total_amount += it.used_cost;
    });
  });
  const items = Object.values(itemsById).map((it) => ({
    ...it,
    total_qty: Math.round(it.total_qty * 1000) / 1000,
    total_amount: Math.round(it.total_amount * 100) / 100,
  })).sort((a, b) => b.total_amount - a.total_amount);
  return { dates, items };
}

// Wastage is real money spent on material that never made it into anything sold —
// Consumption's own formula (Opening + Dispatched − Wastage − Closing) SUBTRACTS
// wastage out of what counts as "used", which means without this it silently
// disappears from the P&L entirely instead of showing up as a cost anywhere (verified
// against real data: one outlet, 14 days, ₹14,070 of wastage cost with nowhere in the
// table to see it, Net P&L overstated by exactly that). Added ONLY to Consumption basis
// — BK Purchase stays the owner's own deliberately simplified "don't focus on closing
// and wastage" view, unchanged. Same rate-card-first/BK-recipe-fallback costing as
// GET /wastage/cost (the Performance Dashboard's own Wastage card), just summed over
// the range in one query instead of per-day — wastage doesn't need
// computeStockUsageForDate's opening/closing pairing, it's a flat sum either way.
async function computeWastageCostByOutlet(from, to, costingContext) {
  const { rateMap, bkRecipeMap, convFactorFor } = costingContext;
  const { data: wastageRows, error } = await supabase.from("demands").select("outlet_id, items, items_units").eq("type", "wastage").gte("date", from).lte("date", to);
  if (error) throw error;
  const byOutlet = {};
  (wastageRows || []).forEach((row) => {
    let cost = 0;
    Object.entries(row.items || {}).forEach(([itemId, qty]) => {
      const q = Number(qty) || 0;
      if (q <= 0) return;
      const rate = rateMap[itemId];
      const bkRecipe = bkRecipeMap[itemId];
      const rawUnit = (row.items_units || {})[itemId] || null;
      if (rate) {
        cost += q * convFactorFor(itemId, rawUnit, rate.unit) * Number(rate.price);
      } else if (bkRecipe) {
        cost += q * convFactorFor(itemId, rawUnit, "Kg") * bkRecipe.costPerKg;
      }
    });
    byOutlet[row.outlet_id] = (byOutlet[row.outlet_id] || 0) + cost;
  });
  return byOutlet;
}

// ── GET /api/finance/commission-pct — the single editable delivery-commission rate
// (Swiggy/Zomato charge ~40%; kept editable since aggregators renegotiate this).
router.get("/commission-pct", async (req, res) => {
  const user = await requireRole(req, res, "owner", "avp", "head_chef");
  if (!user) return;
  const { data } = await supabase.from("app_config").select("value").eq("key", "delivery_commission_pct").maybeSingle();
  res.json({ pct: data?.value ? Number(JSON.parse(data.value)) : 40 });
});

router.patch("/commission-pct", async (req, res) => {
  if (!await requireRole(req, res, "owner")) return;
  const pct = Number(req.body.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: "pct must be a number between 0 and 100" });
  const { error } = await supabase.from("app_config").upsert({ key: "delivery_commission_pct", value: JSON.stringify(pct) }, { onConflict: "key" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ pct });
});

// ── GET /api/finance/outlet-pnl?from=&to=&basis=bk_purchase|consumption — all 6
// outlets, one row each. `basis` (default bk_purchase) picks which material-cost
// figure drives BK Purchase/BK Fixed Share and therefore Total Expense/Net P&L/
// Margin — everything else (revenue, Rent/Salary/Electricity/GST/Misc) is identical
// either way. The field names in the response stay bk_purchase/bk_fixed_share
// regardless of basis (so the frontend's existing rendering/drill-down code works
// unchanged for both) — `basis` is echoed back in the response so the UI knows which
// one it's showing.
router.get("/outlet-pnl", async (req, res) => {
  try {
    const user = await requireRole(req, res, "owner", "avp", "head_chef");
    if (!user) return;
    const { from, to } = req.query;
    const basis = req.query.basis === "consumption" ? "consumption" : "bk_purchase";
    if (!from || !to) return res.status(400).json({ error: "from and to are required" });

    const [{ data: commissionCfg }, salesByOutlet, costingContext, { data: fixedCostRows }] = await Promise.all([
      supabase.from("app_config").select("value").eq("key", "delivery_commission_pct").maybeSingle(),
      computeDailySalesRevenue({ from, to }),
      buildCostingContext(),
      // Full history (every month, not just ones inside [from,to]) — proratedFixedCost
      // needs to walk back to whatever month a head was last actually set in, which can
      // be well before the range being viewed (e.g. Rent set once in April, still
      // applies in August). Fetch BK's own rows (outlet_id='bk') alongside the 6
      // outlets' too, same as before.
      supabase.from("fixed_costs").select("*").eq("active", true).in("outlet_id", [...OUTLET_IDS, "bk"]),
    ]);
    const commissionPct = commissionCfg?.value ? Number(JSON.parse(commissionCfg.value)) : 40;
    const materialCostByOutlet = basis === "consumption"
      ? await computeConsumptionByOutlet(from, to, costingContext)
      : await computeBkPurchaseByOutlet(from, to, costingContext);
    // Wastage — only meaningful alongside Consumption (BK Purchase stays the owner's own
    // deliberately simplified view; see computeWastageCostByOutlet's comment). Consumption's
    // own formula already subtracts wastage OUT of what counts as material cost, so without
    // adding it back as its own line it would vanish from the P&L entirely instead of
    // showing up as a real expense.
    const wastageByOutlet = basis === "consumption" ? await computeWastageCostByOutlet(from, to, costingContext) : {};

    const round = (n) => Math.round(n || 0);

    // BK's own fixed cost, prorated across [from, to] — resolved per month like every
    // other fixed cost below, then divided proportionally by each outlet's material-cost
    // share (BK Purchase or Consumption, whichever basis is active) — an outlet that
    // bought/consumed nothing this period carries none of BK's fixed cost either way.
    const bkHeads = new Set((fixedCostRows || []).filter((f) => f.outlet_id === "bk").map((f) => f.cost_head));
    const bkFixedTotalProrated = [...bkHeads].reduce((s, head) => s + proratedFixedCost(fixedCostRows, "bk", head, from, to), 0);
    const totalMaterialCostAllOutlets = OUTLET_IDS.reduce((s, oid) => s + (materialCostByOutlet[oid] || 0), 0);
    const outlets = OUTLET_IDS.map((oid) => {
      const sales = salesByOutlet[oid] || {};
      const swiggy = Number(sales.swiggy_sale || 0);
      const zomato = Number(sales.zomato_sale || 0);
      const otherDelivery = Number(sales.other_delivery_sale || 0);
      const storeSale = Number(sales.store_sale || 0);
      const complimentary = Number(sales.complimentary_amount || 0);
      const totalSale = Number(sales.total_sale || 0);
      const deliverySale = swiggy + zomato + otherDelivery;
      // Commission only applies to the two aggregators (Swiggy/Zomato take a cut;
      // "other_delivery" — e.g. own-rider delivery — doesn't), same convention pnl/live
      // already uses.
      const deliveryCommission = round((swiggy + zomato) * (commissionPct / 100));
      const netDeliverySale = round((swiggy + zomato) * (1 - commissionPct / 100)) + otherDelivery;
      const effectiveSale = round(storeSale + netDeliverySale - complimentary);

      const bkPurchase = round(materialCostByOutlet[oid] || 0);
      const wastage = round(wastageByOutlet[oid] || 0);
      const bkFixedShare = round(totalMaterialCostAllOutlets > 0
        ? bkFixedTotalProrated * (materialCostByOutlet[oid] || 0) / totalMaterialCostAllOutlets
        : bkFixedTotalProrated / OUTLET_IDS.length);

      const fixed = { rent: 0, salary: 0, electricity: 0, gst: 0, misc: 0 };
      const outletHeads = new Set((fixedCostRows || []).filter((f) => f.outlet_id === oid).map((f) => f.cost_head));
      outletHeads.forEach((head) => {
        const bucket = FIXED_HEAD_BUCKET[(head || "").toLowerCase()] || "misc";
        fixed[bucket] += proratedFixedCost(fixedCostRows, oid, head, from, to);
      });
      Object.keys(fixed).forEach((k) => { fixed[k] = round(fixed[k]); });
      const totalFixed = Object.values(fixed).reduce((s, v) => s + v, 0);

      const totalExpense = bkPurchase + wastage + bkFixedShare + totalFixed;
      const netPnl = round(effectiveSale - totalExpense);
      const marginPct = effectiveSale > 0 ? Math.round((netPnl / effectiveSale) * 1000) / 10 : null;

      return {
        outlet_id: oid,
        total_sale: round(totalSale), delivery_sale: round(deliverySale),
        delivery_commission: deliveryCommission, effective_sale: effectiveSale,
        bk_purchase: bkPurchase, wastage, bk_fixed_share: bkFixedShare, ...fixed,
        total_expense: round(totalExpense), net_pnl: netPnl, margin_pct: marginPct,
      };
    });

    const SUM_KEYS = ["total_sale", "delivery_sale", "delivery_commission", "effective_sale", "bk_purchase", "wastage", "bk_fixed_share", "rent", "salary", "electricity", "gst", "misc", "total_expense", "net_pnl"];
    const totals = { outlet_id: "all" };
    SUM_KEYS.forEach((k) => { totals[k] = round(outlets.reduce((s, o) => s + o[k], 0)); });
    totals.margin_pct = totals.effective_sale > 0 ? Math.round((totals.net_pnl / totals.effective_sale) * 1000) / 10 : null;

    res.json({ from, to, basis, commission_pct: commissionPct, outlets, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/finance/bk-purchase-detail?outlet_id=&from=&to= — the BK Purchase column's
// drill-down: every item dispatched from Base Kitchen to this one outlet across the range,
// broken out day by day. Same pricing basis as the summed figure above (see
// computeBkPurchaseDetail), so the two always reconcile.
router.get("/bk-purchase-detail", async (req, res) => {
  try {
    const user = await requireRole(req, res, "owner", "avp", "head_chef");
    if (!user) return;
    const { outlet_id, from, to } = req.query;
    if (!outlet_id || !from || !to) return res.status(400).json({ error: "outlet_id, from, and to are required" });
    if (!OUTLET_IDS.includes(outlet_id)) return res.status(400).json({ error: "Invalid outlet_id" });

    const costingContext = await buildCostingContext();
    const detail = await computeBkPurchaseDetail(outlet_id, from, to, costingContext);
    res.json({ outlet_id, from, to, ...detail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/finance/consumption-detail?outlet_id=&from=&to= — the Consumption
// pill's drill-down, same idea as bk-purchase-detail above but for the actual-
// consumption basis (see computeConsumptionDetail): every item consumed by this one
// outlet across the range, broken out day by day.
router.get("/consumption-detail", async (req, res) => {
  try {
    const user = await requireRole(req, res, "owner", "avp", "head_chef");
    if (!user) return;
    const { outlet_id, from, to } = req.query;
    if (!outlet_id || !from || !to) return res.status(400).json({ error: "outlet_id, from, and to are required" });
    if (!OUTLET_IDS.includes(outlet_id)) return res.status(400).json({ error: "Invalid outlet_id" });

    const costingContext = await buildCostingContext();
    const detail = await computeConsumptionDetail(outlet_id, from, to, costingContext);
    res.json({ outlet_id, from, to, ...detail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/finance/misc-detail?outlet_id=&from=&to= — the Misc column's drill-down:
// every cost head that isn't Rent/Salary/Electricity/GST (Transport, Water, Internet,
// Mala Decoration, Staff Room Rent, Waste Collection, etc.), each prorated across the
// range the same way as every other fixed cost above — so the sum of these always equals
// the outlet's Misc figure in /outlet-pnl. Heads that resolve to ₹0 for this range (never
// configured, or configured only for months outside it) are omitted.
router.get("/misc-detail", async (req, res) => {
  try {
    const user = await requireRole(req, res, "owner", "avp", "head_chef");
    if (!user) return;
    const { outlet_id, from, to } = req.query;
    if (!outlet_id || !from || !to) return res.status(400).json({ error: "outlet_id, from, and to are required" });
    if (!OUTLET_IDS.includes(outlet_id)) return res.status(400).json({ error: "Invalid outlet_id" });

    const { data: fixedCostRows, error } = await supabase.from("fixed_costs").select("*").eq("active", true).eq("outlet_id", outlet_id);
    if (error) throw error;

    const round = (n) => Math.round(n || 0);
    const explicitHeads = new Set(Object.keys(FIXED_HEAD_BUCKET));
    const headLabel = {};
    (fixedCostRows || []).forEach((r) => { headLabel[r.cost_head] = r.label || r.cost_head; });
    const miscHeads = [...new Set((fixedCostRows || []).map((f) => f.cost_head))].filter((head) => !explicitHeads.has((head || "").toLowerCase()));

    // Sum the RAW (unrounded) per-head amounts first, then round once — same order
    // /outlet-pnl's own misc figure uses (accumulate floats into `fixed.misc`, round at
    // the very end) — rounding each head individually before summing would drift a rupee
    // or two off that figure, breaking the "these two numbers always reconcile" promise.
    const rawItems = miscHeads.map((head) => ({ cost_head: head, label: headLabel[head] || head, raw: proratedFixedCost(fixedCostRows, outlet_id, head, from, to) }));
    const total = round(rawItems.reduce((s, it) => s + it.raw, 0));
    const items = rawItems
      .map((it) => ({ cost_head: it.cost_head, label: it.label, amount: round(it.raw) }))
      .filter((it) => it.amount !== 0)
      .sort((a, b) => b.amount - a.amount);

    res.json({ outlet_id, from, to, items, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
