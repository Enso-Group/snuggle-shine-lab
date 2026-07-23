-- Faster job sweeper for on-time DM replies.
--
-- DM reply timing is now DURABLE: the human-feel delay (15-120s) is encoded in
-- bot_jobs.run_after instead of an inline sleep inside the Cloudflare Worker
-- webhook (a Worker request can't be held open for 15-120s — doing so used to
-- strand the claimed job under its 3-minute lock and push replies out to
-- several minutes). For that to land the reply inside the 15s-2min window, the
-- queue has to be swept more often than once a minute.
--
-- This adds a lightweight tick every 20 seconds that ONLY drains due jobs
-- (?jobs_only=1 — no follow-ups / group engine / analytics, so it stays cheap).
-- The existing every-minute 'process-bot-jobs' job keeps doing the full run
-- (retries, orphan recovery, follow-ups, group posting, analytics).

-- Remove any prior copy of the fast job so re-running this migration is safe.
DO $cleanup$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'process-bot-jobs-fast'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL; -- pg_cron not installed here; nothing to clean up
END
$cleanup$;

-- Every 20 seconds (pg_cron interval syntax). jobs_only keeps the tick light.
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
  NULL; -- pg_cron not installed here
END
$schedule$;
