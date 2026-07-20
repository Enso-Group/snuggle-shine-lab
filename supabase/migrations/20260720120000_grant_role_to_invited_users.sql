-- Fix: invited users can sign in but see no data (empty Chats / zeroed stats).
--
-- Why it broke: RLS on conversations, messages, commands_log, bot_settings, …
-- is `public.has_role(auth.uid(), 'admin')`, which reads public.user_roles.
-- The 20260706140000_approval_based_access migration deleted every row in
-- user_roles and rewrote the on_auth_user_created trigger into a no-op, so only
-- itamar.lw@icloud.com kept a role. Everyone who signed up afterwards — the
-- Google admin account and the invited editors — has no role, so every
-- client-side query and every requireAdmin() server function returns
-- empty/denied even though the webhook is writing data correctly (it uses the
-- service role and bypasses RLS).
--
-- Access is now gated by public.invited_emails, so the DB role simply mirrors
-- that list: if you are invited, you get the role RLS checks for.

-- 1) Backfill: everyone currently invited (plus the admin emails).
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'admin'::public.app_role
FROM auth.users u
WHERE u.email IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM public.invited_emails i WHERE i.email = lower(u.email))
    OR lower(u.email) IN ('itamar.lw@icloud.com', 'itamarlw2011@gmail.com')
  )
ON CONFLICT (user_id, role) DO NOTHING;

-- 2) Grant it automatically when an invited person signs in for the first time
--    (the trigger fires on the auth.users INSERT that first sign-in creates).
CREATE OR REPLACE FUNCTION public.handle_first_user_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.invited_emails i WHERE i.email = lower(NEW.email))
       OR lower(NEW.email) IN ('itamar.lw@icloud.com', 'itamarlw2011@gmail.com')
     ) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
