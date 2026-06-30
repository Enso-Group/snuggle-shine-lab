
ALTER TABLE public.scheduled_messages ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.scheduled_approvals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_message_id UUID REFERENCES public.scheduled_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_chat_id TEXT NOT NULL,
  target_name TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_approvals TO authenticated;
GRANT ALL ON public.scheduled_approvals TO service_role;

ALTER TABLE public.scheduled_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own scheduled approvals"
  ON public.scheduled_approvals FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_approvals_pending
  ON public.scheduled_approvals (user_id, status, created_at DESC);
