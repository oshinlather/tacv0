# Ananda Cafe — Operations Management System

A complete internal tool for multi-outlet cafe operations: demand challans, store issuance, daily purchases, COGS tracking, and daily P&L.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Frontend       │────▶│   Backend API    │────▶│   Supabase   │
│   (React)        │     │   (Node.js)      │     │  PostgreSQL  │
│   Vercel         │     │   Render         │     │  + Storage   │
└─────────────────┘     └──────────────────┘     └──────────────┘
                              │
                              ▼
                        ┌──────────────┐
                        │  PetPooja    │
                        │  API         │
                        └──────────────┘
```

## Apps

| App | User | Purpose |
|-----|------|---------|
| Owner Dashboard | Owner | COGS, Daily P&L, Red Flags |
| Outlet Manager | Outlet Managers (4 outlets) | Daily demand challan + closing stock |
| Store Manager | BK Ration Store Manager | Store issuance + daily purchases with bills |

## Setup

### 1. Supabase (Database)

1. Go to [supabase.com](https://supabase.com) and create a free project
2. Go to SQL Editor and run the migration in `backend/src/schema.sql`
3. Copy your project URL and anon key from Settings → API

### 2. Backend (Render)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo, set root directory to `backend`
4. Set environment variables:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_service_key
   FRONTEND_URL=your_vercel_url
   PORT=3001
   ```
5. Build command: `npm install`
6. Start command: `node src/server.js`

### 3. Frontend (Vercel)

1. Go to [vercel.com](https://vercel.com) → Import Project
2. Connect your GitHub repo, set root directory to `frontend`
3. Set environment variable:
   ```
   REACT_APP_API_URL=your_render_url
   ```
4. Deploy (auto-detects React)

### 4. PetPooja Integration

1. Contact your PetPooja account manager
2. Request API access for all 4 outlets
3. Add API keys to backend env:
   ```
   PETPOOJA_API_KEY=your_key
   PETPOOJA_RESTAURANT_IDS=id1,id2,id3,id4
   ```

## Development

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm start
```

## Folder Structure

```
ananda-cafe/
├── frontend/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── App.jsx          # Main app (launcher + all 3 mini-apps)
│   │   ├── api.js           # API client
│   │   └── index.js         # Entry point
│   ├── package.json
│   └── .env.example
├── backend/
│   ├── src/
│   │   ├── server.js         # Express server
│   │   ├── schema.sql        # Supabase DB schema
│   │   ├── supabase.js       # DB client
│   │   └── routes/
│   │       ├── demands.js    # Demand CRUD + photo upload
│   │       ├── issuances.js  # Store issuance routes
│   │       ├── purchases.js  # Daily purchases routes
│   │       ├── pnl.js        # P&L data routes
│   │       └── petpooja.js   # PetPooja sync
│   ├── package.json
│   └── .env.example
└── README.md
```
