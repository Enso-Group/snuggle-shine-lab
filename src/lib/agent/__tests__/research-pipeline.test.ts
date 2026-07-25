// Pipeline → research-promise handoff: REAL processInboundJob runs, and the
// tests assert which replies enqueue a tracked research_answer job (model
// open_question flag, deterministic text scan) and which never do (groups,
// plain answers). humanPacing false ⇒ no pacing sleeps, no fake timers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});

import type { LLMCallInput, LLMCallResult } from "@/lib/llm.server";
import { processInboundJob } from "../pipeline.server";
import { RESEARCH_JOB_KIND, type ResearchJobPayload } from "../research";
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

type SourceHandler = [match: string, respond: (input: LLMCallInput) => string];

function llmRespondsBySource(handlers: SourceHandler[]) {
  callLLMMock.mockImplementation(async (input: LLMCallInput): Promise<LLMCallResult> => {
    const hit = handlers.find(([m]) => m === input.source);
    if (!hit) throw new Error(`no LLM handler for source "${input.source}"`);
    return { content: hit[1](input), model: "test-model", toolCalls: [], finishReason: "stop" };
  });
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
const MEMORY_JSON = JSON.stringify({
  facts: [],
  language: null,
  sentiment: null,
  funnel_stage: null,
  follow_up: null,
});

const PROMISE_TEXT = "אין לי את זה כרגע — אבדוק ואחזור אליך עם תשובה מסודרת 🙏";

function makeJob(nowMs: number, payloadOverrides: Partial<InboundJobPayload> = {}): BotJob {
  const ts = nowMs - 8_000;
  return {
    id: "job-under-test",
    kind: "inbound_reply",
    chat_id: DM_CHAT_ID,
    conversation_id: CONV_ID,
    payload: {
      whapi_message_id: "wamid-in-1",
      body: "כמה עולה חבילת פרימיום?",
      sender_id: DM_CHAT_ID,
      sender_name: "דנה",
      chat_name: "דנה",
      is_group: false,
      ts,
      received_at: ts + 2_000,
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
  fake.state.messages.push({
    id: "msg-trigger",
    conversation_id: CONV_ID,
    direction: "inbound",
    sender_id: String(job.payload.sender_id),
    sender_name: String(job.payload.sender_name),
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
    humanPacing: false,
  };
}

function researchJobs(fake: FakeSupa): Row[] {
  return (fake.inserts.bot_jobs ?? []).filter((j) => j.kind === RESEARCH_JOB_KIND);
}

beforeEach(() => {
  callLLMMock.mockReset();
});

describe("pipeline → research promise handoff", () => {
  it("enqueues an immediate research job when the model flags open_question", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: [PROMISE_TEXT],
            reasoning: "No KB source — promising to check.",
            open_question: "premium plan pricing site:example.co.il",
          }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processInboundJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    const jobs = researchJobs(fake);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0].payload as ResearchJobPayload;
    expect(payload.question).toBe("premium plan pricing site:example.co.il");
    expect(payload.deadline_at - payload.promised_at).toBe(10 * 60_000);
    // Research must start immediately — run_after is now, not hours away.
    expect(new Date(String(jobs[0].run_after)).getTime()).toBeLessThanOrEqual(Date.now());
    // The decision trail records the tracked promise.
    const decision = (fake.inserts.bot_decisions ?? []).find((d) => d.stage === "research");
    expect(decision).toBeTruthy();
    expect((decision!.data as { detected_by: string }).detected_by).toBe("model");
  });

  it("falls back to the deterministic text scan when the model forgets the flag", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () => JSON.stringify({ messages: [PROMISE_TEXT], reasoning: "Promise, no flag." }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    const whapi = makeFakeWhapi();

    await processInboundJob(makeDeps(fake, whapi), job);

    const jobs = researchJobs(fake);
    expect(jobs).toHaveLength(1);
    // Question falls back to the contact's own message.
    expect((jobs[0].payload as ResearchJobPayload).question).toBe("כמה עולה חבילת פרימיום?");
    const decision = (fake.inserts.bot_decisions ?? []).find((d) => d.stage === "research");
    expect((decision!.data as { detected_by: string }).detected_by).toBe("text_scan");
  });

  it("does NOT enqueue research for a plain answer", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: ["חבילת הפרימיום עולה 100₪ לחודש 😊"],
            reasoning: "Answered from KB.",
            open_question: null,
          }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processInboundJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    expect(researchJobs(fake)).toHaveLength(0);
  });

  it("does NOT enqueue research in groups", async () => {
    const now = Date.now();
    const groupChat = "1203630000000001@g.us";
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: [PROMISE_TEXT],
            reasoning: "Group promise.",
            open_question: "premium pricing",
          }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = makeJob(now, { is_group: true, chat_name: "קבוצת לקוחות" });
    job.chat_id = groupChat;
    const fake = seedWithTrigger(now, job);
    fake.state.conversations[0].whapi_chat_id = groupChat;
    fake.state.conversations[0].is_group = true;
    fake.state.group_profiles = [];
    const whapi = makeFakeWhapi();

    const outcome = await processInboundJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    expect(researchJobs(fake)).toHaveLength(0);
  });

  it("respects the research_enabled kill switch at enqueue time", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: [PROMISE_TEXT],
            reasoning: "Promise.",
            open_question: "premium pricing",
          }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    fake.state.bot_settings[0].agent_config = { research_enabled: false };
    const whapi = makeFakeWhapi();

    const outcome = await processInboundJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("replied");
    expect(researchJobs(fake)).toHaveLength(0);
  });

  it("escalated DM: parks the draft in Approvals but alerts, sends a holding line, and tracks a research job", async () => {
    const now = Date.now();
    llmRespondsBySource([
      [
        "agent_intent",
        () =>
          JSON.stringify({
            intent: "frustrated about no follow-up",
            language: "he",
            urgency: "high",
            sentiment: "frustrated",
            goal: "reassure and answer",
            escalate: true,
            escalate_reason: "explicit frustration over delay",
          }),
      ],
      [
        "agent_draft",
        () => JSON.stringify({ messages: ["מצטער על העיכוב, אני על זה"], reasoning: "Apology." }),
      ],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    const whapi = makeFakeWhapi();

    const outcome = await processInboundJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("queued_approval");
    // Draft parked for a human…
    expect(fake.inserts.scheduled_approvals).toHaveLength(1);
    // …but the contact is NOT left hanging,
    const { holdingLineFor } = await import("../research");
    expect(whapi.sends.map((s) => s.body)).toEqual([holdingLineFor("he")]);
    // the admin is loudly told,
    const alert = (fake.inserts.commands_log ?? []).find((r) =>
      String(r.prompt).includes("Escalated DM parked in Approvals"),
    );
    expect(alert).toBeTruthy();
    // and the open question is tracked with the 10-minute machinery.
    expect(researchJobs(fake)).toHaveLength(1);
  });

  it("retry attempts draft with a tighter budget so the whole attempt fits the request wall", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: ["תשובה"],
            reasoning: "Answer.",
            open_question: null,
          }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = { ...makeJob(now), attempts: 2 };
    const fake = seedWithTrigger(now, job);
    const whapi = makeFakeWhapi();

    await processInboundJob(makeDeps(fake, whapi), job);

    const draftCall = callLLMMock.mock.calls
      .map(([i]) => i)
      .find((i) => i.source === "agent_draft");
    expect(draftCall?.budgetMs).toBe(15_000);
    expect(draftCall?.timeoutMs).toBe(12_000);
  });

  it("defers (not drops) a DM reply that hits the anti-ban min-gap", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: ["חבילת הפרימיום עולה 100₪ לחודש 😊"],
            reasoning: "Answer.",
            open_question: null,
          }),
      ],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    // A research answer landed 60s ago: the min-gap guard blocks this reply
    // right now — it must reschedule, never silently drop.
    const conv = fake.state.conversations[0];
    conv.last_outbound_at = new Date(now - 60_000).toISOString();
    conv.last_outbound_body = "בדקתי — הנה התשובה";
    conv.consecutive_outbound = 1;
    const whapi = makeFakeWhapi();

    const outcome = await processInboundJob(makeDeps(fake, whapi), job);

    expect(outcome.action).toBe("deferred");
    if (outcome.action === "deferred") {
      expect(outcome.reason).toBe("min_gap");
      // Past the remaining gap: last outbound + 3 min.
      expect(outcome.runAfterMs).toBeGreaterThan(now - 60_000 + 3 * 60_000);
    }
    expect(whapi.sends).toEqual([]);
  });

  it("a newer promise supersedes the older pending research job for the chat", async () => {
    const now = Date.now();
    llmRespondsBySource([
      ["agent_intent", () => INTENT_JSON],
      [
        "agent_draft",
        () =>
          JSON.stringify({
            messages: [PROMISE_TEXT],
            reasoning: "Promise.",
            open_question: "newer question",
          }),
      ],
      ["agent_memory", () => MEMORY_JSON],
    ]);
    const job = makeJob(now);
    const fake = seedWithTrigger(now, job);
    fake.state.bot_jobs.push({
      id: "research-old",
      kind: RESEARCH_JOB_KIND,
      chat_id: DM_CHAT_ID,
      conversation_id: CONV_ID,
      payload: {},
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      run_after: new Date(now - 60_000).toISOString(),
      created_at: new Date(now - 60_000).toISOString(),
      updated_at: new Date(now - 60_000).toISOString(),
    });
    const whapi = makeFakeWhapi();

    await processInboundJob(makeDeps(fake, whapi), job);

    const old = fake.state.bot_jobs.find((j) => j.id === "research-old")!;
    expect(old.status).toBe("superseded");
    expect(researchJobs(fake)).toHaveLength(1);
  });
});
