-- ═══════════════════════════════════════════════════════════════
--  ANANDA CAFE — DATABASE SCHEMA
--  Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- Outlets
CREATE TABLE outlets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  is_franchise BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO outlets (id, name, short_name, is_franchise) VALUES
  ('sec23', 'Sector 23', 'S-23', FALSE),
  ('sec31', 'Sector 31', 'S-31', FALSE),
  ('sec56', 'Sector 56', 'S-56', FALSE),
  ('elan', 'Elan (Franchise)', 'ELAN', TRUE);

-- Users (simple PIN-based auth for managers)
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'outlet_manager', 'store_manager')),
  outlet_id TEXT REFERENCES outlets(id),
  pin TEXT NOT NULL,  -- 4-digit PIN
  phone TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Demand Challans (from outlet managers)
CREATE TABLE demands (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  type TEXT NOT NULL CHECK (type IN ('photo', 'manual')),
  items JSONB DEFAULT '{}',        -- {item_id: quantity, ...}
  note TEXT,
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'submitted' CHECK (status IN ('submitted', 'received', 'fulfilled'))
);

-- Demand Photos (stored in Supabase Storage)
CREATE TABLE demand_photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  section TEXT NOT NULL,  -- prepared, vegetable, disposal, cleaning
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Closing Stock (from outlet managers, end of day)
CREATE TABLE closing_stocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  items JSONB NOT NULL DEFAULT '{}',  -- {item_id: quantity, ...}
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(outlet_id, date)
);

-- Store Issuances (from BK store manager)
CREATE TABLE issuances (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  issue_to TEXT NOT NULL,  -- 'bk_production' or outlet_id
  note TEXT,
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- Issuance Photos
CREATE TABLE issuance_photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  issuance_id UUID NOT NULL REFERENCES issuances(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily Purchases (store manager buys paneer, mala etc.)
CREATE TABLE purchases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'credit')),
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  note TEXT,
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- Purchase Line Items
CREATE TABLE purchase_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity DECIMAL(10,2),
  unit TEXT,
  amount DECIMAL(10,2) NOT NULL,
  vendor TEXT
);

-- Purchase Bill Photos
CREATE TABLE purchase_photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily P&L entries (auto-filled from PetPooja + manual expenses)
CREATE TABLE daily_pnl (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Revenue (from PetPooja)
  total_sale DECIMAL(12,2) DEFAULT 0,
  delivery_sale DECIMAL(12,2) DEFAULT 0,
  online_commission DECIMAL(12,2) DEFAULT 0,
  effective_sale DECIMAL(12,2) DEFAULT 0,
  -- Fixed Expenses
  rent DECIMAL(10,2) DEFAULT 0,
  salary DECIMAL(10,2) DEFAULT 0,
  -- Variable Expenses (auto from demands/purchases)
  raw_material DECIMAL(10,2) DEFAULT 0,
  vegetable DECIMAL(10,2) DEFAULT 0,
  dairy DECIMAL(10,2) DEFAULT 0,
  disposal DECIMAL(10,2) DEFAULT 0,
  gas DECIMAL(10,2) DEFAULT 0,
  electricity DECIMAL(10,2) DEFAULT 0,
  water_tanker DECIMAL(10,2) DEFAULT 0,
  transport DECIMAL(10,2) DEFAULT 0,
  -- Other Expenses
  staff_room_rent DECIMAL(10,2) DEFAULT 0,
  staff_room_elec DECIMAL(10,2) DEFAULT 0,
  staff_welfare DECIMAL(10,2) DEFAULT 0,
  mala DECIMAL(10,2) DEFAULT 0,
  other_expense DECIMAL(10,2) DEFAULT 0,
  maintenance DECIMAL(10,2) DEFAULT 0,
  new_purchase DECIMAL(10,2) DEFAULT 0,
  vendor_payments DECIMAL(10,2) DEFAULT 0,
  zomato_ads DECIMAL(10,2) DEFAULT 0,
  swiggy_ads DECIMAL(10,2) DEFAULT 0,
  gst DECIMAL(10,2) DEFAULT 0,
  profit_tax DECIMAL(10,2) DEFAULT 0,
  -- Metadata
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(outlet_id, date)
);

-- PetPooja Sales Sync Log
CREATE TABLE petpooja_sync (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  date DATE NOT NULL,
  raw_data JSONB,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
--  INDEXES for fast queries
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX idx_demands_outlet_date ON demands(outlet_id, date);
CREATE INDEX idx_closing_outlet_date ON closing_stocks(outlet_id, date);
CREATE INDEX idx_issuances_date ON issuances(date);
CREATE INDEX idx_purchases_date ON purchases(date);
CREATE INDEX idx_pnl_outlet_date ON daily_pnl(outlet_id, date);

-- ═══════════════════════════════════════════════════════════════
--  STORAGE BUCKET (run after creating tables)
-- ═══════════════════════════════════════════════════════════════
-- Go to Supabase Dashboard → Storage → Create bucket:
--   Name: photos
--   Public: false
--   File size limit: 10MB
--   Allowed MIME types: image/jpeg, image/png, image/webp

-- Enable RLS
ALTER TABLE demands ENABLE ROW LEVEL SECURITY;
ALTER TABLE closing_stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_pnl ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (backend uses service key)
CREATE POLICY "Service role access" ON demands FOR ALL USING (true);
CREATE POLICY "Service role access" ON closing_stocks FOR ALL USING (true);
CREATE POLICY "Service role access" ON issuances FOR ALL USING (true);
CREATE POLICY "Service role access" ON purchases FOR ALL USING (true);
CREATE POLICY "Service role access" ON daily_pnl FOR ALL USING (true);
