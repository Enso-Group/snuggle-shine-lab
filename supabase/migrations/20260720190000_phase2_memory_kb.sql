-- Phase 2 — Persistent memory + Knowledge Base + follow-ups.
--
--  * people          — one row per WhatsApp sender (1:1 and group members).
--                      The bot extracts durable facts after every exchange, so
--                      the next conversation feels like talking to someone who
--                      remembers everything.
--  * knowledge_base  — verified business facts (products, prices, policies,
--                      FAQs, links, free-text docs). The bot may only state
--                      business facts that appear here; otherwise it says it
--                      will check and escalates. Retrieval is lexical ranking
--                      in the app for now — an embedding column can be added
--                      later without changing this schema (pgvector), the KB
--                      is small enough that ranked injection is exact.
--  * follow_ups      — agent-proposed follow-ups (lead went quiet, promised
--                      decision). The every-minute sweeper sends them under
--                      the anti-ban guards, or queues them for approval.

-- ---------------------------------------------------------------------------
-- 1) people
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT NOT NULL UNIQUE,                 -- e.g. 9725...@s.whatsapp.net
  display_name TEXT,
  language TEXT,                              -- he / en / ru / ar / ...
  sentiment TEXT,                             -- latest observed emotional state
  funnel_stage TEXT NOT NULL DEFAULT 'unknown'
    CHECK (funnel_stage IN ('unknown','lead','customer','community','vip','churned')),
  facts JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{"text": "...", "at": "ISO"}]
  tags TEXT[] NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS people_last_seen_idx ON public.people (last_seen_at DESC);

ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all people"
  ON public.people FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
-- Writes go through the service role only.

-- ---------------------------------------------------------------------------
-- 2) knowledge_base
-- ---------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS knowledge_base_active_idx
  ON public.knowledge_base (active, updated_at DESC);

ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all knowledge_base"
  ON public.knowledge_base FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 3) follow_ups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  person_wa_id TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,                       -- why the agent scheduled it
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','queued_approval','cancelled','failed')),
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS follow_ups_due_idx
  ON public.follow_ups (due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS follow_ups_conversation_idx
  ON public.follow_ups (conversation_id, created_at DESC);

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all follow_ups"
  ON public.follow_ups FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
