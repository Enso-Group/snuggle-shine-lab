-- Remove chats (and their profiles) the account never participated in.
--
-- The live webhook used to persist every chat it merely observed, and the
-- first history-import run predated its participation guard — so the DB (and
-- the Profiles page it feeds) still holds conversations and people rows for
-- chats where our side never wrote a single message. The code no longer
-- creates such rows; this migration deletes the ones already saved.
--
-- "Participated" = the conversation has at least one message from our side:
--   * direction = 'outbound'  (bot replies, imports of our own messages), or
--   * raw->>'from_me' = 'true' (linked-phone messages stored by the webhook,
--     which records them with direction 'inbound').
--
-- Kept even without our-side messages (participation is imminent / pending a
-- human decision):
--   * conversations with a pending/processing bot_jobs row (reply in flight),
--   * conversations with a pending scheduled_approvals row (draft awaiting
--     the manager's approval).
--
-- messages / bot_jobs / bot_decisions / scheduled_approvals / follow_ups all
-- reference conversations with ON DELETE CASCADE, so deleting the
-- conversation removes the whole chat.

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

  -- Profiles: keep a person only if they're connected to a conversation the
  -- account participated in — as the 1:1 counterpart (same phone part, any
  -- @suffix spelling) or as a sender in it (e.g. a member of a managed group
  -- the bot writes in). Everyone else was merely observed.
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
