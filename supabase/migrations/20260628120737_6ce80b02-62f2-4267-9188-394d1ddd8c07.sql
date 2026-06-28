-- handle_first_user_admin is only used as an auth trigger; revoke all direct API execute
REVOKE EXECUTE ON FUNCTION public.handle_first_user_admin() FROM PUBLIC, anon, authenticated;

-- has_role is used in RLS policies scoped to the authenticated role; remove anon/public exposure
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;