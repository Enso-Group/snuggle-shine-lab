-- Phase 3 — Fully autonomous group management.
--
--  * group_profiles     — how a human "teaches" the bot to run a group:
--                         free-text instructions + structured config (purpose,
--                         tone, pillars, posting schedule, rules, moderation
--                         thresholds, escalation). One row per WhatsApp group.
--  * group_members      — per-member state inside each managed group
--                         (joins, violations, warnings, removal).
--  * moderation_actions — audit log of every governance action with reasoning.
--  * planned_posts      — the posting engine's pipeline: planned → drafted →
--                         sent (or queued for approval), with engagement data.
--  * group_insights     — the research loop's persisted findings (activity
--                         patterns, engagement, topics) the planner reads.

CREATE TABLE IF NOT EXISTS public.group_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL UNIQUE,               -- ...@g.us
  name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,     -- master switch for autonomy in this group
  instructions TEXT,                          -- free-text: exactly what to learn & how to manage
  purpose TEXT,
  audience TEXT,
  tone TEXT,
  language TEXT NOT NULL DEFAULT 'he',
  content_pillars JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["טיפ מקצועי", "שאלה לדיון", ...]
  posting_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{"day": 0-6 | null=daily, "time": "HH:MM", "pillar": "...", "prompt": "..."}]
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,             -- group rules the bot enforces
  forbidden_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  moderation JSONB NOT NULL DEFAULT '{}'::jsonb,        -- {"enabled": bool, "delete_violations": bool, "warn_limit": 2, "remove_limit": 3}
  welcome JSONB NOT NULL DEFAULT '{}'::jsonb,           -- {"enabled": bool, "hint": "..."}
  reply_when_mentioned BOOLEAN NOT NULL DEFAULT true,
  reply_to_questions BOOLEAN NOT NULL DEFAULT false,    -- answer group questions without being addressed
  allow_reactive_posts BOOLEAN NOT NULL DEFAULT false,
  escalation_rules TEXT,
  kpis TEXT,
  owner_dm TEXT,                              -- phone/chat id for escalation DMs
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.group_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all group_profiles"
  ON public.group_profiles FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_chat_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  display_name TEXT,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  violations INT NOT NULL DEFAULT 0,
  warned_count INT NOT NULL DEFAULT 0,
  last_violation_at TIMESTAMPTZ,
  removed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_chat_id, wa_id)
);

CREATE INDEX IF NOT EXISTS group_members_group_idx
  ON public.group_members (group_chat_id, violations DESC);

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all group_members"
  ON public.group_members FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.moderation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_chat_id TEXT NOT NULL,
  target_wa_id TEXT,
  target_name TEXT,
  whapi_message_id TEXT,
  action TEXT NOT NULL
    CHECK (action IN ('warn','delete','remove','escalate','welcome')),
  rule_violated TEXT,
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS moderation_actions_group_idx
  ON public.moderation_actions (group_chat_id, created_at DESC);

ALTER TABLE public.moderation_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all moderation_actions"
  ON public.moderation_actions FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.planned_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_chat_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'schedule'
    CHECK (source IN ('schedule','reactive','campaign')),
  slot_key TEXT,                              -- dedupe key for schedule slots: "<day>-<time>-<date>"
  pillar TEXT,
  prompt TEXT,
  body TEXT,
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','sent','queued_approval','failed','cancelled')),
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  whapi_message_id TEXT,
  engagement JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"replies_24h": n, "checked_at": "..."}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS planned_posts_slot_uniq
  ON public.planned_posts (group_chat_id, slot_key)
  WHERE slot_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS planned_posts_group_idx
  ON public.planned_posts (group_chat_id, created_at DESC);

ALTER TABLE public.planned_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all planned_posts"
  ON public.planned_posts FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.group_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_chat_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'activity'
    CHECK (kind IN ('activity','engagement','topics','note')),
  content TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_insights_group_idx
  ON public.group_insights (group_chat_id, kind, created_at DESC);

ALTER TABLE public.group_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all group_insights"
  ON public.group_insights FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
