INSERT INTO public.bot_decisions (chat_id, trigger, stage, status, summary, data, created_at)
SELECT
  p.group_chat_id,
  'scheduled',
  'post',
  'ok',
  'Published a post in ' || COALESCE(g.name, p.group_chat_id) || ' (backfilled from planned_posts)',
  jsonb_build_object(
    'planned_post_id', p.id,
    'post', left(COALESCE(p.body, ''), 500),
    'backfilled', true
  ),
  COALESCE(p.sent_at, p.updated_at, p.created_at)
FROM public.planned_posts p
LEFT JOIN public.group_profiles g ON g.chat_id = p.group_chat_id
WHERE p.status = 'sent'
  AND NOT EXISTS (
    SELECT 1
    FROM public.bot_decisions d
    WHERE d.stage = 'post'
      AND d.data ->> 'planned_post_id' = p.id::text
  );