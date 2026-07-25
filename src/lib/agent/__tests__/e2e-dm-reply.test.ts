// End-to-end-style DM reply tests: REAL pipeline code (processInboundJob and
// everything it pulls in — context, stages, safety gates, anti-ban, deliver)
// with fakes only at the edges: an in-memory Supabase, a recording Whapi port,
// and callLLM mocked per source tag (parseJsonLoose and every parser stay
// real). Fake timers make the deliver pacing sleeps instant + deterministic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only callLLM; vi.importActual keeps parseJsonLoose & co. real so the
// pipeline's actual JSON parsing/safety behavior is what gets exercised.
const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});

import type { LLMCallInput, LLMCallResult } from "@/lib/llm.server";
import { processInboundJob } from "../pipeline.server";
import type { AgentDeps, BotJob, InboundJobPayload } from "../types";
import {
  CONV_ID,
  DM_CHAT_ID,
  makeFakeSupa,
  makeFakeWhapi,
  seedDmTables,
  type FakeSupa,
  type Row,
} from "./fake-supa";

// ---------------------------------------------------------------------------
// LLM mock dispatch: one handler per ai_usage_log source tag. Regex keys let a
// test bind the consolidation stage without hardcoding its exact tag; any
// UNhandled source fails the call (which the pipeline must then survive or
// not, per stage contract) — no silent default answers.
// ---------------------------------------------------------------------------
type SourceHandler = [match: string | RegExp, respond: (input: LLMCallInput) => string];

function llmRespondsBySource(handlers: SourceHandler[]) {
  callLLMMock.mockImplementation(async (input: LLMCallInput): Promise<LLMCallResult> => {
    const hit = handlers.find(([m]) =>
      typeof m === "string" ? m === input.source : m.test(input.source),
    );
    if (!hit) throw new Error(`no LLM handler for source "${input.source}"`);
    return { content: hit[1](input), model: "test-model", toolCalls: [], finishReason: "stop" };
  });
}

function llmInputs(): LLMCallInput[] {
  return (callLLMMock.mock.calls as Array<[LLMCallInput]>).map(([input]) => input);
}

function callCount(match: string | RegExp): number {
  return llmInputs().filter((i) =>
    typeof match === "string" ? i.source === match : match.test(i.source),
  ).length;
}

const INTENT_JSON = JSON.stringify({
  intent: "asking about pricing",
  language: "he",
  urgency: "normal",
  sentiment: "curious",
  goal: "answer the pricing question",
  escalate: false,
  escalate_reason: null,
});

const DRAFT_TEXT = "המחיר תלוי בהיקף — אשמח לפרט לך בדיוק מה מקבלים 😊";
const DRAFT_JSON = JSON.stringify({
  messages: [DRAFT_TEXT],
  reasoning: "Answered the pricing question.",
});
const MEMORY_JSON = JSON.stringify({
  facts: [],
  language: null,
  sentiment: null,
  funnel_stage: null,
  follow_up: null,
});

// ---------------------------------------------------------------------------
// Job/deps builders around the shared DM seed.
// ---------------------------------------------------------------------------
function makeJob(nowMs: number, payloadOverrides: Partial<InboundJobPayload> = {}): BotJob {
  const ts = nowMs - 8_000;
  return {
    id: "job-under-test",
    kind: "inbound_reply",
    chat_id: DM_CHAT_ID,
    conversation_id: CONV_ID,
    payload: {
      whapi_message_id: "wamid-in-1",
      body: "כמה עולה השירות אצלכם?",
      sender_id: DM_CHAT_ID,
      sender_name: "דנה",
      chat_name: "דנה",
      is_group: false,
      ts,
      received_at: ts + 2_000,
      // Already past → no top-up wait; tests that want the wait override this.
      target_reply_at: nowMs - 1_000,
      ...payloadOverrides,
    },
    status: "processing",
    attempts: 1,
    max_attempts: 3,
    run_after: new Date(nowMs - 1_000).toISOString(),
    locked_until: null,
    locked_by: "worker-test",
    last_error: null,
    created_at: new Date(ts + 2_000).toISOString(),
    updated_at: new Date(ts + 2_000).toISOString(),
  };
}

