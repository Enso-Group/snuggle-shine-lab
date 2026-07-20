// Worker loop: claim runnable jobs (per-chat serialized by the claim RPC) and
// run each through the pipeline. Called inline by the webhook for low latency
// and by the every-minute sweeper cron for retries and orphan recovery.
import { claimJobs, completeJob, failJob } from "./queue.server";
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
