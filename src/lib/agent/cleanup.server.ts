// Self-healing cleanup of chats the account never participated in.
//
// Why this exists as a sweeper pass and not (only) a SQL migration: the
// Lovable Cloud database is reachable to us only through the app's own
// service-role client — pending SQL migrations sit unapplied until someone
// runs them in Lovable. This pass runs inside the every-minute sweeper, so a
// normal deploy is enough for the cleanup to happen, and it keeps the DB
// clean if leftovers ever reappear.
//
// "Participated" = the conversation has at least one message from our side:
// direction='outbound' (bot replies, imported own messages) or
// raw->>'from_me'='true' (linked-phone messages, stored as inbound).
// Conversations with a reply in flight (pending/processing job) or a draft
// awaiting approval are kept — participation is imminent / pending a human.
// Deleting a conversation cascades to its messages, jobs, decisions,
// approvals and follow-ups. Person profiles survive only when connected to a
// kept conversation (1:1 counterpart or a sender in it).
import { logDecision } from "./decisions.server";
import { planCleanup } from "./cleanup";
import type { Supa } from "./types";

// Re-check cadence. The first run after deploy does the real work; afterwards
// this is a cheap safety net, so a long gap keeps the sweeper light.
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_SUMMARY_PREFIX = "Non-participated cleanup";
const CHUNK = 100;

export type CleanupResult =
  | { ran: true; removedConversations: number; removedPeople: number }
  | { ran: false; reason: string };

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function cleanupNonParticipatedChats(
  supabase: Supa,
  opts: { force?: boolean } = {},
): Promise<CleanupResult> {
  try {
    if (!opts.force) {
      const { data: lastRun } = await supabase
        .from("bot_decisions")
        .select("created_at")
        .eq("stage", "config")
        .like("summary", `${CLEANUP_SUMMARY_PREFIX}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastRun && Date.now() - new Date(lastRun.created_at).getTime() < MIN_INTERVAL_MS) {
        return { ran: false, reason: "ran recently" };
      }
    }

    const [convsRes, outboundRes, fromMeRes, jobsRes, approvalsRes] = await Promise.all([
      supabase.from("conversations").select("id, whapi_chat_id").limit(5000),
      supabase.from("messages").select("conversation_id").eq("direction", "outbound").limit(20000),
      supabase.from("messages").select("conversation_id").eq("raw->>from_me", "true").limit(20000),
      supabase
        .from("bot_jobs")
        .select("conversation_id")
        .in("status", ["pending", "processing"])
        .limit(2000),
      supabase
        .from("scheduled_approvals")
        .select("conversation_id")
        .eq("status", "pending")
        .limit(2000),
    ]);
    const conversations = convsRes.data ?? [];
    if (convsRes.error || !conversations.length) {
      return { ran: false, reason: convsRes.error?.message ?? "no conversations" };
    }
    // A query failure must never widen the delete set — treat messages-query
    // errors as fatal for this run (missing participation data ⇒ everything
    // would look non-participated).
    if (outboundRes.error || fromMeRes.error) {
      return {
        ran: false,
        reason: `participation query failed: ${outboundRes.error?.message ?? fromMeRes.error?.message}`,
      };
    }

    const participatedConvIds = new Set<string>();
    for (const r of outboundRes.data ?? []) {
      if (r.conversation_id) participatedConvIds.add(r.conversation_id);
    }
    for (const r of fromMeRes.data ?? []) {
      if (r.conversation_id) participatedConvIds.add(r.conversation_id);
    }
    const protectedConvIds = new Set<string>();
    for (const r of jobsRes.data ?? []) {
      if (r.conversation_id) protectedConvIds.add(r.conversation_id);
    }
    for (const r of approvalsRes.data ?? []) {
      if (r.conversation_id) protectedConvIds.add(r.conversation_id);
    }

    // Senders seen in kept conversations (for the people pass), gathered in
    // chunks so the .in() filter stays within URL limits.
    const keptIds = conversations
      .filter((c) => participatedConvIds.has(c.id) || protectedConvIds.has(c.id))
      .map((c) => c.id);
    const senderIdsInKeptConvs: string[] = [];
    for (const batch of chunked(keptIds, CHUNK)) {
      const { data } = await supabase
        .from("messages")
        .select("sender_id")
        .in("conversation_id", batch)
        .limit(20000);
      for (const r of data ?? []) if (r.sender_id) senderIdsInKeptConvs.push(r.sender_id);
    }

    const { data: people } = await supabase.from("people").select("id, wa_id").limit(5000);

    const plan = planCleanup({
      conversations,
      participatedConvIds,
      protectedConvIds,
      people: people ?? [],
      senderIdsInKeptConvs,
    });

    let removedConversations = 0;
    for (const batch of chunked(plan.convIdsToDelete, CHUNK)) {
      const { error } = await supabase.from("conversations").delete().in("id", batch);
      if (!error) removedConversations += batch.length;
      else console.error("[cleanup] conversation delete failed", error);
    }
    let removedPeople = 0;
    for (const batch of chunked(plan.personIdsToDelete, CHUNK)) {
      const { error } = await supabase.from("people").delete().in("id", batch);
      if (!error) removedPeople += batch.length;
      else console.error("[cleanup] people delete failed", error);
    }

    // Always logged (even 0/0) — the decision row is both the visibility in
    // Activity and the throttle marker for the next run.
    logDecision(supabase, {
      trigger: "scheduled",
      stage: "config",
      summary: `${CLEANUP_SUMMARY_PREFIX}: removed ${removedConversations} chat(s) and ${removedPeople} profile(s) the account never wrote in`,
      data: {
        removed_conversations: removedConversations,
        removed_people: removedPeople,
        kept_conversations: plan.keptConvIds.length,
      },
    });
    return { ran: true, removedConversations, removedPeople };
  } catch (e) {
    console.error("[cleanup] failed", e);
    return { ran: false, reason: String((e as Error)?.message ?? e) };
  }
}