function seedWithTrigger(nowMs: number, job: BotJob): FakeSupa {
  const fake = makeFakeSupa(seedDmTables(nowMs));
  // The trigger row is stored by the inbound handler with created_at = the
  // WhatsApp timestamp — the pipeline's newer-message checks are gt(ts), so
  // this row must NOT count as "newer" than itself.
  fake.state.messages.push({
    id: "msg-trigger",
    conversation_id: CONV_ID,
    direction: "inbound",
    sender_id: DM_CHAT_ID,
    sender_name: "דנה",
    body: job.payload.body,
    created_at: new Date(job.payload.ts).toISOString(),
  });
  return fake;
}

function makeDeps(fake: FakeSupa, whapi: ReturnType<typeof makeFakeWhapi>): AgentDeps {
  return {
    supabase: fake.client,
    whapi: whapi.port,
    trigger: "inbound",
    workerId: "worker-test",
    humanPacing: true,
  };
}

/**
 * Await a pipeline run under fake timers: repeatedly flush the timer queue
 * (deliver pacing + target top-up sleeps) until the outcome settles. Bounded
 * so a hung pipeline fails the test instead of freezing the runner.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  for (let i = 0; i < 500 && !done; i++) await vi.runAllTimersAsync();
  return tracked;
}

type DeliverDecision = Row & {
  stage?: string;
  data?: {
    fallback?: boolean;
    parts?: string[];
    latency_breakdown?: Record<string, unknown>;
  };
};

function deliverDecisions(fake: FakeSupa): DeliverDecision[] {
  return ((fake.inserts.bot_decisions ?? []) as DeliverDecision[]).filter(
    (d) => d.stage === "deliver",
  );
}

beforeEach(() => {
  callLLMMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-25T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processInboundJob — DM happy path", () => {
  it("replies with exactly one intent + one draft call, no critique, and a deliver decision carrying latency_breakdown", async () => {
    const nowMs = Date.now();
    const job = makeJob(nowMs);
    const fake = seedWithTrigger(nowMs, job);
    const whapi = makeFakeWhapi();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      ["agent_draft", () => DRAFT_JSON],
      ["agent_memory", () => MEMORY_JSON],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync(); // flush fire-and-forget decision inserts

    expect(outcome.action).toBe("replied");

    // The 60s SLA budget: exactly one call per reasoning stage, critique gone.
    expect(callCount("agent_intent")).toBe(1);
    expect(callCount("agent_draft")).toBe(1);
    expect(callCount("agent_critique")).toBe(0);

    // Every pre-send LLM call must carry timeoutMs + budgetMs — the runtime
    // kills requests at ~60s wall, so an unbudgeted retry ladder is a dead job.
    for (const input of llmInputs().filter((i) => i.source !== "agent_memory")) {
      expect(input.timeoutMs, `${input.source} timeoutMs`).toBeTypeOf("number");
      expect(input.budgetMs, `${input.source} budgetMs`).toBeTypeOf("number");
    }

    // One real send through the Whapi port, and the outbound row persisted.
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: DRAFT_TEXT }]);
    const outbound = (fake.inserts.messages ?? []).filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(DRAFT_TEXT);

    // The deliver decision is the SLA measurement row — it must break the
    // latency down and must not be flagged as a fallback.
    const delivers = deliverDecisions(fake);
    expect(delivers).toHaveLength(1);
    const breakdown = delivers[0].data?.latency_breakdown as Record<string, unknown>;
    expect(breakdown).toBeTruthy();
    expect(breakdown.total_from_message_s).toBeTypeOf("number");
    expect(breakdown.queue_wait_s).toBeTypeOf("number");
    expect(breakdown.llm_s).toBeTypeOf("number");
    expect(breakdown.attempt).toBe(1);
    expect(delivers[0].data?.fallback).not.toBe(true);
  });
});

describe("processInboundJob — newer-message consolidation", () => {
  it("folds a message that arrived mid-draft into ONE consolidated reply and supersedes the newer job", async () => {
    const nowMs = Date.now();
    // Target slightly ahead so the pre-send window (top-up wait + recheck)
    // definitely runs; fake timers make the wait instant.
    const job = makeJob(nowMs, { target_reply_at: nowMs + 3_000 });
    const fake = seedWithTrigger(nowMs, job);
    const whapi = makeFakeWhapi();

    const CONSOLIDATED_TEXT = "לגבי המחיר ולגבי שישי — עונה לך על שניהם יחד 😊";
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () => {
          // Mid-draft, a second message lands: its row + its pending reply job
          // appear exactly the way the inbound handler would create them.
          const newerIso = new Date(Date.now() + 1_000).toISOString();
          fake.state.messages.push({
            id: "msg-newer",
            conversation_id: CONV_ID,
            direction: "inbound",
            sender_id: DM_CHAT_ID,
            sender_name: "דנה",
            body: "ורגע, אתם עובדים גם בשישי?",
            created_at: newerIso,
          });
          fake.state.bot_jobs.push({
            id: "job-newer",
            kind: "inbound_reply",
            chat_id: DM_CHAT_ID,
            conversation_id: CONV_ID,
            status: "pending",
            payload: {
              whapi_message_id: "wamid-in-2",
              body: "ורגע, אתם עובדים גם בשישי?",
              ts: Date.now() + 1_000,
            },
            run_after: newerIso,
            created_at: newerIso,
          });
          return DRAFT_JSON;
        },
      ],
      // The consolidation stage merges both questions in ONE extra call.
      [
        /consolid/i,
        () =>
          JSON.stringify({ messages: [CONSOLIDATED_TEXT], reasoning: "Merged both questions." }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync();

    // A reply, NOT a supersede-skip — the older job answered both messages.
    expect(outcome.action).toBe("replied");

    // Exactly one consolidation call on top of the single intent + draft.
    expect(callCount("agent_intent")).toBe(1);
    expect(callCount("agent_draft")).toBe(1);
    expect(callCount(/consolid/i)).toBe(1);

    // Still exactly ONE send, and it is the consolidated reply.
    expect(whapi.sends).toHaveLength(1);
    expect(whapi.sends[0].body).toBe(CONSOLIDATED_TEXT);

    // The newer message's queued job was superseded through the queue helper —
    // a real status transition, or its own worker would double-reply.
    const superseded = fake.updates.filter(
      (u) => u.table === "bot_jobs" && u.patch.status === "superseded",
    );
    expect(superseded.length).toBeGreaterThanOrEqual(1);
    expect(superseded.some((u) => u.applied >= 1)).toBe(true);
    const newerJob = fake.state.bot_jobs.find((j) => j.id === "job-newer");
    expect(newerJob?.status).toBe("superseded");
  });
});

describe("processInboundJob — never-silent safety net", () => {
  it("sends a fallback line (deliver decision flagged fallback) when the draft is stripped to nothing by the JSON gate", async () => {
    const nowMs = Date.now();
    const job = makeJob(nowMs);
    const fake = seedWithTrigger(nowMs, job);
    const whapi = makeFakeWhapi();

    const FALLBACK_LINE = "סליחה, עם זה אין לי איך לעזור כרגע 🙈";
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      // A validly-parsed envelope whose only "message" is itself a raw JSON
      // envelope — the exact blob shape that once leaked to users. The final
      // stripStructuredOutput gate must reduce it to nothing.
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: [JSON.stringify({ messages: ["שלום"], reasoning: "inner envelope" })],
            reasoning: "outer envelope",
          }),
      ],
      ["agent_fallback", () => FALLBACK_LINE],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync();

    // The DM still got an answer — silence is a hard product violation.
    expect(outcome.action).toBe("replied");
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: FALLBACK_LINE }]);

    // No raw JSON ever reached the port.
    for (const s of whapi.sends) {
      expect(s.body).not.toContain('"messages"');
      expect(s.body).not.toContain('"reasoning"');
    }

    // The deliver decision is flagged as a fallback and still carries the
    // latency breakdown so SLA measurement includes fallback replies.
    const delivers = deliverDecisions(fake);
    expect(delivers).toHaveLength(1);
    expect(delivers[0].data?.fallback).toBe(true);
    expect(delivers[0].data?.latency_breakdown).toBeTruthy();
  });

  it("guard OUTRANKS never-silent: a blocked conversation gets NO fallback line, with a skipped decision naming the guard", async () => {
    const nowMs = Date.now();
    const job = makeJob(nowMs);
    const fake = seedWithTrigger(nowMs, job);
    // The contact asked to stop (or was blocked manually) — sending ANYTHING,
    // fallback included, is exactly what the anti-ban guard exists to prevent.
    fake.state.conversations[0].blocked = true;
    const whapi = makeFakeWhapi();

    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      // Draft that the JSON gate strips to nothing → the fallback path runs.
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: [JSON.stringify({ messages: ["שלום"], reasoning: "inner envelope" })],
            reasoning: "outer envelope",
          }),
      ],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync();

    // Allowed-silent: guard-blocked is the one exception to never-silent.
    expect(outcome).toEqual({ action: "skipped", reason: "blocked" });
    expect(whapi.sends).toEqual([]);
    // The guard fired BEFORE the fallback LLM call — no line was even drafted.
    expect(callCount("agent_fallback")).toBe(0);

    // The silence is explained in the decision trail, naming the guard reason.
    const skips = (fake.inserts.bot_decisions ?? []).filter(
      (d) =>
        typeof d.summary === "string" &&
        (d.summary as string).includes("Fallback blocked by the anti-ban guard"),
    );
    expect(skips).toHaveLength(1);
    expect((skips[0] as { data?: { code?: string } }).data?.code).toBe("blocked");
  });
});

describe("processInboundJob — already-replied guard is crash-retry dedup only", () => {
  // A crossing outbound (the owner typed a reply from their phone mid-cycle)
  // must NOT eat the bot's reply on a first attempt: the owner's hard rule is
  // EVERY message gets a reply, and a rare redundant-looking reply beats a
  // silent drop. Only a RETRY treats a newer outbound as "a previous attempt
  // sent before dying" and skips.
  function seedWithCrossingOutbound(nowMs: number, job: BotJob): FakeSupa {
    const fake = seedWithTrigger(nowMs, job);
    fake.state.messages.push({
      id: "msg-crossing-outbound",
      conversation_id: CONV_ID,
      direction: "outbound",
      sender_id: "owner-phone",
      sender_name: "הבעלים",
      body: "רגע, אני בודק",
      created_at: new Date(job.payload.ts + 3_000).toISOString(),
    });
    return fake;
  }

  it("attempt 1: replies even though an outbound row landed after the message (crossing race)", async () => {
    const nowMs = Date.now();
    const job = makeJob(nowMs);
    const fake = seedWithCrossingOutbound(nowMs, job);
    const whapi = makeFakeWhapi();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      ["agent_draft", () => DRAFT_JSON],
      ["agent_memory", () => MEMORY_JSON],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync();

    expect(outcome.action).toBe("replied");
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: DRAFT_TEXT }]);
  });

  it("attempt 2+ WITH a deliver marker matching the outbound: skips as already-replied", async () => {
    const nowMs = Date.now();
    const job = { ...makeJob(nowMs), attempts: 2 };
    // The previous attempt persisted its marker right before sending exactly
    // this text — the outbound row is provably OUR reply.
    job.payload.deliver_started = { at: nowMs - 5_000, first_part: "רגע, אני בודק" };
    const fake = seedWithCrossingOutbound(nowMs, job);
    const whapi = makeFakeWhapi();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      ["agent_draft", () => DRAFT_JSON],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync();

    expect(outcome).toEqual({ action: "skipped", reason: "already replied" });
    expect(whapi.sends).toEqual([]);
  });

  it("attempt 2+ with an UNRELATED outbound (e.g. a research interim) still replies — uncorrelated rows never swallow a reply", async () => {
    const nowMs = Date.now();
    const job = { ...makeJob(nowMs), attempts: 2 };
    // No deliver marker: no previous attempt ever reached the send. The
    // crossing outbound is the research engine talking about something else.
    const fake = seedWithCrossingOutbound(nowMs, job);
    const whapi = makeFakeWhapi();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      ["agent_draft", () => DRAFT_JSON],
      ["agent_memory", () => MEMORY_JSON],
    ]);

    const outcome = await settle(processInboundJob(makeDeps(fake, whapi), job));
    await vi.runAllTimersAsync();

    expect(outcome.action).toBe("replied");
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: DRAFT_TEXT }]);
  });
});
