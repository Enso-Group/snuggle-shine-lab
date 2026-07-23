// Self-healing cleanup of chats and profiles the bot never engaged.
//
// Why this exists as a sweeper pass and not (only) a SQL migration: the
// Lovable Cloud database is reachable to us only through the app's own
// service-role client — SQL migrations depend on someone applying them in
// Lovable. This pass runs inside the every-minute sweeper, so a normal deploy
// is enough for the cleanup to happen, and it keeps the DB clean if leftovers
// ever reappear.
//
// Rules (see cleanup.ts for the rationale):
// * conversations: kept iff the ACCOUNT participated (outbound row or
//   from_me raw — imported own history counts) or participation is imminent
//   (pending/processing job, pending approval). Deleting a conversation
//   cascades to its messages, jobs, decisions, approvals and follow-ups.
// * person profiles: kept iff the BOT/dashboard engaged them — a
//   sender_id 'bot'/'manual' message in their 1:1 chat, bot-learned analysis
//   (facts / funnel stage / sentiment), or an imminent engagement.
import { planCleanup } from "./cleanup";
import type { Supa } from "./types";

// Re-check cadence. The first run after deploy does the real work; afterwards
// this is a cheap safety net, so a long gap keeps the sweeper light.
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Version marker in the summary: bump when the rules change so the throttle
// doesn't suppress the first run of a newer rule set.
const CLEANUP_SUMMARY_PREFIX = "Non-participated cleanup v2";
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

    const [convsRes, outboundRes, fromMeRes, botSentRes, jobsRes, approvalsRes, peopleRes] =
      await Promise.all([
        supabase.from("conversations").select("id, whapi_chat_id, is_group").limit(5000),
        supabase
          .from("messages")
          .select("conversation_id")
          .eq("direction", "outbound")
          .limit(20000),
        supabase
          .from("messages")
          .select("conversation_id")
          .eq("raw->>from_me", "true")
          .limit(20000),
        supabase
          .from("messages")
          .select("conversation_id")
          .eq("direction", "outbound")
          .in("sender_id", ["bot", "manual"])
          .limit(20000),
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
        supabase.from("people").select("id, wa_id, facts, funnel_stage, sentiment").limit(5000),
      ]);
    const conversations = convsRes.data ?? [];
    if (convsRes.error || !conversations.length) {
      return { ran: false, reason: convsRes.error?.message ?? "no conversations" };
    }
    // A query failure must never widen the delete set — missing participation
    // or engagement data would make everything look deletable.
    if (outboundRes.error || fromMeRes.error || botSentRes.error || peopleRes.error) {
      const failure = outboundRes.error ?? fromMeRes.error ?? botSentRes.error ?? peopleRes.error;
      return { ran: false, reason: `data query failed: ${failure?.message}` };
    }

    const toIdSet = (rows: Array<{ conversation_id: string | null }> | null | undefined) => {
      const set = new Set<string>();
      for (const r of rows ?? []) if (r.conversation_id) set.add(r.conversation_id);
      return set;
    };
    const participatedConvIds = toIdSet(outboundRes.data);
    for (const id of toIdSet(fromMeRes.data)) participatedConvIds.add(id);
    const protectedConvIds = toIdSet(jobsRes.data);
    for (const id of toIdSet(approvalsRes.data)) protectedConvIds.add(id);
    const botConvIds = toIdSet(botSentRes.data);

    const plan = planCleanup({
      conversations,
      participatedConvIds,
      protectedConvIds,
      botConvIds,
      people: (peopleRes.data ?? []).map((p) => ({
        id: p.id,
        wa_id: p.wa_id,
        factsCount: Array.isArray(p.facts) ? p.facts.length : 0,
        funnelStage: (p.funnel_stage as string | null) ?? null,
        sentiment: (p.sentiment as string | null) ?? null,
      })),
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
    // Activity and the throttle marker for the next run. AWAITED, not
    // fire-and-forget: on Cloudflare a pending promise left behind when the
    // response returns can be dropped, which would lose the marker and make
    // the cleanup re-run every sweep while the health check shows nothing.
    const { error: markerErr } = await supabase.from("bot_decisions").insert({
      trigger: "scheduled",
      stage: "config",
      status: "ok",
      summary: `${CLEANUP_SUMMARY_PREFIX}: removed ${removedConversations} chat(s) and ${removedPeople} profile(s) the bot never engaged`,
      data: {
        removed_conversations: removedConversations,
        removed_people: removedPeople,
        kept_conversations: plan.keptConvIds.length,
      },
    });
    if (markerErr) console.error("[cleanup] marker insert failed", markerErr);
    return { ran: true, removedConversations, removedPeople };
  } catch (e) {
    console.error("[cleanup] failed", e);
    return { ran: false, reason: String((e as Error)?.message ?? e) };
  }
}
