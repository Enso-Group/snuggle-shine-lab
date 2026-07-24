ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS channel_phone TEXT;
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS channel_phone TEXT;
ALTER TABLE public.group_profiles ADD COLUMN IF NOT EXISTS channel_phone TEXT;

CREATE INDEX IF NOT EXISTS conversations_channel_idx ON public.conversations (channel_phone);
CREATE INDEX IF NOT EXISTS people_channel_idx ON public.people (channel_phone);
CREATE INDEX IF NOT EXISTS group_profiles_channel_idx ON public.group_profiles (channel_phone);

UPDATE public.conversations c
SET channel_phone = p.phone
FROM (
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id,
    regexp_replace(split_part(split_part(m.sender_id, '@', 1), ':', 1), '\D', '', 'g') AS phone
  FROM public.messages m
  WHERE (m.raw->>'from_me') = 'true'
    AND m.sender_id IS NOT NULL
  ORDER BY m.conversation_id, m.created_at DESC
) p
WHERE c.id = p.conversation_id
  AND c.channel_phone IS NULL
  AND p.phone <> '';

UPDATE public.people pe
SET channel_phone = c.channel_phone
FROM public.conversations c
WHERE pe.channel_phone IS NULL
  AND c.channel_phone IS NOT NULL
  AND c.is_group = false
  AND regexp_replace(split_part(split_part(c.whapi_chat_id, '@', 1), ':', 1), '\D', '', 'g')
    = regexp_replace(split_part(split_part(pe.wa_id, '@', 1), ':', 1), '\D', '', 'g');