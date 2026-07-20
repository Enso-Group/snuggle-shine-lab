-- Fix: saving a weekly schedule always failed.
--
-- The scheduler's "AI message" option was introduced in
-- 20260706120000_scheduled_messages_mode.sql, which adds scheduled_messages.mode.
-- That migration was never applied to this database, so the column is absent —
-- verified against the live API: `ORDER BY body` succeeds, `ORDER BY zzz_fake`
-- reports 42703 (no such column), but `ORDER BY mode` resolves to Postgres's
-- ordered-set aggregate `mode()`, i.e. no column of that name is in scope.
--
-- createScheduledMessage inserts `mode: 'direct'`, so every save was rejected
-- and the Weekly Scheduler could never store anything.
--
-- Idempotent: harmless if the column is already present.
ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'direct';
