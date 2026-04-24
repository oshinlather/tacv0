const express = require("express");
const cors = require("cors");
const multer = require("multer");

const supabase = require("./supabase");
const { requireAuth } = require("./routes/authGuards");
const demandsRouter = require("./routes/demands");
const issuancesRouter = require("./routes/issuances");
const purchasesRouter = require("./routes/purchases");
const pnlRouter = require("./routes/pnl");
const petpoojaRouter = require("./routes/petpooja");
const ordersRouter = require("./routes/orders");
const inventoryRouter = require("./routes/inventory");
const salesRoutes = require('./routes/salesRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  // Must allow x-user-id so the browser doesn't strip it on preflight
  allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
}));
app.use(express.json({ limit: "50mb" }));
app.use('/api', salesRoutes);

// Health check (public — no auth)
app.get("/", (req, res) => {
  res.json({ status: "ok", app: "Ananda Cafe API", time: new Date().toISOString() });
});

// Routes
app.use("/api/demands", demandsRouter);
app.use("/api/issuances", issuancesRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/pnl", pnlRouter);
app.use("/api/petpooja", petpoojaRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/inventory", inventoryRouter);

// Outlets — any authenticated user can list outlets (needed by all role UIs)
app.get("/api/outlets", async (req, res) => {
  if (!await requireAuth(req, res)) return;
  const { data, error } = await supabase.from("outlets").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// NOTE: The PIN-only /api/auth/login that used to live here has been removed.
// The real login lives in salesRoutes.js at /api/auth/login (phone + PIN against app_users).
// That route wins by mount order (salesRoutes is mounted on /api first).

app.listen(PORT, () => {
  console.log(`🍽️  Ananda Cafe API running on port ${PORT}`);
});
