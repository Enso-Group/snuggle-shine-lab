// Research-promise engine flow tests: REAL processResearchJob / watchdog code
// with fakes at the edges (in-memory Supabase, recording Whapi, mocked callLLM
// and Tavily module). humanPacing false ⇒ no pacing sleeps, no fake timers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLLMMock, tavilyMock, tavilyConfiguredMock } = vi.hoisted(() => ({
  callLLMMock: vi.fn(),
  tavilyMock: vi.fn(),
  tavilyConfiguredMock: vi.fn(() => true),
}));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});
vi.mock("@/lib/tavily.server", () => ({
  isTavilyConfigured: tavilyConfiguredMock,
  tavilySearch: tavilyMock,
}));

import type { LLMCallInput, LLMCallResult } from "@/lib/llm.server";
import { deferJob } from "../queue.server";
import {
  buildResearchPayload,
  interimLineFor,
  RESEARCH_JOB_KIND,
  type ResearchJobPayload,
} from "../research";
import { processResearchJob, sendOverdueResearchInterims } from "../research.server";
import type { AgentDeps, BotJob } from "../types";
import {
  CONV_ID,
  DM_CHAT_ID,
  makeFakeSupa,
  makeFakeWhapi,
  seedDmTables,
  type FakeSupa,
  type Row,
} from "./fake-supa";

const ANSWER_TEXT = "בדקתי — חבילת הפרימיום עולה 100₪ לחודש.";
const ANSWER_JSON = JSON.stringify({ messages: [ANSWER_TEXT], reasoning: "Answered from search." });
const PROMISE_TEXT = "אבדוק ואחזור אליך עם תשובה";

const TAVILY_HIT = {
  answer: "Premium costs 100 ILS per month.",
  results: [{ title: "Pricing", url: "https://x.test/p", content: "Premium 100 ILS", score: 0.9 }],
};

function answerLLM() {
  callLLMMock.mockImplementation(async (input: LLMCallInput): Promise<LLMCallResult> => {
    if (input.source !== "agent_research_answer") {
      throw new Error(`no LLM handler for source "${input.source}"`);
    }
    return { content: ANSWER_JSON, model: "test-model", toolCalls: [], finishReason: "stop" };
  });
}

function makeResearchJob(opts: {
  promisedAtMs: number;
  status?: string;
  attempts?: number;
  payloadPatch?: Partial<ResearchJobPayload>;
  lockedUntil?: string | null;
}): BotJob {
  const payload = {
    ...buildResearchPayload({
      question: "premium plan price",
      promisedAtMs: opts.promisedAtMs,
      language: "he",
      personWaId: "972500000777",
      sourceBody: "כמה עולה חבילת פרימיום?",
      promiseText: PROMISE_TEXT,
    }),
    ...opts.payloadPatch,
  };
  return {
    id: "research-job-1",
    kind: RESEARCH_JOB_KIND,
    chat_id: DM_CHAT_ID,
    conversation_id: CONV_ID,
    payload: payload as unknown as BotJob["payload"],
    status: opts.status ?? "processing",
    attempts: opts.attempts ?? 1,
    max_attempts: 3,
    run_after: new Date(opts.promisedAtMs).toISOString(),
    locked_until: opts.lockedUntil ?? null,
    locked_by: "worker-test",
    last_error: null,
    created_at: new Date(opts.promisedAtMs + 1_000).toISOString(),
    updated_at: new Date(opts.promisedAtMs + 1_000).toISOString(),
  };
}

/** Seed a DM where the promise already went out and the job row exists. */
function seedResearch(nowMs: number, job: BotJob): FakeSupa {
  const promisedAt = (job.payload as unknown as ResearchJobPayload).promised_at;
  const fake = makeFakeSupa(seedDmTables(nowMs));
  const conv = fake.state.conversations[0];
  conv.last_outbound_at = new Date(promisedAt).toISOString();
  conv.last_outbound_body = PROMISE_TEXT;
  conv.consecutive_outbound = 1;
  fake.state.messages.push({
    id: "msg-promise",
    conversation_id: CONV_ID,
    direction: "outbound",
    sender_id: "bot",
    sender_name: "נציג",
    body: PROMISE_TEXT,
    created_at: new Date(promisedAt).toISOString(),
  });
  fake.state.bot_jobs.push(job as unknown as Row);
  return fake;
}

