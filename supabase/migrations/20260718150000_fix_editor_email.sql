-- Correct the editor email typo that an earlier migration inserted:
-- itamar@enso.com should be itamar@enso.bot.
DELETE FROM public.invited_emails WHERE email = 'itamar@enso.com';

INSERT INTO public.invited_emails (email, invited_by) VALUES
  ('itamar@enso.bot', 'setup')
ON CONFLICT (email) DO NOTHING;
