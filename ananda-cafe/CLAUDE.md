# The Ananda Cafe — Operations Management System

## Project Overview
Multi-outlet South Indian cafe operations system for 4 outlets (Sector 23, Sector 31, Sector 56, Elan) with a Base Kitchen (BK). Owner: Parveen Lather (oshinlather on GitHub).

## Tech Stack
- **Frontend**: React (single-file App.jsx) on Vercel → `tacv0.vercel.app`
- **Backend**: Express.js on Render → `tacv0.onrender.com`
- **Database**: Supabase (PostgreSQL)
- **Google Sheets**: 4 spreadsheets (one per outlet) for data sync

## Repository Structure
```
ananda-cafe/
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Single-file React app (~7000 lines)
│   │   └── api.js            # API client with authHeaders()
│   └── public/
│       └── logo.png          # Brand logo
├── backend/
│   └── src/
│       ├── server.js          # Express server, CORS, routes
│       ├── supabase.js        # Supabase client
│       └── routes/
│           ├── salesRoutes.js  # Main routes file (~2700 lines)
│           └── authGuards.js   # Role-based auth (requireAuth, requireOwner, requireRole)
```

## Database Tables

### Core Tables
- `demands` — Outlet demands, dispatch, wastage (type: manual/wastage, status: draft/submitted/fulfilled)
- `closing_stocks` — Daily closing stock per outlet (separate table, NOT in demands)
- `daily_sales` — Daily sales data per outlet
- `rate_card` — Item prices (id, name, category, unit, price, active). `price` = current/mirrored price; the dated source of truth is `rate_card_prices` (see Date-Effective Pricing)
- `rate_card_prices` — Price ledger (rate_card_id, effective_date, price, source, source_id). Dated price history; costing resolves as-of each calculation's date
- `demand_items` — Item definitions for demand form (id, name, section_id, unit, active)
- `bk_recipes` — BK recipe definitions (id, name, yield_qty, yield_unit)
- `bk_recipe_ingredients` — Recipe ingredients (recipe_id, raw_material_id, qty, unit)
- `unit_conversions` — Custom unit conversions (item_id, unit_type, qty, base_unit)
  - Dosa Batter: 1 Batch = 9 Kg
  - Idli Batter: 1 Batch = 8 Kg
  - Vada Batter: 1 Batch = 2 Kg (but vada batter is demanded in Kg, not Batch)
  - Fortune Refined Oil: 1 Tin = 15 Kg
  - Desi Ghee: 1 Tin = 15 Kg
- `inventory_items` — BK inventory items (id, name, category, demand_item_id)
- `qty_corrections` — Audit log for quantity edits
- `app_users` — User accounts with roles (owner, store_mgr, outlet_mgr)

## Key Architecture Decisions

### Unit System
- **Weight**: All in Kg (outlets type 0.5 meaning 0.5 Kg). No Gm anywhere.
- **Volume**: Ltr (milk, water)
- **Counted**: Pcs, Pkt, Can, Box, Bundle
- **Special**: Batch (dosa/idli batter) → Kg via unit_conversions table
- **Special**: Tin (oil/ghee) → Kg via unit_conversions table
- **Rule**: SI units (Kg, Ltr, Pcs) = no conversion. Everything else → look up unit_conversions table.
- **Gm→Kg**: hardcoded ÷1000 as universal fallback (but currently no items use Gm)

### 8 Categories (consistent across demand, rate card, P&L)
1. **Food** — BK prep items (sambhar, dosa batter, chutneys) + direct food items
2. **Dairy** — Butter, cheese, paneer, dahi, milk, cream
3. **Vegetable** — Onions, tomatoes, green chillies, ginger, etc.
4. **Grocery** — Rice, dal, oil, sugar, salt, atta, dry fruits
5. **Masala** — Deggi mirch, jeera, haldi, hing, spices
6. **Packaging** — Containers, boxes, polythene, spoons
7. **Cleaning** — Pochha, duster, phenyl, surf
8. **Gas** — Gas cylinder

### P&L Pricing Logic
1. **Rate card first**: If item has an active rate_card entry → use rate card price
2. **Recipe fallback**: If no rate card AND item is a BK recipe → compute cost from recipe ingredients × rate card prices
3. **Raw material ID mapping**: Recipe ingredients use `_raw` suffix IDs. Complete 55-entry mapping (`rawToRate`) resolves these to rate card IDs.

