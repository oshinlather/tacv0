-- The demands.status CHECK constraint currently allows only 'submitted', 'received',
-- 'fulfilled' (confirmed by testing directly against Supabase — 'draft' and 'issued' both
-- get rejected, despite CLAUDE.md documenting a submitted->received->issued->fulfilled
-- flow). The new Chef/Bainmarry draft-save feature needs 'draft' to be a valid status.
-- Run this once in the Supabase SQL Editor.

ALTER TABLE demands DROP CONSTRAINT IF EXISTS demands_status_check;
ALTER TABLE demands ADD CONSTRAINT demands_status_check
  CHECK (status IN ('draft', 'submitted', 'received', 'fulfilled'));
