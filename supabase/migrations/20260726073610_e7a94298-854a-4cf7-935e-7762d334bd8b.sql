ALTER TABLE public.scheduled_approvals ADD COLUMN IF NOT EXISTS media JSONB;
ALTER TABLE public.planned_posts ADD COLUMN IF NOT EXISTS media JSONB;