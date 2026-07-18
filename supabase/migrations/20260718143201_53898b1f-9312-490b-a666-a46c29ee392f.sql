CREATE TABLE IF NOT EXISTS public.invited_emails (
  email TEXT PRIMARY KEY,
  invited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.invited_emails
  ADD CONSTRAINT invited_emails_email_lowercase CHECK (email = lower(email));

GRANT SELECT ON public.invited_emails TO authenticated;
GRANT ALL ON public.invited_emails TO service_role;

ALTER TABLE public.invited_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "check own invitation or admin reads all" ON public.invited_emails
  FOR SELECT TO authenticated
  USING (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
    OR public.has_role(auth.uid(), 'admin')
  );

INSERT INTO public.invited_emails (email, invited_by)
SELECT DISTINCT lower(u.email), 'migration'
FROM auth.users u
WHERE u.email IS NOT NULL
  AND (
    lower(u.email) = 'itamar.lw@icloud.com'
    OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id)
  )
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.invited_emails (email, invited_by) VALUES
  ('itamarlw2011@gmail.com', 'setup'),
  ('itamar@enso.com', 'setup'),
  ('omry@enso.bot', 'setup')
ON CONFLICT (email) DO NOTHING;