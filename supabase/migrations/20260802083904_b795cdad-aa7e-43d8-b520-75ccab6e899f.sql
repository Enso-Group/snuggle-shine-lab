alter table public.scheduled_approvals add column if not exists channel_phone text;
alter table public.planned_posts       add column if not exists channel_phone text;
alter table public.bot_decisions       add column if not exists channel_phone text;
alter table public.moderation_actions  add column if not exists channel_phone text;
alter table public.group_insights      add column if not exists channel_phone text;
alter table public.group_daily_stats   add column if not exists channel_phone text;
alter table public.strategy_memos      add column if not exists channel_phone text;
alter table public.commands_log        add column if not exists channel_phone text;

create index if not exists scheduled_approvals_channel_idx on public.scheduled_approvals (channel_phone);
create index if not exists planned_posts_channel_idx       on public.planned_posts (channel_phone);
create index if not exists bot_decisions_channel_idx       on public.bot_decisions (channel_phone);
create index if not exists commands_log_channel_idx        on public.commands_log (channel_phone);

create or replace function public.backfill_channel_scope(p_phone text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_phone is null or p_phone = '' then
    return;
  end if;

  update public.conversations  set channel_phone = p_phone where channel_phone is null;
  update public.people         set channel_phone = p_phone where channel_phone is null;
  update public.group_profiles set channel_phone = p_phone where channel_phone is null;

  update public.planned_posts pp set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where pp.channel_phone is null and gp.chat_id = pp.group_chat_id and gp.channel_phone is not null;
  update public.scheduled_approvals sa set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where sa.channel_phone is null and gp.chat_id = sa.target_chat_id and gp.channel_phone is not null;
  update public.scheduled_approvals sa set channel_phone = c.channel_phone
    from public.conversations c
    where sa.channel_phone is null and c.whapi_chat_id = sa.target_chat_id and c.channel_phone is not null;
  update public.moderation_actions ma set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where ma.channel_phone is null and gp.chat_id = ma.group_chat_id and gp.channel_phone is not null;
  update public.group_insights gi set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where gi.channel_phone is null and gp.chat_id = gi.group_chat_id and gp.channel_phone is not null;
  update public.group_daily_stats gs set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where gs.channel_phone is null and gp.chat_id = gs.group_chat_id and gp.channel_phone is not null;
  update public.strategy_memos sm set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where sm.channel_phone is null and gp.chat_id = sm.group_chat_id and gp.channel_phone is not null;
  update public.bot_decisions bd set channel_phone = c.channel_phone
    from public.conversations c
    where bd.channel_phone is null and c.whapi_chat_id = bd.chat_id and c.channel_phone is not null;
  update public.bot_decisions bd set channel_phone = gp.channel_phone
    from public.group_profiles gp
    where bd.channel_phone is null and gp.chat_id = bd.chat_id and gp.channel_phone is not null;

  update public.scheduled_approvals set channel_phone = p_phone where channel_phone is null;
  update public.planned_posts       set channel_phone = p_phone where channel_phone is null;
  update public.bot_decisions       set channel_phone = p_phone where channel_phone is null;
  update public.moderation_actions  set channel_phone = p_phone where channel_phone is null;
  update public.group_insights      set channel_phone = p_phone where channel_phone is null;
  update public.group_daily_stats   set channel_phone = p_phone where channel_phone is null;
  update public.strategy_memos      set channel_phone = p_phone where channel_phone is null;
  update public.commands_log        set channel_phone = p_phone where channel_phone is null;
end;
$$;

revoke all on function public.backfill_channel_scope(text) from public, anon;
grant execute on function public.backfill_channel_scope(text) to service_role;