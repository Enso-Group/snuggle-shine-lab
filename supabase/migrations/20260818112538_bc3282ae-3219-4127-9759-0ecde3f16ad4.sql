DO $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['process-bot-jobs','process-bot-jobs-fast','send-scheduled-whatsapp-messages','send-scheduled-messages-every-5min'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
      RAISE NOTICE 'unscheduled %', j;
    END IF;
  END LOOP;
END $$;