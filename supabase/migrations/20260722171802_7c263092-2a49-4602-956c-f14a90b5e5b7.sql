ALTER TABLE public.scheduled_approvals
  ADD COLUMN IF NOT EXISTS planned_post_id UUID REFERENCES public.planned_posts(id) ON DELETE SET NULL;

UPDATE public.planned_posts p
SET status = 'sent',
    sent_at = COALESCE(a.decided_at, now()),
    updated_at = now()
FROM public.scheduled_approvals a
WHERE p.status = 'queued_approval'
  AND a.source = 'group_post'
  AND a.status = 'approved'
  AND a.target_chat_id = p.group_chat_id
  AND strpos(p.body, a.body) > 0;

UPDATE public.planned_posts p
SET status = 'cancelled',
    updated_at = now()
FROM public.scheduled_approvals a
WHERE p.status = 'queued_approval'
  AND a.source = 'group_post'
  AND a.status = 'rejected'
  AND a.target_chat_id = p.group_chat_id
  AND strpos(p.body, a.body) > 0;

UPDATE public.scheduled_approvals a
SET planned_post_id = p.id
FROM public.planned_posts p
WHERE a.status = 'pending'
  AND a.source = 'group_post'
  AND a.planned_post_id IS NULL
  AND p.status = 'queued_approval'
  AND p.group_chat_id = a.target_chat_id
  AND strpos(p.body, a.body) > 0;