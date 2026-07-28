-- Per-group master reply switch. false = the bot NEVER replies in this group;
-- true/NULL = replies allowed, but only via the smart addressing gate
-- (@-mention, reply to a bot message, the bot's name, or an owned question
-- when reply_to_questions is on). NULL keeps the legacy default (allowed) for
-- existing rows.
ALTER TABLE public.group_profiles
  ADD COLUMN IF NOT EXISTS reply_enabled BOOLEAN;

COMMENT ON COLUMN public.group_profiles.reply_enabled IS
  'Master reply switch for this group: false = never reply here; true/NULL = reply only to messages directed at the bot (mentions, replies to it, its name, owned questions).';