function makeDeps(fake: FakeSupa, whapi: ReturnType<typeof makeFakeWhapi>): AgentDeps {
  return {
    supabase: fake.client,
    whapi: whapi.port,
    trigger: "inbound",
    workerId: "worker-test",
    humanPacing: false,
  };
}

function decisions(fake: FakeSupa): Row[] {
  return fake.inserts.bot_decisions ?? [];
}

// logDecision is fire-and-forget — let its queued inserts land before asserting.
const flushLogs = () => new Promise((r) => setTimeout(r, 0));

function jobRow(fake: FakeSupa): Row {
  return fake.state.bot_jobs.find((j) => j.id === "research-job-1")!;
}

beforeEach(() => {
  callLLMMock.mockReset();
  tavilyMock.mockReset();
  tavilyConfiguredMock.mockReturnValue(true);
});

describe("processResearchJob", () => {
  it("searches, drafts and delivers the promised answer inside the deadline", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue(TAVILY_HIT);
    answerLLM();
    // Promise went out 4 minutes ago — past the anti-ban min-gap, well inside
    // the 10-minute deadline.
    const job = makeResearchJob({ promisedAtMs: now - 4 * 60_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome).toEqual({ action: "replied", parts: [ANSWER_TEXT] });
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: ANSWER_TEXT }]);
    // Search results reached the draft prompt.
    const draftInput = callLLMMock.mock.calls[0][0] as LLMCallInput;
    expect(draftInput.messages[0].content).toContain("Premium 100 ILS");
    // The answer was cached for deferral/dedup before sending.
    const payload = jobRow(fake).payload as ResearchJobPayload;
    expect(payload.answer_parts).toEqual([ANSWER_TEXT]);
    // The deliver decision proves the deadline was met.
    await flushLogs();
    const deliver = decisions(fake).find((d) => d.stage === "deliver");
    expect(deliver).toBeTruthy();
    expect((deliver!.data as { deadline_met: boolean }).deadline_met).toBe(true);
  });

  it("defers the send (answer cached, attempt refunded later) while the anti-ban min-gap holds", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue(TAVILY_HIT);
    answerLLM();
    // Promise just 30s ago — the 3-min gap guard must block the send.
    const job = makeResearchJob({ promisedAtMs: now - 30_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("deferred");
    if (outcome.action === "deferred") {
      // Rescheduled to just past the gap: last outbound + 3 min + buffer.
      expect(outcome.runAfterMs).toBeGreaterThan(now - 30_000 + 3 * 60_000);
      expect(outcome.runAfterMs).toBeLessThan(now + 4 * 60_000);
    }
    expect(whapi.sends).toEqual([]);
    // Research was NOT wasted — the answer rides along in the payload.
    expect((jobRow(fake).payload as ResearchJobPayload).answer_parts).toEqual([ANSWER_TEXT]);
  });

  it("sends the cached answer without re-running search or LLM after a deferral", async () => {
    const now = Date.now();
    const job = makeResearchJob({
      promisedAtMs: now - 4 * 60_000,
      payloadPatch: { answer_parts: [ANSWER_TEXT] },
    });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    expect(whapi.sends.map((s) => s.body)).toEqual([ANSWER_TEXT]);
    expect(tavilyMock).not.toHaveBeenCalled();
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it("no material early on: alerts the admin once and stays alive until the interim window — never a doomed min-gap interim", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue({ answer: null, results: [] });
    // 1 minute after the promise: an interim now would be min-gap-blocked
    // deterministically, so the job must defer, not burn its one interim.
    const job = makeResearchJob({ promisedAtMs: now - 60_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("deferred");
    if (outcome.action === "deferred") {
      // Wakes up in the interim window, not before.
      expect(outcome.runAfterMs).toBeGreaterThanOrEqual(now - 60_000 + 7.5 * 60_000);
    }
    expect(whapi.sends).toEqual([]);
    expect(callLLMMock).not.toHaveBeenCalled();
    const alerts = (fake.inserts.commands_log ?? []).filter((r) =>
      String(r.prompt).includes("Research promise needs a human"),
    );
    expect(alerts).toHaveLength(1);
    const payload = jobRow(fake).payload as ResearchJobPayload;
    expect(payload.escalated_alerted).toBe(true);
    expect(payload.interim_sent).toBeFalsy();
  });

  it("no material past the interim window: sends the interim (gap long clear) and hands off to a human", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue({ answer: null, results: [] });
    // 8 minutes after the promise — interim due, min-gap cleared.
    const job = makeResearchJob({
      promisedAtMs: now - 8 * 60_000,
      payloadPatch: { escalated_alerted: true },
    });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome).toEqual({ action: "skipped", reason: "escalated to human" });
    expect(whapi.sends.map((s) => s.body)).toEqual([interimLineFor("he")]);
    expect(callLLMMock).not.toHaveBeenCalled();
    // Alert already fired on the earlier attempt — never twice.
    const alerts = (fake.inserts.commands_log ?? []).filter((r) =>
      String(r.prompt).includes("Research promise needs a human"),
    );
    expect(alerts).toHaveLength(0);
    expect((jobRow(fake).payload as ResearchJobPayload).interim_sent).toBe(true);
  });

  it("names the missing TAVILY_API_KEY in the escalation when search is unconfigured", async () => {
    const now = Date.now();
    tavilyConfiguredMock.mockReturnValue(false);
    const job = makeResearchJob({ promisedAtMs: now - 60_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("deferred");
    expect(tavilyMock).not.toHaveBeenCalled();
    const alert = (fake.inserts.commands_log ?? []).find((r) =>
      String(r.prompt).includes("[ALERT]"),
    );
    expect(String(alert!.prompt)).toContain("TAVILY_API_KEY not configured");
  });

  it("a transient search failure with attempts left throws for a queue retry instead of escalating", async () => {
    const now = Date.now();
    tavilyMock.mockRejectedValue(new Error("Tavily request timed out"));
    const job = makeResearchJob({ promisedAtMs: now - 60_000, attempts: 1 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    await expect(processResearchJob(makeDeps(fake, whapi), job)).rejects.toThrow(
      "research search failed",
    );
    expect(whapi.sends).toEqual([]);
    expect(fake.inserts.commands_log ?? []).toHaveLength(0);
  });

  it("yields to a runnable DM reply job — the fresher reply goes first", async () => {
    const now = Date.now();
    const job = makeResearchJob({
      promisedAtMs: now - 4 * 60_000,
      payloadPatch: { answer_parts: [ANSWER_TEXT] },
    });
    const fake = seedResearch(now, job);
    fake.state.bot_jobs.push({
      id: "reply-job-live",
      kind: "inbound_reply",
      chat_id: DM_CHAT_ID,
      conversation_id: CONV_ID,
      payload: {},
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      run_after: new Date(now + 5_000).toISOString(),
      created_at: new Date(now - 10_000).toISOString(),
      updated_at: new Date(now - 10_000).toISOString(),
    });
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("deferred");
    if (outcome.action === "deferred") expect(outcome.reason).toContain("yield");
    expect(whapi.sends).toEqual([]);
  });

  it("throws (for retry) when the answer draft comes back with no usable messages", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue(TAVILY_HIT);
    callLLMMock.mockResolvedValue({
      content: JSON.stringify({ messages: [], reasoning: "empty" }),
      model: "test-model",
      toolCalls: [],
      finishReason: "stop",
    });
    const job = makeResearchJob({ promisedAtMs: now - 4 * 60_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    await expect(processResearchJob(makeDeps(fake, whapi), job)).rejects.toThrow(
      "research answer draft had no messages",
    );
    expect(whapi.sends).toEqual([]);
  });

  it("gives up loudly on a stale job far past the deadline", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 50 * 60_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome).toEqual({ action: "skipped", reason: "gave up (stale)" });
    expect(whapi.sends).toEqual([]);
    const alert = (fake.inserts.commands_log ?? []).find((r) =>
      String(r.prompt).includes("gave up"),
    );
    expect(alert).toBeTruthy();
  });

  it("stands down when the owner already replied manually", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 4 * 60_000 });
    const fake = seedResearch(now, job);
    fake.state.messages.push({
      id: "msg-manual",
      conversation_id: CONV_ID,
      direction: "outbound",
      sender_id: "manual",
      sender_name: "Itamar",
      body: "היי, בדקתי — המחיר 100₪",
      created_at: new Date(now - 60_000).toISOString(),
    });
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome).toEqual({ action: "skipped", reason: "owner replied manually" });
    expect(whapi.sends).toEqual([]);
    expect(tavilyMock).not.toHaveBeenCalled();
  });

  it("dedups on retry when a previous attempt already delivered the answer", async () => {
    const now = Date.now();
    const job = makeResearchJob({
      promisedAtMs: now - 6 * 60_000,
      attempts: 2,
      payloadPatch: { answer_parts: [ANSWER_TEXT] },
    });
    const fake = seedResearch(now, job);
    fake.state.messages.push({
      id: "msg-answer-sent",
      conversation_id: CONV_ID,
      direction: "outbound",
      sender_id: "bot",
      sender_name: "נציג",
      body: ANSWER_TEXT,
      created_at: new Date(now - 60_000).toISOString(),
    });
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome).toEqual({ action: "skipped", reason: "answer already delivered" });
    expect(whapi.sends).toEqual([]);
  });

  it("respects the research_enabled kill switch", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 4 * 60_000 });
    const fake = seedResearch(now, job);
    fake.state.bot_settings[0].agent_config = { research_enabled: false };
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome).toEqual({ action: "skipped", reason: "research disabled" });
    expect(whapi.sends).toEqual([]);
  });

  it("a late attempt just answers — no interim that would trip the min-gap and delay it further", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue(TAVILY_HIT);
    answerLLM();
    // 8 minutes since the promise — past the interim threshold, but this
    // attempt is LIVE: delivering now beats an interim + a 3-min deferral.
    const job = makeResearchJob({ promisedAtMs: now - 8 * 60_000 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    expect(whapi.sends.map((s) => s.body)).toEqual([ANSWER_TEXT]);
  });

  it("answers promptly after a watchdog interim once the gap clears", async () => {
    const now = Date.now();
    tavilyMock.mockResolvedValue(TAVILY_HIT);
    answerLLM();
    // Watchdog sent the interim 4 minutes ago; the gap since it has cleared.
    const job = makeResearchJob({
      promisedAtMs: now - 12 * 60_000,
      payloadPatch: { interim_sent: true },
    });
    const fake = seedResearch(now, job);
    const conv = fake.state.conversations[0];
    conv.last_outbound_at = new Date(now - 4 * 60_000).toISOString();
    conv.last_outbound_body = interimLineFor("he");
    conv.consecutive_outbound = 2;
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    expect(whapi.sends.map((s) => s.body)).toEqual([ANSWER_TEXT]);
    // Honest bookkeeping: the deadline was missed and the decision says so.
    await flushLogs();
    const deliver = decisions(fake).find((d) => d.stage === "deliver");
    expect((deliver!.data as { deadline_met: boolean }).deadline_met).toBe(false);
  });
});

