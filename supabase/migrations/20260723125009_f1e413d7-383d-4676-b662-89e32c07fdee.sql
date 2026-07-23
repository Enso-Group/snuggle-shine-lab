DO $cleanup$
DECLARE
  removed_convs INT;
  removed_people INT;
BEGIN
  WITH gone AS (
    DELETE FROM public.conversations c
    WHERE NOT EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.conversation_id = c.id
          AND (m.direction = 'outbound' OR (m.raw->>'from_me') = 'true')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.bot_jobs j
        WHERE j.conversation_id = c.id
          AND j.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.scheduled_approvals a
        WHERE a.conversation_id = c.id
          AND a.status = 'pending'
      )
    RETURNING 1
  )
  SELECT count(*) INTO removed_convs FROM gone;

  WITH participated AS (
    SELECT c.id, c.whapi_chat_id
    FROM public.conversations c
    WHERE EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.conversation_id = c.id
        AND (m.direction = 'outbound' OR (m.raw->>'from_me') = 'true')
    )
  ),
  gone AS (
    DELETE FROM public.people p
    WHERE NOT EXISTS (
      SELECT 1 FROM participated c
      WHERE split_part(c.whapi_chat_id, '@', 1) = split_part(p.wa_id, '@', 1)
         OR EXISTS (
           SELECT 1 FROM public.messages ms
           WHERE ms.conversation_id = c.id
             AND split_part(ms.sender_id, '@', 1) = split_part(p.wa_id, '@', 1)
         )
    )
    RETURNING 1
  )
  SELECT count(*) INTO removed_people FROM gone;

  RAISE NOTICE 'non-participated cleanup: removed % conversations, % people',
    removed_convs, removed_people;
END
$cleanup$;
CREATE TEMP TABLE IF NOT EXISTS _noop(x int);