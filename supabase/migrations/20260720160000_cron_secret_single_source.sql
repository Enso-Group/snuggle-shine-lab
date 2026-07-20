-- Make the scheduled-send cron self-consistent.
--
-- Until now the cron job sent a secret from one system (vault/env) while the
-- app compared against another (process.env.CRON_SECRET), and the two could
-- silently disagree — every call returned 403 and scheduled messages never
-- went out. Store the secret in bot_settings.cron_secret instead: the cron job
-- reads it from that row when it fires, and the endpoint checks the same row,
-- so the two sides can never drift apart. No value ever needs to be copied by
-- hand, and rotating it is a single UPDATE with no redeploy.

-- 1) Storage for the shared secret.
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS cron_secret TEXT;

-- 2) Ensure a settings row exists, then generate a secret where missing.
INSERT INTO public.bot_settings (enabled)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM public.bot_settings);

UPDATE public.bot_settings
SET cron_secret = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE cron_secret IS NULL;

-- 3) Remove every existing cron job pointed at the endpoint (any name — several
--    were created over time), then schedule one canonical job.
DO $cleanup$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE command LIKE '%send-scheduled-messages%'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL; -- pg_cron not installed here; nothing to clean up
END
$cleanup$;

-- Every minute; the endpoint's grace window and row-claim make this safe.
-- (No timeout override: not all pg_net versions accept the parameter, and a
-- recorded client timeout doesn't abort the send server-side.)
SELECT cron.schedule(
  'send-scheduled-whatsapp-messages',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://snuggle-shine-lab.lovable.app/api/public/hooks/send-scheduled-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT cron_secret FROM public.bot_settings ORDER BY created_at LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);
