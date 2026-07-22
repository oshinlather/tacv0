-- Adds a draft/submitted lifecycle to closing_stocks, matching demands.status.
-- Existing rows default to 'submitted' so P&L/stock-usage (which reads closing_stocks
-- with no status filter today) keeps treating all historical data as final.
-- Run this once in the Supabase SQL Editor.

ALTER TABLE closing_stocks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'submitted';
