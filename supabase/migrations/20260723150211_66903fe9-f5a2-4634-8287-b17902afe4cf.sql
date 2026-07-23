REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.distinct_outbound_chats_last_hour() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.claim_bot_jobs(text, integer, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.handle_first_user_admin() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.distinct_outbound_chats_last_hour() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_bot_jobs(text, integer, text) TO service_role;