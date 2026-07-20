// bot_jobs queue operations. All durable state lives in Postgres — the claim
// RPC (claim_bot_jobs) guarantees per-chat serialization across isolates.
import type { Supa } from "./types";
import { retryBackoffMs } from "./inbound";
import type { BotJob, InboundJobPayload } from "./types";

export async function enqueueInboundReply(
  supabase: Supa,
  args: {
    chatId: string;
    conversationId: string;
    payload: InboundJobPayload;
    delaySeconds: number;
  },
): Promise<string | null> {
  // A newer message supersedes any not-yet-started reply job for the chat:
  // its content is part of the history the newer job will read, so one
  // consolidated reply is sent instead of several stale ones.
  await supabase
    .from("bot_jobs")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("chat_id", args.chatId)
    .eq("kind", "inbound_reply")
    .eq("status", "pending");

  const { data, error } = await supabase
    .from("bot_jobs")
    .insert({
      kind: "inbound_reply",
      chat_id: args.chatId,
      conversation_id: args.conversationId,
      payload: args.payload,
      run_after: new Date(Date.now() + args.delaySeconds * 1000).toISOString(),
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
    p_chat: args.chatId ?? null,
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