### Date-Effective Pricing (price ledger)
- Rate-card prices are **date-effective**, not a single mutable number. Table `rate_card_prices` (id, rate_card_id, effective_date, price, source, source_id) is the ledger; `rate_card.price` is just the mirrored *current* price (what the master screen edits, and what live/dish costing reads).
- **As-of resolution**: the price of an item on date D = the latest ledger row with `effective_date <= D` (tie-break `created_at DESC` — "latest price paid"), carried forward. `buildCostingContext(asOfDate)` resolves this; every dated read (P&L, RM Audit, stock-usage, wastage, franchise, finance) passes its own date, so **past calculations never change when a new price lands** (forward-only). Omitting `asOfDate` = current price (unchanged behaviour).
- `ctx.withDate(date)` re-prices rateMap + BK recipe costs (Sambhar etc.) in memory off one ledger load — range/month callers (RM Audit range, finance day-loops) price each day correctly without refetching.
- **Writers** append rows via `rateCardPrices.js` (`ingestPrices`/`appendRateCardPrice`): vendor **challan receive** (`source='challan'`, per store item base-unit price), **cash/dairy purchase** submit (`source='purchase'`, amount÷qty), and **manual rate-card add/edit** (`source='manual'`, effective today — required, or a dated read wouldn't see the edit). A price is skipped+logged (never guessed) when its unit ≠ the rate-card unit, or no rate-card match. Baseline seed (2000-01-01 = current price) keeps day-1 numbers identical.
- **Known exception**: legacy `/pnl/computed/:date` (`computeDailyPnL`) still uses the separate `rate_per_kg` column + `bk_costs` table (not the ledger). It's unused by the frontend; left untouched.

### Consumed Material Formula (P&L)
```
Consumed = (Yesterday Closing + Today Dispatched) - Today Wastage - Today Closing
```
- Closing stock from `closing_stocks` table (NOT demands table)
- Wastage from `demands` table with type='wastage'
- Missing closing stock treated as 0
- All quantities converted to base units BEFORE the formula (not after)
- P&L shows the calculation under each item: `(20 + 140) − 0 − 30 = 130 Kg`

### Closing Stock Keys
- Closing stock items use `cs_` prefix: `cs_sambhar`, `cs_butter`, etc.
- Code normalizes by stripping `cs_` prefix before deduplication

### Demand Slots
- Demands have `demand_slot` field: 'morning' or 'evening'
- AM/PM grouping uses this field (NOT submitted_at timestamp, since managers submit at odd hours)

### Auth System
- Simple header-based: `x-user-id` sent on every request
- `authGuards.js` exports: requireAuth, requireOwner, requireRole, ensureOutletAccess
- Roles: owner, store_mgr, outlet_mgr
- qty-edit endpoint allows both owner and store_mgr

### Inventory
- Tracked manually, NOT auto-deducted from dispatch
- Separate from the demand→dispatch→P&L flow

## Frontend Structure (App.jsx)

### Key Components
- `DailyPnL` — P&L with category-grouped breakdown, consumed material formula
- `DemandHistory` — Last 7 days demands with AM/PM split, costs, edit capability
- `OrderDispatchHistory` — 30-day operations history (Demand, Dispatch, Closing, Wastage, Sales, Purchase tabs)
- `RecipesPanel` — BK recipe management + recipe costing view
- `CogsDash` — COGS dashboard
- `DailyStockUsage` — Stock usage view
- `Dispatch` — Store manager dispatch view

### DEMAND_SECTIONS
Hardcoded in App.jsx (not DB-driven yet). 8 sections matching the 8 categories. Each section has items with id, name, unit.

### RAW_MATERIALS & RECIPES
Hardcoded in App.jsx. Used for frontend recipe costing. Backend has its own copy via bk_recipes + bk_recipe_ingredients tables.

### Key Patterns
- `fmt()` — Format numbers with Indian commas (₹1,23,456)
- `istNow()` — Get current IST date
- `istDateAgo(n)` — Get IST date N days ago
- `OUTLETS` — Array of outlet objects with id, name, short
- `getCurrentUser()` — Get logged-in user from localStorage

## Backend Key Routes (salesRoutes.js)

### P&L
- `GET /api/pnl/live/:date` — Daily P&L with item breakdown
- `GET /api/stock-usage/:date` — Consumed material calculation

### Demands & Dispatch
- `GET /api/orders` — List demands (params: date, from, outlet_id, status)
- `PATCH /api/qty-edit` — Edit demand/dispatch qty (body: outlet_id, date, item_id, new_qty, reason)
- `GET /api/closing-stocks` — List closing stocks (params: date, from, outlet_id)

### Rate Card & Items
- `GET /api/rate-card` — Get active rate card
- `GET /api/master/demand-items` — Get demand items
- `GET /api/master/conversions` — Get unit conversions

### Recipes
- `GET /api/master/recipes` — Get BK recipes with ingredients

## Deployment
- **Frontend**: Push to `main` branch → Vercel auto-deploys
- **Backend**: Push to `main` branch → Render auto-deploys
- **Database**: Run SQL migrations in Supabase SQL Editor
- **Always deploy backend before frontend** when both change

## Common Pitfalls
- `authGuards.js` uses `require('../supabase')` (one level up from routes/)
- `requireRole` must be imported explicitly (not included in default destructuring initially)
- Closing stock is in `closing_stocks` table, NOT `demands` with type='closing'
- BK recipes may not have `active` column set — query without `.eq('active', true)` to get all recipes
- `coconut_crush` in old dispatch data = whole coconuts (Pcs at ₹80), NOT the BK recipe
- Rate card has deactivated duplicates (amchoor, haldi, hing, sona_masoori) — always filter `.eq('active', true)`
