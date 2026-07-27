ALTER TABLE public.group_profiles
  ADD COLUMN IF NOT EXISTS require_approval BOOLEAN;

COMMENT ON COLUMN public.group_profiles.require_approval IS
  'Per-group approval toggle: true = every send to this group waits for human approval; false = sends go out immediately; NULL = follow the global bot_settings.require_approval_all.';