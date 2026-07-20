SELECT cron.unschedule(1);
SELECT cron.unschedule(2);
SELECT cron.alter_job(job_id := 3, active := true);