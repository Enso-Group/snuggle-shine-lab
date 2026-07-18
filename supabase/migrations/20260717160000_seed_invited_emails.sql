-- Grant access to the initial set of people (invite-only gate).
--   itamarlw2011@gmail.com — administrator (also handled in src/lib/admin.ts so
--                            they see the admin pages).
--   itamar@enso.bot        — editor (invited, non-admin).
--   omry@enso.bot          — editor (invited, non-admin).
-- Editors = invited users without admin rights: they get the main dashboard.
INSERT INTO public.invited_emails (email, invited_by) VALUES
  ('itamarlw2011@gmail.com', 'setup'),
  ('itamar@enso.bot', 'setup'),
  ('omry@enso.bot', 'setup')
ON CONFLICT (email) DO NOTHING;

-- Remove the earlier typo'd address in case a prior version of this migration
-- already inserted it.
DELETE FROM public.invited_emails WHERE email = 'itamar@enso.com';
