const express = require("express");
const cors = require("cors");
const multer = require("multer");

const supabase = require("./supabase");
const demandsRouter = require("./routes/demands");
const issuancesRouter = require("./routes/issuances");
const purchasesRouter = require("./routes/purchases");
const pnlRouter = require("./routes/pnl");
const petpoojaRouter = require("./routes/petpooja");
const ordersRouter = require("./routes/orders");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "50mb" }));

// Health check
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

// Outlets
app.get("/api/outlets", async (req, res) => {
  const { data, error } = await supabase.from("outlets").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Simple PIN auth
app.post("/api/auth/login", async (req, res) => {
  const { pin } = req.body;
  const { data, error } = await supabase
    .from("users")
    .select("id, name, role, outlet_id, phone")
    .eq("pin", pin)
    .eq("active", true)
    .single();
  if (error || !data) return res.status(401).json({ error: "Invalid PIN" });
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`🍽️  Ananda Cafe API running on port ${PORT}`);
});
