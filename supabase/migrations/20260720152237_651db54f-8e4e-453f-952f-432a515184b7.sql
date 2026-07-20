-- Phase 2 — Persistent memory + Knowledge Base + follow-ups.
CREATE TABLE IF NOT EXISTS public.people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  language TEXT,
  sentiment TEXT,
  funnel_stage TEXT NOT NULL DEFAULT 'unknown'
    CHECK (funnel_stage IN ('unknown','lead','customer','community','vip','churned')),
  facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.people TO authenticated;
GRANT ALL ON public.people TO service_role;
CREATE INDEX IF NOT EXISTS people_last_seen_idx ON public.people (last_seen_at DESC);
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all people"
  ON public.people FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'fact'
    CHECK (kind IN ('fact','product','price','policy','faq','link','doc')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.knowledge_base TO authenticated;
GRANT ALL ON public.knowledge_base TO service_role;
CREATE INDEX IF NOT EXISTS knowledge_base_active_idx
  ON public.knowledge_base (active, updated_at DESC);
ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all knowledge_base"
  ON public.knowledge_base FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  person_wa_id TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','queued_approval','cancelled','failed')),
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.follow_ups TO authenticated;
GRANT ALL ON public.follow_ups TO service_role;
CREATE INDEX IF NOT EXISTS follow_ups_due_idx
  ON public.follow_ups (due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS follow_ups_conversation_idx
  ON public.follow_ups (conversation_id, created_at DESC);
ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all follow_ups"
  ON public.follow_ups FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));