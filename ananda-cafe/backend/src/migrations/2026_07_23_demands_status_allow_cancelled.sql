-- The demands.status CHECK constraint currently allows only 'draft', 'submitted',
-- 'received', 'fulfilled' (confirmed by testing directly against Supabase). Writing off
-- stale backlog demands (never dispatched, no longer needed) needs a 'cancelled' status
-- distinct from 'fulfilled' — cancelling must never look like goods actually went out.
-- Run this once in the Supabase SQL Editor.

ALTER TABLE demands DROP CONSTRAINT IF EXISTS demands_status_check;
ALTER TABLE demands ADD CONSTRAINT demands_status_check
  CHECK (status IN ('draft', 'submitted', 'received', 'fulfilled', 'cancelled'));
