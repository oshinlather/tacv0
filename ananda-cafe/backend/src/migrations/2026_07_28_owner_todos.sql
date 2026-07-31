-- Owner To Do list — new "✅ To Do" tab on the Owner Dashboard.
-- Sourced initially from the "TAC Managers" WhatsApp group (day-end report
-- summary photo + surrounding discussion), same pattern as books_ledger's
-- WhatsApp-sourced seed. Run this once in the Supabase SQL Editor, then run
-- owner_todos_seed.sql.

CREATE TABLE IF NOT EXISTS owner_todos (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',   -- 'operational_issue' | 'vendor_payment' | 'complaint' | 'process' | 'general'
  amount NUMERIC,                             -- optional ₹ amount (e.g. vendor dues)
  status TEXT NOT NULL DEFAULT 'open',        -- 'open' | 'done'
  priority TEXT NOT NULL DEFAULT 'normal',    -- 'low' | 'normal' | 'high'
  due_date DATE,
  notes TEXT,
  source TEXT,                                -- e.g. 'whatsapp'
  raw_message TEXT,                           -- original text/context this task was extracted from
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,-- flag items whose amount/name was hard to read (e.g. handwritten note)
  created_by TEXT,                            -- name of who it's for/from (mirrors books_ledger.submitted_by)
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_todos_status ON owner_todos (status);
CREATE INDEX IF NOT EXISTS idx_owner_todos_category ON owner_todos (category);

ALTER TABLE owner_todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role access" ON owner_todos FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
