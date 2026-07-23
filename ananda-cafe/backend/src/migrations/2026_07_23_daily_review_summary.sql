-- Daily review/rating summary per outlet per platform (Zomato/Swiggy), sourced from
-- PetPooja CRM > Feedback > Ratings & Reviews + Reports > Order Report: Sub-Order Wise.
-- One row per (date, outlet_id, platform). Run this once in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS daily_review_summary (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  outlet_id TEXT NOT NULL,          -- matches OUTLETS ids in App.jsx: sec23, sec31, sec56, sec14, elan, gaursid
  platform TEXT NOT NULL,           -- 'zomato' | 'swiggy'
  total_orders INTEGER,             -- total orders for that outlet+platform that day (NULL if not integrated)
  num_reviews INTEGER NOT NULL DEFAULT 0,
  avg_rating NUMERIC(3,2),          -- NULL when num_reviews = 0
  remarks TEXT,                     -- e.g. "Not integrated", "No reviews"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, outlet_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_daily_review_summary_date ON daily_review_summary (date);
