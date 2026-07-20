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

GRANT SELECT ON public.group_daily_stats TO authenticated;
GRANT ALL ON public.group_daily_stats TO service_role;

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
  week_start DATE NOT NULL,
  memo TEXT NOT NULL,
  recommendations JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_chat_id, week_start)
);

GRANT SELECT ON public.strategy_memos TO authenticated;
GRANT ALL ON public.strategy_memos TO service_role;

CREATE INDEX IF NOT EXISTS strategy_memos_group_idx
  ON public.strategy_memos (group_chat_id, week_start DESC);

ALTER TABLE public.strategy_memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all strategy_memos"
  ON public.strategy_memos FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));