-- Native WhatsApp polls: a queued approval can carry a structured poll
-- ({"question": "...", "options": ["..."], "multi": false}) alongside its
-- text body. On approval the poll is sent as a real tappable WhatsApp poll
-- (Whapi POST /messages/poll), not as inline text.
ALTER TABLE public.scheduled_approvals ADD COLUMN IF NOT EXISTS poll JSONB;
