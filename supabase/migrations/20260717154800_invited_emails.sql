-- Invite-only access.
-- A signed-in user (via Google) may enter the dashboard only if their email is
-- present in public.invited_emails — or they are the admin. Writes happen through
-- admin-only server functions (service role); the client only checks its own row.
--
-- Existing users keep their access: we seed the list from the admin plus everyone
-- who is currently approved (has any row in user_roles). No user data is deleted.

CREATE TABLE IF NOT EXISTS public.invited_emails (
  email TEXT PRIMARY KEY,
  invited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emails are stored lowercased so lookups are case-insensitive and index-friendly.
ALTER TABLE public.invited_emails
  ADD CONSTRAINT invited_emails_email_lowercase CHECK (email = lower(email));

GRANT SELECT ON public.invited_emails TO authenticated;
GRANT ALL ON public.invited_emails TO service_role;

ALTER TABLE public.invited_emails ENABLE ROW LEVEL SECURITY;

-- A signed-in user may check whether THEIR OWN email is invited (used by the
-- client-side access guard). Admins may read the whole list.
CREATE POLICY "check own invitation or admin reads all" ON public.invited_emails
  FOR SELECT TO authenticated
  USING (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
    OR public.has_role(auth.uid(), 'admin')
  );

-- Seed: admin + everyone currently approved (has a user_roles row).
INSERT INTO public.invited_emails (email, invited_by)
SELECT DISTINCT lower(u.email), 'migration'
FROM auth.users u
WHERE u.email IS NOT NULL
  AND (
    lower(u.email) = 'itamar.lw@icloud.com'
    OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id)
  )
ON CONFLICT (email) DO NOTHING;