describe("sendOverdueResearchInterims (deadline watchdog)", () => {
  it("sends one interim for an overdue backing-off job, and never twice", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 8 * 60_000, status: "pending" });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();
    const deps = makeDeps(fake, whapi);

    const first = await sendOverdueResearchInterims(deps);
    expect(first.sent).toBe(1);
    expect(whapi.sends.map((s) => s.body)).toEqual([interimLineFor("he")]);
    expect((jobRow(fake).payload as ResearchJobPayload).interim_sent).toBe(true);

    const second = await sendOverdueResearchInterims(deps);
    expect(second.sent).toBe(0);
    expect(whapi.sends).toHaveLength(1);
  });

  it("revives a failed job once for a cheap final attempt instead of giving up", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 9 * 60_000, status: "failed", attempts: 3 });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const run = await sendOverdueResearchInterims(makeDeps(fake, whapi));

    expect(run.results.map((r) => r.action)).toContain("revived");
    const row = jobRow(fake);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect((row.payload as ResearchJobPayload).revived).toBe(true);
    // No interim yet — the revived attempt is imminent and may still answer.
    expect(whapi.sends).toEqual([]);
  });

  it("a job that died AGAIN after its revive alerts the admin once, then the next sweep sends the interim", async () => {
    const now = Date.now();
    const job = makeResearchJob({
      promisedAtMs: now - 9 * 60_000,
      status: "failed",
      attempts: 3,
      payloadPatch: { revived: true },
    });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();
    const deps = makeDeps(fake, whapi);

    const first = await sendOverdueResearchInterims(deps);
    expect(first.results.map((r) => r.action)).toContain("alerted");
    const alert = (fake.inserts.commands_log ?? []).find((r) =>
      String(r.prompt).includes("Research promise is DEAD"),
    );
    expect(alert).toBeTruthy();
    expect(whapi.sends).toEqual([]);

    const second = await sendOverdueResearchInterims(deps);
    expect(second.sent).toBe(1);
    expect(whapi.sends.map((s) => s.body)).toEqual([interimLineFor("he")]);
    // Alert fired exactly once across both sweeps.
    const alerts = (fake.inserts.commands_log ?? []).filter((r) =>
      String(r.prompt).includes("Research promise is DEAD"),
    );
    expect(alerts).toHaveLength(1);
  });

  it("leaves fresh jobs and genuinely live-locked processing jobs alone", async () => {
    const now = Date.now();
    const freshJob = makeResearchJob({ promisedAtMs: now - 2 * 60_000, status: "pending" });
    const fake = seedResearch(now, freshJob);
    // Attempt started ~10s ago (locks last 3 min): worker is alive — its own
    // delivery is imminent, an interim on top would be noise.
    const lockedJob = {
      ...makeResearchJob({
        promisedAtMs: now - 8 * 60_000,
        status: "processing",
        lockedUntil: new Date(now + 170_000).toISOString(),
      }),
      id: "research-job-2",
    };
    fake.state.bot_jobs.push(lockedJob as unknown as Row);
    const whapi = makeFakeWhapi();

    const run = await sendOverdueResearchInterims(makeDeps(fake, whapi));

    expect(run.sent).toBe(0);
    expect(whapi.sends).toEqual([]);
  });

  it("does NOT trust a stale processing lock — a wall-killed worker's job still gets its interim", async () => {
    const now = Date.now();
    // Attempt started ~2 minutes ago (lock has ~1 min left): no real attempt
    // lives that long — the worker died mid-run and will send nothing.
    const job = makeResearchJob({
      promisedAtMs: now - 8 * 60_000,
      status: "processing",
      lockedUntil: new Date(now + 60_000).toISOString(),
    });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const run = await sendOverdueResearchInterims(makeDeps(fake, whapi));

    expect(run.sent).toBe(1);
    expect(whapi.sends.map((s) => s.body)).toEqual([interimLineFor("he")]);
  });

  it("retires the job instead of texting 'still checking' after the owner answered manually", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 8 * 60_000, status: "pending" });
    const fake = seedResearch(now, job);
    fake.state.messages.push({
      id: "msg-manual-2",
      conversation_id: CONV_ID,
      direction: "outbound",
      sender_id: "manual",
      sender_name: "Itamar",
      body: "בדקתי — הנה התשובה",
      created_at: new Date(now - 60_000).toISOString(),
    });
    const whapi = makeFakeWhapi();

    const run = await sendOverdueResearchInterims(makeDeps(fake, whapi));

    expect(run.sent).toBe(0);
    expect(whapi.sends).toEqual([]);
    expect(jobRow(fake).status).toBe("done");
  });

  it("rolls the interim flag back on a temporary guard block so a later sweep retries", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 8 * 60_000, status: "pending" });
    const fake = seedResearch(now, job);
    // A follow-up went out 1 minute ago: min_gap blocks the interim NOW, but
    // must not consume it forever.
    const conv = fake.state.conversations[0];
    conv.last_outbound_at = new Date(now - 60_000).toISOString();
    conv.consecutive_outbound = 2;
    const whapi = makeFakeWhapi();

    const run = await sendOverdueResearchInterims(makeDeps(fake, whapi));

    expect(run.sent).toBe(0);
    expect(whapi.sends).toEqual([]);
    expect(run.results.map((r) => r.action)).toContain("guard_blocked");
    expect((jobRow(fake).payload as ResearchJobPayload).interim_sent).toBe(false);
  });

  it("a revived attempt resumes from the cached search and drafts with the fast tail model", async () => {
    const now = Date.now();
    answerLLM();
    const job = makeResearchJob({
      promisedAtMs: now - 9 * 60_000,
      attempts: 1,
      payloadPatch: { revived: true, search_results: TAVILY_HIT },
    });
    const fake = seedResearch(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processResearchJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    // Cached search used — no second Tavily bill, no search latency.
    expect(tavilyMock).not.toHaveBeenCalled();
    // Cheap draft: tight budget + the chain-tail model leads.
    const draftInput = callLLMMock.mock.calls[0][0] as LLMCallInput;
    expect(draftInput.budgetMs).toBe(12_000);
    expect(draftInput.overrides?.model_strong).toBeTruthy();
  });
});

describe("deferJob", () => {
  it("reschedules without burning the claim attempt", async () => {
    const now = Date.now();
    const job = makeResearchJob({ promisedAtMs: now - 60_000, attempts: 2 });
    const fake = seedResearch(now, job);

    await deferJob(fake.client, job, { runAfterMs: now + 3 * 60_000, note: "min_gap" });

    const row = jobRow(fake);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(String(row.last_error)).toContain("deferred: min_gap");
    expect(new Date(String(row.run_after)).getTime()).toBe(now + 3 * 60_000);
  });
});
