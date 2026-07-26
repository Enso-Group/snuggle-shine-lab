
-- 1) invited_emails: explicit admin-only write policies (SELECT untouched)
DROP POLICY IF EXISTS "invited_emails_admin_insert" ON public.invited_emails;
DROP POLICY IF EXISTS "invited_emails_admin_update" ON public.invited_emails;
DROP POLICY IF EXISTS "invited_emails_admin_delete" ON public.invited_emails;

CREATE POLICY "invited_emails_admin_insert"
  ON public.invited_emails
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "invited_emails_admin_update"
  ON public.invited_emails
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "invited_emails_admin_delete"
  ON public.invited_emails
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 2) storage.objects — codify current behavior for the private 'media' bucket:
--    no direct anon/authenticated access. Service role bypasses RLS, so
--    server-side uploads and signed-URL creation continue to work.
DROP POLICY IF EXISTS "media_no_anon_select" ON storage.objects;
DROP POLICY IF EXISTS "media_no_anon_insert" ON storage.objects;
DROP POLICY IF EXISTS "media_no_anon_update" ON storage.objects;
DROP POLICY IF EXISTS "media_no_anon_delete" ON storage.objects;
DROP POLICY IF EXISTS "media_no_authenticated_select" ON storage.objects;
DROP POLICY IF EXISTS "media_no_authenticated_insert" ON storage.objects;
DROP POLICY IF EXISTS "media_no_authenticated_update" ON storage.objects;
DROP POLICY IF EXISTS "media_no_authenticated_delete" ON storage.objects;

-- Explicit deny-style policies: restrict to bucket_id='media' and evaluate
-- to false, so no anon/authenticated request can read or mutate objects.
-- Signed URLs are served by the storage service without RLS, so downloads
-- via signed URL keep working. Service role bypasses RLS entirely.
CREATE POLICY "media_no_anon_select"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'media' AND false);

CREATE POLICY "media_no_anon_insert"
  ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'media' AND false);

CREATE POLICY "media_no_anon_update"
  ON storage.objects FOR UPDATE TO anon
  USING (bucket_id = 'media' AND false)
  WITH CHECK (bucket_id = 'media' AND false);

CREATE POLICY "media_no_anon_delete"
  ON storage.objects FOR DELETE TO anon
  USING (bucket_id = 'media' AND false);

CREATE POLICY "media_no_authenticated_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'media' AND false);

CREATE POLICY "media_no_authenticated_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'media' AND false);

CREATE POLICY "media_no_authenticated_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'media' AND false)
  WITH CHECK (bucket_id = 'media' AND false);

CREATE POLICY "media_no_authenticated_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'media' AND false);
