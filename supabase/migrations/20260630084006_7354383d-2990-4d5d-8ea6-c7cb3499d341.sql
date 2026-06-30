
CREATE TABLE public.ai_usage_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('llm','tool')),
  provider TEXT,
  model TEXT,
  tool_name TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  http_status INT,
  error_message TEXT,
  duration_ms INT,
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  cost_usd NUMERIC(12,6),
  meta JSONB
);

CREATE INDEX ai_usage_log_created_at_idx ON public.ai_usage_log (created_at DESC);
CREATE INDEX ai_usage_log_kind_idx ON public.ai_usage_log (kind);
CREATE INDEX ai_usage_log_model_idx ON public.ai_usage_log (model);
CREATE INDEX ai_usage_log_status_idx ON public.ai_usage_log (status);

GRANT SELECT ON public.ai_usage_log TO authenticated;
GRANT ALL ON public.ai_usage_log TO service_role;

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all ai_usage_log"
  ON public.ai_usage_log FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
