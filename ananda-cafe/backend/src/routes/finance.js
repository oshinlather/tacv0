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
//   − Rent, Salary, Electricity, GST, Transport, Water, Misc (from the same fixed_costs
//     table FixedCostsPanel already writes to — this view just pivots those rows into
//     named columns and prorates each row's monthly amount across the selected range)
//   = Net P&L
const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { requireRole } = require("./authGuards");
const { computeDailySalesRevenue, buildCostingContext, computeBkPurchaseByOutlet } = require("./salesRoutes");

const OUTLET_IDS = ["sec23", "sec31", "sec56", "sec14", "elan", "gaursid"];

function daysInMonthOf(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
// A fixed_costs row is a MONTHLY amount — prorate it across [from, to] one calendar day
// at a time (rather than a single monthly/daysInRange ratio) so a range that happens to
// straddle two different-length months still prorates correctly on both sides. In the
// common case (from/to both inside one month) this is equivalent to
// monthly * daysInRange/daysInThatMonth.
function prorateFixedAmount(monthlyAmount, from, to) {
  let total = 0;
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const ds = d.toISOString().slice(0, 10);
    total += monthlyAmount / daysInMonthOf(ds);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

// cost_head → named P&L column. Anything not listed here (Internet, Mala Decoration,
// Staff Room Rent, Waste Collection, the existing "misc" head itself, or any future head
// added via FixedCostsPanel) rolls into Misc — the owner asked for exactly these 7
// expense columns, not one column per configured head.
const FIXED_HEAD_BUCKET = { rent: "rent", salary: "salary", electricity: "electricity", gst: "gst", transport: "transport", water: "water", water_expense: "water" };

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
      // Fetch BK's own fixed costs (outlet_id='bk') alongside the 6 outlets' — previously
      // excluded by the .in(OUTLET_IDS) filter, so BK's rent/salary/etc never showed up
      // anywhere in this view at all.
      supabase.from("fixed_costs").select("*").eq("active", true).in("outlet_id", [...OUTLET_IDS, "bk"]),
    ]);
    const commissionPct = commissionCfg?.value ? Number(JSON.parse(commissionCfg.value)) : 40;
    const bkPurchaseByOutlet = await computeBkPurchaseByOutlet(from, to, costingContext);

    const round = (n) => Math.round(n || 0);

    // BK's own fixed cost, prorated across [from, to] same as every other fixed_costs
    // row, then divided proportionally by each outlet's BK Purchase share below.
    const bkFixedRows = (fixedCostRows || []).filter((f) => f.outlet_id === "bk");
    const bkFixedTotalProrated = bkFixedRows.reduce((s, f) => s + prorateFixedAmount(Number(f.amount) || 0, from, to), 0);
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

      const fixed = { rent: 0, salary: 0, electricity: 0, gst: 0, transport: 0, water: 0, misc: 0 };
      (fixedCostRows || []).filter((f) => f.outlet_id === oid).forEach((f) => {
        const bucket = FIXED_HEAD_BUCKET[(f.cost_head || "").toLowerCase()] || "misc";
        fixed[bucket] += prorateFixedAmount(Number(f.amount) || 0, from, to);
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

    const SUM_KEYS = ["total_sale", "delivery_sale", "delivery_commission", "effective_sale", "bk_purchase", "bk_fixed_share", "rent", "salary", "electricity", "gst", "transport", "water", "misc", "total_expense", "net_pnl"];
    const totals = { outlet_id: "all" };
    SUM_KEYS.forEach((k) => { totals[k] = round(outlets.reduce((s, o) => s + o[k], 0)); });
    totals.margin_pct = totals.effective_sale > 0 ? Math.round((totals.net_pnl / totals.effective_sale) * 1000) / 10 : null;

    res.json({ from, to, commission_pct: commissionPct, outlets, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
