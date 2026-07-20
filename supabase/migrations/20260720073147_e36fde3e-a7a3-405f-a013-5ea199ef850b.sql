INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'admin'::public.app_role
FROM auth.users u
WHERE u.email IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM public.invited_emails i WHERE i.email = lower(u.email))
    OR lower(u.email) IN ('itamar.lw@icloud.com', 'itamarlw2011@gmail.com')
  )
ON CONFLICT (user_id, role) DO NOTHING;

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