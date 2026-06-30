
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS require_approval_all BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.scheduled_approvals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'schedule';
ALTER TABLE public.scheduled_approvals ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_scheduled_approvals_status_created
  ON public.scheduled_approvals (status, created_at DESC);
