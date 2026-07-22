-- Link queued-approval group posts to their approval row so deciding the
-- approval also moves the planned_posts row out of 'queued_approval'
-- (Upcoming posts) into 'sent' (Recent posts) or 'cancelled'.
ALTER TABLE public.scheduled_approvals
  ADD COLUMN IF NOT EXISTS planned_post_id UUID REFERENCES public.planned_posts(id) ON DELETE SET NULL;

-- Heal history: posts stuck in queued_approval whose approval was already
-- decided before this link existed. Match by group + body containment
-- (approval body is the post text; planned body may append the poll text).
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

-- Link approvals still waiting for a decision to their queued post so the
-- new approve/reject path can update it directly.
UPDATE public.scheduled_approvals a
SET planned_post_id = p.id
FROM public.planned_posts p
WHERE a.status = 'pending'
  AND a.source = 'group_post'
  AND a.planned_post_id IS NULL
  AND p.status = 'queued_approval'
  AND p.group_chat_id = a.target_chat_id
  AND strpos(p.body, a.body) > 0;
