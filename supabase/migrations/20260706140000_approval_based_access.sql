-- Approval-based access.
-- Model: a user is "approved" once they have a row in user_roles. New users get
-- no row (pending) until the admin approves them from the Approval Requests page.
-- The administrator is identified by email in the app (itamar.lw@icloud.com).

-- 1) New signups no longer receive a role automatically (they stay pending).
CREATE OR REPLACE FUNCTION public.handle_first_user_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;  -- no-op: users are pending until an admin approves them
END;
$$;

-- 2) Clean slate: clear existing roles so everyone starts pending and shows up
--    in Approval Requests (the admin re-approves whoever should have access).
DELETE FROM public.user_roles;

-- 3) Pre-approve the admin account (so its server-side/admin checks pass).
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role FROM auth.users
WHERE lower(email) = 'itamar.lw@icloud.com'
ON CONFLICT (user_id, role) DO NOTHING;
