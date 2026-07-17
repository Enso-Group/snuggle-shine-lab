-- Grant access to the initial set of people (invite-only gate).
--   itamarlw2011@gmail.com — administrator (also handled in src/lib/admin.ts so
--                            they see the admin pages).
--   itamar@enso.com        — editor (invited, non-admin).
--   omry@enso.bot          — editor (invited, non-admin).
-- Editors = invited users without admin rights: they get the main dashboard.
INSERT INTO public.invited_emails (email, invited_by) VALUES
  ('itamarlw2011@gmail.com', 'setup'),
  ('itamar@enso.com', 'setup'),
  ('omry@enso.bot', 'setup')
ON CONFLICT (email) DO NOTHING;
