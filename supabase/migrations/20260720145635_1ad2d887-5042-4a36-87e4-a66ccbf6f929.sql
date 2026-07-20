-- Phase 1 — Agentic reply pipeline: durable queue, decision log, idempotency, model config, secret rotation.

DELETE FROM public.messages a
USING public.messages b
WHERE a.conversation_id = b.conversation_id
  AND a.whapi_message_id = b.whapi_message_id
  AND a.whapi_message_id IS NOT NULL
  AND a.direction = 'inbound'
  AND b.direction = 'inbound'
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_whapi_id_uniq
  ON public.messages (conversation_id, whapi_message_id)
  WHERE whapi_message_id IS NOT NULL AND direction = 'inbound';

CREATE TABLE IF NOT EXISTS public.bot_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','superseded')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.bot_jobs TO authenticated;
GRANT ALL ON public.bot_jobs TO service_role;

CREATE INDEX IF NOT EXISTS bot_jobs_runnable_idx
  ON public.bot_jobs (run_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS bot_jobs_chat_active_idx
  ON public.bot_jobs (chat_id) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS bot_jobs_created_idx
  ON public.bot_jobs (created_at DESC);

ALTER TABLE public.bot_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all bot_jobs"
  ON public.bot_jobs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.claim_bot_jobs(
  p_worker TEXT,
  p_limit INT DEFAULT 5,
  p_chat TEXT DEFAULT NULL
)
RETURNS SETOF public.bot_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.bot_jobs
  SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      last_error = COALESCE(last_error, 'worker lock expired'),
      updated_at = now()
  WHERE status = 'processing' AND locked_until < now();

  RETURN QUERY
  WITH runnable AS (
    SELECT j.id
    FROM public.bot_jobs j
    WHERE j.status = 'pending'
      AND j.run_after <= now()
      AND (p_chat IS NULL OR j.chat_id = p_chat)
      AND NOT EXISTS (
        SELECT 1 FROM public.bot_jobs busy
        WHERE busy.chat_id = j.chat_id
          AND busy.status = 'processing'
          AND busy.locked_until >= now()
      )
      AND j.id = (
        SELECT j2.id FROM public.bot_jobs j2
        WHERE j2.chat_id = j.chat_id
          AND j2.status = 'pending'
          AND j2.run_after <= now()
        ORDER BY j2.created_at, j2.id
        LIMIT 1
      )
    ORDER BY j.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.bot_jobs j
  SET status = 'processing',
      attempts = j.attempts + 1,
      locked_until = now() + interval '3 minutes',
      locked_by = p_worker,
      updated_at = now()
  FROM runnable r
  WHERE j.id = r.id
  RETURNING j.*;
END;
$$;

CREATE TABLE IF NOT EXISTS public.bot_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  chat_id TEXT,
  trigger TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','skip','error')),
  summary TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.bot_decisions TO authenticated;
GRANT ALL ON public.bot_decisions TO service_role;

CREATE INDEX IF NOT EXISTS bot_decisions_created_idx
  ON public.bot_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS bot_decisions_job_idx
  ON public.bot_decisions (job_id);
CREATE INDEX IF NOT EXISTS bot_decisions_conversation_idx
  ON public.bot_decisions (conversation_id, created_at DESC);

ALTER TABLE public.bot_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all bot_decisions"
  ON public.bot_decisions FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS model_strong TEXT,
  ADD COLUMN IF NOT EXISTS model_fast TEXT,
  ADD COLUMN IF NOT EXISTS agent_config JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.bot_settings
SET cron_secret = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

DO $rotate_vault$
BEGIN
  PERFORM vault.update_secret(
    (SELECT id FROM vault.secrets WHERE name = 'CRON_SECRET'),
    replace(gen_random_uuid()::text, '-', '')
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$rotate_vault$;

DO $cleanup$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE command LIKE '%process-bot-jobs%'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END
$cleanup$;

SELECT cron.schedule(
  'process-bot-jobs',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://snuggle-shine-lab.lovable.app/api/public/hooks/process-bot-jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT cron_secret FROM public.bot_settings ORDER BY created_at LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);