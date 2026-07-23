-- Faster job sweeper for on-time DM replies.
DO $cleanup$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'process-bot-jobs-fast'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END
$cleanup$;

DO $schedule$
BEGIN
  PERFORM cron.schedule(
    'process-bot-jobs-fast',
    '20 seconds',
    $job$
    SELECT net.http_post(
      url := 'https://snuggle-shine-lab.lovable.app/api/public/hooks/process-bot-jobs?jobs_only=1',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT cron_secret FROM public.bot_settings ORDER BY created_at LIMIT 1)
      ),
      body := '{}'::jsonb
    );
    $job$
  );
EXCEPTION WHEN undefined_table THEN
  NULL;
END
$schedule$;