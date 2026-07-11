-- Weekly schedule: support AI-generated messages.
-- mode = 'direct' -> body is sent as-is (existing behavior)
-- mode = 'ai'     -> body is a prompt; a fresh message is generated at send time
ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'direct';
