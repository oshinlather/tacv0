// Finance module — starts with one view: outlet-wise P&L, all 6 outlets side by side
// for a date range (typically a whole month, to match how Rent/Salary/etc. are actually
// billed). Deliberately simpler than the day-by-day Daily P&L (DailyPnL/pnl/live):
//   Effective Sale = Total Sale − Delivery Commission (editable %, default 40%)
//   − BK Purchase (what was actually DISPATCHED from Base Kitchen this period, priced at
//     rate card / BK-recipe cost — NOT the Yesterday Closing + Dispatched − Wastage −
//     Today Closing "actual consumption" formula RM Audit/Daily P&L use. The owner asked
//     for this specific simplification: "i dont want to focus on closing and wastage,
//     its simple what was total ordered from base kitchen".)
//   − BK Fixed Cost Share (Base Kitchen's OWN rent/salary/etc — outlet_id='bk' rows in
//     fixed_costs — prorated across the range same as every other fixed cost, then split
//     across outlets proportional to each outlet's BK Purchase above, not split equally.
//     An outlet that bought nothing from BK this period carries none of BK's fixed cost;
//     an outlet that bought more carries more. Falls back to an equal split only when
//     total BK Purchase across every outlet is zero — nothing to prorate against.)
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
const { computeDailySalesRevenue, buildCostingContext, computeBkPurchaseByOutlet, computeBkPurchaseDetail, resolveFixedCostsForMonth } = require("./salesRoutes");

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

// ── GET /api/finance/outlet-pnl?from=&to= — all 6 outlets, one row each.
router.get("/outlet-pnl", async (req, res) => {
  try {
    const user = await requireRole(req, res, "owner", "avp", "head_chef");
    if (!user) return;
    const { from, to } = req.query;
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
    const bkPurchaseByOutlet = await computeBkPurchaseByOutlet(from, to, costingContext);

    const round = (n) => Math.round(n || 0);

    // BK's own fixed cost, prorated across [from, to] — resolved per month like every
    // other fixed cost below, then divided proportionally by each outlet's BK Purchase
    // share.
    const bkHeads = new Set((fixedCostRows || []).filter((f) => f.outlet_id === "bk").map((f) => f.cost_head));
    const bkFixedTotalProrated = [...bkHeads].reduce((s, head) => s + proratedFixedCost(fixedCostRows, "bk", head, from, to), 0);
    const totalBkPurchaseAllOutlets = OUTLET_IDS.reduce((s, oid) => s + (bkPurchaseByOutlet[oid] || 0), 0);
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

      const bkPurchase = round(bkPurchaseByOutlet[oid] || 0);
      const bkFixedShare = round(totalBkPurchaseAllOutlets > 0
        ? bkFixedTotalProrated * (bkPurchaseByOutlet[oid] || 0) / totalBkPurchaseAllOutlets
        : bkFixedTotalProrated / OUTLET_IDS.length);

      const fixed = { rent: 0, salary: 0, electricity: 0, gst: 0, misc: 0 };
      const outletHeads = new Set((fixedCostRows || []).filter((f) => f.outlet_id === oid).map((f) => f.cost_head));
      outletHeads.forEach((head) => {
        const bucket = FIXED_HEAD_BUCKET[(head || "").toLowerCase()] || "misc";
        fixed[bucket] += proratedFixedCost(fixedCostRows, oid, head, from, to);
      });
      Object.keys(fixed).forEach((k) => { fixed[k] = round(fixed[k]); });
      const totalFixed = Object.values(fixed).reduce((s, v) => s + v, 0);

      const totalExpense = bkPurchase + bkFixedShare + totalFixed;
      const netPnl = round(effectiveSale - totalExpense);
      const marginPct = effectiveSale > 0 ? Math.round((netPnl / effectiveSale) * 1000) / 10 : null;

      return {
        outlet_id: oid,
        total_sale: round(totalSale), delivery_sale: round(deliverySale),
        delivery_commission: deliveryCommission, effective_sale: effectiveSale,
        bk_purchase: bkPurchase, bk_fixed_share: bkFixedShare, ...fixed,
        total_expense: round(totalExpense), net_pnl: netPnl, margin_pct: marginPct,
      };
    });

    const SUM_KEYS = ["total_sale", "delivery_sale", "delivery_commission", "effective_sale", "bk_purchase", "bk_fixed_share", "rent", "salary", "electricity", "gst", "misc", "total_expense", "net_pnl"];
    const totals = { outlet_id: "all" };
    SUM_KEYS.forEach((k) => { totals[k] = round(outlets.reduce((s, o) => s + o[k], 0)); });
    totals.margin_pct = totals.effective_sale > 0 ? Math.round((totals.net_pnl / totals.effective_sale) * 1000) / 10 : null;

    res.json({ from, to, commission_pct: commissionPct, outlets, totals });
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
