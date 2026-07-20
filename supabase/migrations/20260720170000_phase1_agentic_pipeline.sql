-- Phase 1 — Agentic reply pipeline: durable queue, decision log, idempotency,
-- model configuration, secret rotation.
--
-- The webhook used to do all processing inline with only in-memory guards,
-- which evaporate between serverless isolates. This migration adds the durable
-- primitives the hardened pipeline needs:
--   * a unique index so the same Whapi message can never be stored/processed twice,
--   * bot_jobs — a queue with per-chat serialization (claim RPC below),
--   * bot_decisions — every pipeline stage logged with its reasoning,
--   * bot_settings model config (strong/fast roles, agent knobs),
--   * rotation of the cron secret that was committed to git in plain text.

-- ---------------------------------------------------------------------------
-- 1) Idempotency: exactly one stored row per inbound Whapi message.
--    Clean up any historical duplicates first so the index can build.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2) bot_jobs — durable work queue.
--    chat_id is the serialization key: at most one job per chat is ever
--    'processing' at a time (enforced by claim_bot_jobs below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,                          -- 'inbound_reply' (phase 1); later: 'follow_up', 'planned_post'
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
-- Writes happen only through the service role (bypasses RLS): no write policies.

-- ---------------------------------------------------------------------------
-- 3) claim_bot_jobs — atomic claim with per-chat serialization.
--    Also frees jobs whose worker died (lock expired while 'processing').
-- ---------------------------------------------------------------------------
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
  -- Free jobs whose worker crashed: lock expired but status never resolved.
  -- attempts was already counted at claim time, so max_attempts still binds.
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
      -- never run two jobs for the same chat concurrently
      AND NOT EXISTS (
        SELECT 1 FROM public.bot_jobs busy
        WHERE busy.chat_id = j.chat_id
          AND busy.status = 'processing'
          AND busy.locked_until >= now()
      )
      -- and within a chat, always take the oldest runnable job first
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

-- ---------------------------------------------------------------------------
-- 4) bot_decisions — the bot's reasoning trail, one row per pipeline stage.
--    Surfaced in the dashboard as the live activity log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  chat_id TEXT,
  trigger TEXT NOT NULL,                       -- 'inbound' | 'simulation' | later: 'scheduled','follow_up','planned_post'
  stage TEXT NOT NULL,                         -- 'received','skipped','context','intent','draft','critique','deliver','queued_approval','error'
  status TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','skip','error')),
  summary TEXT,                                -- human-readable reasoning
  data JSONB NOT NULL DEFAULT '{}'::jsonb,     -- structured stage output (intent JSON, draft, critique verdict, …)
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ---------------------------------------------------------------------------
-- 5) Model + agent configuration on bot_settings.
--    NULL = fall back to env (LLM_STRONG_MODEL / LLM_FAST_MODEL) and then to
--    the built-in candidate chain in src/lib/llm.server.ts.
-- ---------------------------------------------------------------------------
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS model_strong TEXT,
  ADD COLUMN IF NOT EXISTS model_fast TEXT,
  ADD COLUMN IF NOT EXISTS agent_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 6) Rotate the compromised cron secret (the old value was committed to git).
--    The canonical pg_cron job reads this row at fire time, so rotation takes
--    effect on the next tick with no redeploy. Also overwrite the unused vault
--    copy so the leaked value stops working everywhere.
-- ---------------------------------------------------------------------------
UPDATE public.bot_settings
SET cron_secret = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

DO $rotate_vault$
BEGIN
  PERFORM vault.update_secret(
    (SELECT id FROM vault.secrets WHERE name = 'CRON_SECRET'),
    replace(gen_random_uuid()::text, '-', '')
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- vault not present / secret absent — nothing to rotate
END
$rotate_vault$;

-- ---------------------------------------------------------------------------
-- 7) Worker sweeper cron: retries failed/orphaned jobs and runs anything the
--    inline path missed. Same auth pattern as the scheduled-send job — the
--    secret is read from bot_settings at fire time.
-- ---------------------------------------------------------------------------
DO $cleanup$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE command LIKE '%process-bot-jobs%'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL; -- pg_cron not installed here
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
