// Sweeper pass: stamp any conversation / person / group_profile that the
// scoping migration left with a NULL channel_phone. The migration provenance-
// tags everything it can from message history (from_me sender); whatever it
// can't classify (bot-only chats, group profiles) is defaulted here to the
// CURRENTLY connected account — the safe "keep it visible under this number"
// choice. Only ever fills NULLs, so it never overwrites a provenance tag or
// re-assigns a row that genuinely belongs to a different number.
import { getConnectedChannel, channelScopeReady } from "./channel.server";
import type { Supa } from "./types";

export type ChannelBackfillResult =
  | { ran: true; conversations: number; people: number; groupProfiles: number }
  | { ran: false; reason: string };

// channel_phone is added by the scoping migration and isn't in the generated
// types.ts yet, so reach these tables through a narrow structural interface
// rather than the typed client.
type CountRes = { count: number | null };
type ErrRes = { error: { message?: string } | null };
interface LooseBuilder {
  select(
    cols: string,
    opts: { count: "exact"; head: boolean },
  ): {
    is(col: string, val: null): Promise<CountRes>;
  };
  update(patch: Record<string, unknown>): { is(col: string, val: null): Promise<ErrRes> };
}
type ChannelTable = "conversations" | "people" | "group_profiles";

async function fillNulls(supabase: Supa, table: ChannelTable, phone: string): Promise<number> {
  const loose = (supabase as unknown as { from(t: ChannelTable): LooseBuilder }).from(table);
  // Count first so we can report how many were adopted (the update itself
  // doesn't return a count without extra round-trips).
  const { count } = await loose
    .select("id", { count: "exact", head: true })
    .is("channel_phone", null);
  if (!count) return 0;
  const { error } = await (supabase as unknown as { from(t: ChannelTable): LooseBuilder })
    .from(table)
    .update({ channel_phone: phone })
    .is("channel_phone", null);
  if (error) {
    console.error(`[channel-backfill] ${table} update failed`, error);
    return 0;
  }
  return count;
}

export async function backfillChannelPhone(supabase: Supa): Promise<ChannelBackfillResult> {
  try {
    if (!(await channelScopeReady(supabase))) {
      return { ran: false, reason: "channel_phone column not present yet" };
    }
    const { connected, phone } = await getConnectedChannel();
    // No connected account ⇒ nobody to attribute unclassified rows to. Leave
    // them NULL; provenance-tagged rows are already correctly scoped.
    if (!connected || !phone) return { ran: false, reason: "no connected account" };

    const conversations = await fillNulls(supabase, "conversations", phone);
    const people = await fillNulls(supabase, "people", phone);
    const groupProfiles = await fillNulls(supabase, "group_profiles", phone);
    return { ran: true, conversations, people, groupProfiles };
  } catch (e) {
    console.error("[channel-backfill] failed", e);
    return { ran: false, reason: String((e as Error)?.message ?? e) };
  }
}
