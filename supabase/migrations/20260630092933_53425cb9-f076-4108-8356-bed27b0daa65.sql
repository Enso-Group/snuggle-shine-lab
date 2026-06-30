CREATE POLICY "admins update own commands"
ON public.commands_log
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin') AND auth.uid() = user_id)
WITH CHECK (public.has_role(auth.uid(), 'admin') AND auth.uid() = user_id);