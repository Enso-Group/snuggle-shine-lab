// bot_jobs queue operations. All durable state lives in Postgres — the claim
// RPC (claim_bot_jobs) guarantees per-chat serialization across isolates.
import type { Supa } from "./types";
import { retryBackoffMs } from "./inbound";
import type { BotJob, InboundJobPayload } from "./types";

/**
 * Mark every still-pending inbound_reply job for the chat superseded.
 * Used by enqueue only — "a newer message's job absorbs older pending ones
 * into its context", which is always true at enqueue time because the new
 * job's history covers everything before it. The pipeline's consolidation
 * stage must NOT use this chat-wide sweep: a job enqueued while consolidation
 * was running answers a message the consolidated reply never saw, so the
 * pipeline retires an explicit id snapshot instead (supersedeJobsByIds).
 * Jobs already claimed ('processing') are untouched — the claim RPC
 * serializes per chat, so at most one is in flight.
 */
export async function supersedePendingReplies(supabase: Supa, chatId: string): Promise<void> {
  await supabase
    .from("bot_jobs")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("kind", "inbound_reply")
    .eq("status", "pending");
}

/**
 * Supersede exactly the given jobs (and only while still pending). The
 * pipeline's consolidation stage snapshots the chat's pending job ids BEFORE
 * its LLM call and retires only that snapshot after the reply is confirmed to
 * cover them — anything enqueued DURING the call is for a message the
 * consolidated reply does not cover, and killing it would silently drop that
 * message's answer.
 */
export async function supersedeJobsByIds(supabase: Supa, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await supabase
    .from("bot_jobs")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "pending");
}

/**
 * Does the job payload's message timestamp cover (>=) the given inbound ts?
 * payload is jsonb and may surface as an object or a JSON string depending on
 * the client path — parsed here, never in SQL. Exported for unit tests.
 */
export function jobPayloadCoversTs(payload: unknown, tsMs: number): boolean {
  try {
    const p = typeof payload === "string" ? JSON.parse(payload) : payload;
    const ts = Number((p as { ts?: unknown } | null)?.ts);
    return Number.isFinite(ts) && ts >= tsMs;
  } catch {
    return false;
  }
}

/**
 * True when another live (pending/processing) inbound_reply job for this chat
 * already covers the newest inbound message — i.e. that job's payload.ts is at
 * or after it, so ITS cycle will produce the reply.
 *
 * Every "superseded" exit in the pipeline must check this first: a newer
 * inbound does NOT guarantee an owning job. Trivial messages ("תודה", "👍")
 * are acknowledged with a reaction in the inbound handler and never enqueue a
 * job, and unaddressed group chatter never passes the reply gate — returning
 * superseded on their account would leave the ORIGINAL message answered by
 * nobody (the never-silent product rule forbids exactly that).
 */
export async function hasOwningReplyJob(
  supabase: Supa,
  args: { chatId: string; excludeJobId: string; newestInboundTs: number },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("bot_jobs")
    .select("id, payload")
    .eq("chat_id", args.chatId)
    .eq("kind", "inbound_reply")
    .in("status", ["pending", "processing"])
    .neq("id", args.excludeJobId);
  if (error) {
    // Can't tell → assume no owner, so the current cycle answers itself. A
    // rare redundant-looking reply beats a silent drop.
    console.warn("[queue] owning-job lookup failed:", error.message);
    return false;
  }
  return (data ?? []).some((row) => jobPayloadCoversTs(row.payload, args.newestInboundTs));
}

export async function enqueueInboundReply(
  supabase: Supa,
  args: {
    chatId: string;
    conversationId: string;
    payload: InboundJobPayload;
    /** Relative debounce (groups/simulation). Ignored when runAfterMs is set. */
    delaySeconds?: number;
    /**
     * Absolute epoch-ms at which the job becomes runnable. This is how the DM
     * human-timing delay is made DURABLE: the sweeper claims the job near its
     * target instead of the webhook holding a Worker request open for it.
     */
    runAfterMs?: number;
  },
): Promise<string | null> {
  // A newer message supersedes any not-yet-started reply job for the chat:
  // its content is part of the history the newer job will read, so one
  // consolidated reply is sent instead of several stale ones.
  await supersedePendingReplies(supabase, args.chatId);

  const runAfterMs = args.runAfterMs ?? Date.now() + (args.delaySeconds ?? 0) * 1000;
  const { data, error } = await supabase
    .from("bot_jobs")
    .insert({
      kind: "inbound_reply",
      chat_id: args.chatId,
      conversation_id: args.conversationId,
      payload: args.payload,
      run_after: new Date(runAfterMs).toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    console.error("[queue] enqueue failed", error);
    return null;
  }
  return data?.id ?? null;
}

export async function claimJobs(
  supabase: Supa,
  args: { workerId: string; chatId?: string; limit?: number },
): Promise<BotJob[]> {
  const { data, error } = await supabase.rpc("claim_bot_jobs", {
    p_worker: args.workerId,
    p_limit: args.limit ?? 3,
    p_chat: args.chatId ?? undefined,
  });
  if (error) {
    console.error("[queue] claim failed", error);
    return [];
  }
  return (data ?? []) as BotJob[];
}

export async function completeJob(supabase: Supa, jobId: string, note?: string): Promise<void> {
  await supabase
    .from("bot_jobs")
    .update({
      status: "done",
      locked_until: null,
      last_error: note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

/**
 * Put a claimed job back in the queue for a specific time WITHOUT burning an
 * attempt — for deliberate deferrals (e.g. the research answer waiting out
 * the anti-ban min-gap), never for failures. The attempt counted at claim
 * time is refunded so max_attempts keeps meaning "real failures".
 */
export async function deferJob(
  supabase: Supa,
  job: BotJob,
  args: { runAfterMs: number; note: string },
): Promise<void> {
  await supabase
    .from("bot_jobs")
    .update({
      status: "pending",
      run_after: new Date(args.runAfterMs).toISOString(),
      attempts: Math.max(job.attempts - 1, 0),
      locked_until: null,
      last_error: `deferred: ${args.note}`.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}

export async function failJob(supabase: Supa, job: BotJob, error: string): Promise<void> {
  const permanent = job.attempts >= job.max_attempts;
  await supabase
    .from("bot_jobs")
    .update({
      status: permanent ? "failed" : "pending",
      run_after: permanent
        ? job.run_after
        : new Date(Date.now() + retryBackoffMs(job.attempts)).toISOString(),
      locked_until: null,
      last_error: error.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}
