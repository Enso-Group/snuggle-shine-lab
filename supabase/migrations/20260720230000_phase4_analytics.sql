-- Phase 4 — Engagement analytics + self-improvement.
--
--  * group_daily_stats — one row per managed group per day (idempotent
--    rollups): message volume, active members, bot posts and the replies
--    they earned, membership changes.
--  * strategy_memos — the bot's weekly self-written strategy review per
--    group: what worked, what didn't, and structured recommendations the
--    posting engine feeds back into its next drafts.

CREATE TABLE IF NOT EXISTS public.group_daily_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_chat_id TEXT NOT NULL,
  date DATE NOT NULL,
  messages INT NOT NULL DEFAULT 0,
  active_members INT NOT NULL DEFAULT 0,
  bot_posts INT NOT NULL DEFAULT 0,
  post_replies INT NOT NULL DEFAULT 0,
  new_members INT NOT NULL DEFAULT 0,
  left_members INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_chat_id, date)
);

CREATE INDEX IF NOT EXISTS group_daily_stats_group_idx
  ON public.group_daily_stats (group_chat_id, date DESC);

ALTER TABLE public.group_daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all group_daily_stats"
  ON public.group_daily_stats FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.strategy_memos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_chat_id TEXT NOT NULL,
  week_start DATE NOT NULL,                   -- Sunday of the reviewed week (Israel time)
  memo TEXT NOT NULL,                         -- the self-written review, human-readable
  recommendations JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"best_times": [], "pillar_ranking": [], "notes": "..."}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_chat_id, week_start)
);

CREATE INDEX IF NOT EXISTS strategy_memos_group_idx
  ON public.strategy_memos (group_chat_id, week_start DESC);

ALTER TABLE public.strategy_memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all strategy_memos"
  ON public.strategy_memos FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
