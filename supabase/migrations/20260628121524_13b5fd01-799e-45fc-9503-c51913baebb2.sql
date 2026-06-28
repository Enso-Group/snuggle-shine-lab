
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS inbound_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_outbound integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outbound_body text;

CREATE OR REPLACE FUNCTION public.distinct_outbound_chats_last_hour()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT conversation_id)::int
  FROM public.messages
  WHERE direction = 'outbound'
    AND created_at > now() - interval '1 hour';
$$;

REVOKE EXECUTE ON FUNCTION public.distinct_outbound_chats_last_hour() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distinct_outbound_chats_last_hour() TO service_role, authenticated;
