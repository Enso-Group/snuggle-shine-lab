// Worker permanent-failure fallback: a DM whose reply job exhausted every
// attempt still gets the canned line — UNLESS a guard says the silence is
// allowed. Guards OUTRANK never-silent: blocked/anti-ban-limited chats and the
// kill switch must stay silent, and that must be visible in the decision log.
// The pipeline is mocked (its failure is the PRECONDITION here, not the thing
// under test); the queue, worker loop, anti-ban guard and fallback send all
// run for real against the shared in-memory Supabase.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { processInboundJobMock } = vi.hoisted(() => ({ processInboundJobMock: vi.fn() }));
vi.mock("../pipeline.server", () => ({
  // Real class shape so the worker's instanceof check behaves like production.
  PermanentJobError: class PermanentJobError extends Error {},
  processInboundJob: processInboundJobMock,
}));

import { PermanentJobError } from "../pipeline.server";
import { PERMANENT_FAILURE_FALLBACK_LINE, processQueuedJobs } from "../worker.server";
import type { AgentDeps, BotJob } from "../types";
import { CONV_ID, DM_CHAT_ID, makeFakeSupa, makeFakeWhapi, seedDmTables, type FakeSupa } from "./fake-supa";

function makeExhaustedJob(nowMs: number): BotJob {
  const ts = nowMs - 120_000;
  return {
    id: "job-exhausted",
    kind: "inbound_reply",
    chat_id: DM_CHAT_ID,
    conversation_id: CONV_ID,
    payload: {
      whapi_message_id: "wamid-in-1",
      body: "כמה עולה השירות?",
      sender_id: DM_CHAT_ID,
      sender_name: "דנה",
      chat_name: "דנה",
      is_group: false,
      ts,
      received_at: ts + 2_000,
    },
    status: "processing",
    // The claim RPC bumps attempts on claim — a job on its FINAL attempt is
    // claimed with attempts === max_attempts, which is the give-up condition.
    attempts: 3,
    max_attempts: 3,
    run_after: new Date(ts).toISOString(),
    locked_until: null,
    locked_by: "worker-test",
    last_error: null,
    created_at: new Date(ts).toISOString(),
    updated_at: new Date(ts).toISOString(),
  };
}

function makeDeps(fake: FakeSupa, whapi: ReturnType<typeof makeFakeWhapi>, job: BotJob): AgentDeps {
  // claim_bot_jobs is an RPC the fake doesn't model — hand the worker its job
  // directly, the way the real claim would.
  (fake.client as unknown as { rpc: () => Promise<{ data: BotJob[]; error: null }> }).rpc =
    async () => ({ data: [job], error: null });
  return { supabase: fake.client, whapi: whapi.port, trigger: "inbound", workerId: "worker-test", humanPacing: false };
}

const flushLogs = () => new Promise((r) => setTimeout(r, 0));

function fallbackDecisions(fake: FakeSupa): Array<{ summary?: unknown; data?: { code?: string } }> {
  return (fake.inserts.bot_decisions ?? []) as Array<{ summary?: unknown; data?: { code?: string } }>;
}

beforeEach(() => {
  processInboundJobMock.mockReset();
});

describe("processQueuedJobs — permanent-failure fallback vs the guards", () => {
  it("sends the canned line to a healthy DM when the job gives up (never-silent floor)", async () => {
    const nowMs = Date.now();
    const job = makeExhaustedJob(nowMs);
    const fake = makeFakeSupa(seedDmTables(nowMs));
    const whapi = makeFakeWhapi();
    processInboundJobMock.mockRejectedValue(new Error("LLM outage"));

    const run = await processQueuedJobs(makeDeps(fake, whapi, job));
    await flushLogs();

    expect(run.results).toEqual([{ jobId: job.id, outcome: { action: "failed", error: "LLM outage" } }]);
    // The contact got the canned line, persisted like any other outbound.
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: PERMANENT_FAILURE_FALLBACK_LINE }]);
    const outbound = (fake.inserts.messages ?? []).filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(PERMANENT_FAILURE_FALLBACK_LINE);
    // The admin alert about the give-up still fires alongside the fallback.
    expect((fake.inserts.commands_log ?? []).length).toBe(1);
  });

  it("guard OUTRANKS never-silent: a blocked conversation gets NO canned line, with a skipped decision naming the guard", async () => {
    const nowMs = Date.now();
    const job = makeExhaustedJob(nowMs);
    const seed = seedDmTables(nowMs);
    seed.conversations[0].blocked = true;
    const fake = makeFakeSupa(seed);
    const whapi = makeFakeWhapi();
    processInboundJobMock.mockRejectedValue(new Error("LLM outage"));

    await processQueuedJobs(makeDeps(fake, whapi, job));
    await flushLogs();

    // Allowed-silent: sending around a block is exactly what the guard stops.
    expect(whapi.sends).toEqual([]);
    const skips = fallbackDecisions(fake).filter(
      (d) => typeof d.summary === "string" && (d.summary as string).includes("Permanent-failure fallback blocked by the anti-ban guard"),
    );
    expect(skips).toHaveLength(1);
    expect(skips[0].data?.code).toBe("blocked");
  });

  it("respects the kill switch: bot disabled mid-retries means no canned line either", async () => {
    const nowMs = Date.now();
    const job = makeExhaustedJob(nowMs);
    const seed = seedDmTables(nowMs);
    seed.bot_settings[0].enabled = false;
    const fake = makeFakeSupa(seed);
    const whapi = makeFakeWhapi();
    processInboundJobMock.mockRejectedValue(new Error("LLM outage"));

    await processQueuedJobs(makeDeps(fake, whapi, job));
    await flushLogs();

    expect(whapi.sends).toEqual([]);
  });

  it("skips the fallback entirely on PermanentJobError — the account was just restricted, more traffic is exactly wrong", async () => {
    const nowMs = Date.now();
    const job = makeExhaustedJob(nowMs);
    const fake = makeFakeSupa(seedDmTables(nowMs));
    const whapi = makeFakeWhapi();
    processInboundJobMock.mockRejectedValue(new PermanentJobError("whatsapp restricted"));

    await processQueuedJobs(makeDeps(fake, whapi, job));
    await flushLogs();

    expect(whapi.sends).toEqual([]);
    // The give-up alert still reaches the admin.
    expect((fake.inserts.commands_log ?? []).length).toBe(1);
  });
});
