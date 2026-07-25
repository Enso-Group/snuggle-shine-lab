// Worker loop: claim runnable jobs (per-chat serialized by the claim RPC) and
// run each through the pipeline. Called inline by the webhook for low latency
// and by the every-minute sweeper cron for retries and orphan recovery.
import type { Json } from "@/integrations/supabase/types";
import { claimJobs, completeJob, failJob } from "./queue.server";
import { logDecision } from "./decisions.server";
import { PermanentJobError, processInboundJob } from "./pipeline.server";
import type { AgentDeps, BotJob, PipelineOutcome } from "./types";

export type WorkerRunResult = {
  claimed: number;
  results: Array<{ jobId: string; outcome: PipelineOutcome | { action: "failed"; error: string } }>;
};

export async function processQueuedJobs(
  deps: AgentDeps,
  opts: { chatId?: string; max?: number } = {},
): Promise<WorkerRunResult> {
  const jobs = await claimJobs(deps.supabase, {
    workerId: deps.workerId,
    chatId: opts.chatId,
    limit: opts.max ?? 3,
  });

  const results: WorkerRunResult["results"] = [];
  for (const job of jobs) {
    try {
      const outcome = await runJob(deps, job);
      await completeJob(
        deps.supabase,
        job.id,
        outcome.action === "skipped" ? outcome.reason : undefined,
      );
      results.push({ jobId: job.id, outcome });
    } catch (e: unknown) {
      const err = e as Error;
      const permanent = err instanceof PermanentJobError;
      await failJob(
        deps.supabase,
        permanent ? { ...job, attempts: job.max_attempts } : job,
        String(err?.message ?? err),
      );
      // Out of retries = the contact gets silence. That must never pass
      // unnoticed — raise an admin alert (shows under Activity → Alerts).
      if (permanent || job.attempts >= job.max_attempts) {
        try {
          const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
          await raiseAdminAlert(
            deps.supabase,
            `Reply job gave up after ${job.attempts} attempts — ${job.chat_id} will get no answer. Last error: ${String(err?.message ?? err).slice(0, 300)}`,
          );
        } catch (alertErr) {
          console.error("[worker] failed to raise permanent-failure alert", alertErr);
        }
        // Never-silent rule for DMs: the alert tells the admin, this tells the
        // CONTACT. Skipped for PermanentJobError — that path means WhatsApp
        // restricted the account and the bot was just disabled, so sending
        // more traffic is exactly wrong.
        if (!permanent) await sendPermanentFailureFallback(deps, job);
      }
      results.push({
        jobId: job.id,
        outcome: { action: "failed", error: String(err?.message ?? err) },
      });
    }
  }
  return { claimed: jobs.length, results };
}

async function runJob(deps: AgentDeps, job: BotJob): Promise<PipelineOutcome> {
  if (job.kind === "inbound_reply") return processInboundJob(deps, job);
  // Unknown kinds (from a future deploy mid-rollout) are not retried forever.
  return { action: "skipped", reason: `unknown job kind: ${job.kind}` };
}

/**
 * Canned no-LLM line for a DM whose reply job exhausted every attempt — an
 * honest in-persona deferral: never mentions a system or a failure, just buys
 * time the way a busy human would.
 */
export const PERMANENT_FAILURE_FALLBACK_LINE =
  "היי, ראיתי את ההודעה שלך 🙏 אני צריך לבדוק משהו לפני שאענה — אחזור אליך בהקדם.";

// Last line of the never-silent guarantee: a DM whose job died after every
// retry still gets SOMETHING. Deliberately no LLM — the LLM path is exactly
// what just proved unreliable. Fully fenced: a fallback failure must never
// throw the worker loop.
async function sendPermanentFailureFallback(deps: AgentDeps, job: BotJob): Promise<void> {
  try {
    if (job.kind !== "inbound_reply" || !job.conversation_id) return;
    const p = job.payload;
    const isDm =
      !p.is_group &&
      !job.chat_id.endsWith("@g.us") &&
      !job.chat_id.endsWith("@simulation") &&
      deps.trigger !== "simulation";
    if (!isDm) return;

    // "Bot disabled" is an allowed-silent exception — never send around the
    // kill switch (it may have been flipped off mid-retries).
    const { data: settings } = await deps.supabase
      .from("bot_settings")
      .select("enabled, bot_name")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!settings?.enabled) return;

    // Crash-retry dedup: this path only runs after every attempt was spent,
    // so an outbound row newer than the message means some attempt DID send
    // before dying — a fallback on top would be a duplicate.
    const { data: alreadyReplied } = await deps.supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", job.conversation_id)
      .eq("direction", "outbound")
      .gt("created_at", new Date(p.ts).toISOString())
      .limit(1);
    if (alreadyReplied?.length) return;

    // Guards OUTRANK never-silent — guard-blocked is an allowed-silent case.
    // The canned line is still an outbound send, so it obeys the same
    // anti-ban gate as a normal reply: a fallback to a blocked contact (or
    // past the consecutive/min-gap limits) is exactly the traffic the guard
    // exists to stop.
    const { checkOutboundAllowed, loadConversationByChatId, recordOutbound } = await import(
      "@/lib/anti-ban.server"
    );
    const conv = await loadConversationByChatId(deps.supabase, job.chat_id);
    if (conv) {
      const guard = await checkOutboundAllowed(deps.supabase, conv, PERMANENT_FAILURE_FALLBACK_LINE);
      if (!guard.ok) {
        logDecision(deps.supabase, {
          job_id: job.id,
          conversation_id: job.conversation_id,
          chat_id: job.chat_id,
          trigger: deps.trigger,
          stage: "skipped",
          status: "skip",
          summary: `Permanent-failure fallback blocked by the anti-ban guard: ${guard.reason}`,
          data: { code: guard.code, fallback: "permanent_failure" },
        });
        return;
      }
    }

    const sendRes = await deps.whapi.sendText(job.chat_id, PERMANENT_FAILURE_FALLBACK_LINE);
    const whapiId = (sendRes as { message?: { id?: string } })?.message?.id ?? null;
    await deps.supabase.from("messages").insert({
      conversation_id: job.conversation_id,
      whapi_message_id: whapiId,
      direction: "outbound",
      sender_name: settings.bot_name || "Bot",
      sender_id: "bot",
      body: PERMANENT_FAILURE_FALLBACK_LINE,
      raw: sendRes as Json,
    });
    logDecision(deps.supabase, {
      job_id: job.id,
      conversation_id: job.conversation_id,
      chat_id: job.chat_id,
      trigger: deps.trigger,
      stage: "deliver",
      summary: "Reply job exhausted every attempt — sent the canned fallback line, not silence",
      data: {
        fallback: "permanent_failure",
        parts: [PERMANENT_FAILURE_FALLBACK_LINE],
        whapi_ids: [whapiId],
        latency_breakdown: {
          total_from_message_s: Math.round((Date.now() - p.ts) / 1000),
          attempt: job.attempts,
        },
      },
    });
    // Anti-ban counters must still see this outbound like any other reply.
    await recordOutbound(deps.supabase, job.conversation_id, PERMANENT_FAILURE_FALLBACK_LINE);
  } catch (e) {
    console.error("[worker] permanent-failure fallback send failed", e);
  }
}
