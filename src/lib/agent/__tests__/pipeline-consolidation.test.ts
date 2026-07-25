import { describe, expect, it, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// The consolidation contract, end to end through processInboundJob:
//   - a message arriving mid-draft is folded into the reply with ONE extra
//     strong call (no restart — intent runs exactly once),
//   - the newer message's pending job is superseded so it never runs — but
//     ONLY jobs snapshotted before the consolidation call: a job enqueued
//     during it answers a message the reply does not cover and must survive,
//   - at most ONE consolidation round: even-newer messages fall back to the
//     old superseded outcome, with the pending job left alive to answer,
//   - EVERY superseded exit first verifies an owning job exists. Trivial
//     messages ("תודה") never enqueue one — bowing out on their account would
//     leave the original message answered by nobody.
// Only the LLM and module edges are mocked; the pipeline, stages, deliver and
// decision logging all run for real against an in-memory Supabase stand-in.
// ---------------------------------------------------------------------------

const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});

vi.mock("../context.server", () => ({
  loadAgentSettings: vi.fn(async () => makeSettings()),
  gatherContext: vi.fn(
    async (_supabase: unknown, settings: AgentSettings, convId: string, message: unknown) => ({
      settings,
      conversation: {
        id: convId,
        whapi_chat_id: CHAT,
        name: null,
        is_group: false,
        inbound_count: 2,
        consecutive_outbound: 0,
        blocked: false,
        last_outbound_at: null,
        last_outbound_body: null,
      },
      history: [],
      message,
      gapSinceLastMs: 60_000,
    }),
  ),
}));

// stages.server imports personPromptBlock at module load; the pipeline only
// needs loadOrCreatePerson (null → memory stage stays out of the way).
vi.mock("../people.server", () => ({
  loadOrCreatePerson: vi.fn(async () => null),
  personPromptBlock: () => "",
}));

vi.mock("../kb.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kb.server")>();
  return { ...actual, loadKnowledge: vi.fn(async () => ({ block: "", count: 0 })) };
});

vi.mock("@/lib/anti-ban.server", () => ({
  checkOutboundAllowed: vi.fn(async () => ({ ok: true })),
  isWhapiRestrictionError: () => false,
  raiseAdminAlert: vi.fn(async () => {}),
  loadConversationByChatId: vi.fn(async () => null),
  recordOutbound: vi.fn(async () => {}),
}));

import { processInboundJob } from "../pipeline.server";
import { hasOwningReplyJob } from "../queue.server";
import type { AgentDeps, AgentSettings, BotJob, WhapiPort } from "../types";

const CHAT = "972500000001@s.whatsapp.net";
const GROUP_CHAT = "120363000000000001@g.us";

function makeSettings(): AgentSettings {
  return {
    id: "s1",
    enabled: true,
    system_prompt: "פרסונה",
    bot_name: "בוט",
    require_approval_all: false,
    model_strong: null,
    model_fast: null,
    agent_config: {},
  };
}

// --- In-memory Supabase stand-in with real eq/gt filtering on selects and
// updates — the consolidation logic hinges on created_at comparisons. ---
type Row = Record<string, unknown>;

function makeFakeSupabase(seed: { messages?: Row[]; botJobs?: Row[] } = {}) {
  const state: Record<string, Row[]> = {
    messages: [...(seed.messages ?? [])],
    bot_jobs: [...(seed.botJobs ?? [])],
    bot_decisions: [],
  };

  class QB {
    op: "select" | "insert" | "update" = "select";
    filters: Array<{ kind: "eq" | "neq" | "gt" | "in"; col: string; val: unknown }> = [];
    rows: Row[] = [];
    patch: Row = {};
    orderBy: Array<{ col: string; asc: boolean }> = [];
    limitN: number | null = null;
    wantSingle = false;
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.rows = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push({ kind: "eq", col, val });
      return this;
    }
    neq(col: string, val: unknown) {
      this.filters.push({ kind: "neq", col, val });
      return this;
    }
    gt(col: string, val: unknown) {
      this.filters.push({ kind: "gt", col, val });
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.filters.push({ kind: "in", col, val: vals });
      return this;
    }
    // order/limit are honest now: the owning-job check reads "the newest
    // inbound", so newest-first ordering is load-bearing for the pipeline.
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderBy.push({ col, asc: opts?.ascending !== false });
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this.run();
    }
    single() {
      this.wantSingle = true;
      return this.run();
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return this.run().then(onF, onR);
    }
    private matches(row: Row) {
      return this.filters.every((f) => {
        switch (f.kind) {
          case "eq":
            return row[f.col] === f.val;
          case "neq":
            return row[f.col] !== f.val;
          case "in":
            return (f.val as unknown[]).includes(row[f.col]);
          case "gt":
            return row[f.col] != null && String(row[f.col]) > String(f.val);
        }
      });
    }
    private async run(): Promise<{ data: unknown; error: unknown }> {
      const rows = (state[this.table] ??= []);
      if (this.op === "insert") {
        rows.push(...this.rows);
        return { data: this.wantSingle ? (this.rows[0] ?? null) : this.rows, error: null };
      }
      if (this.op === "update") {
        for (const row of rows) if (this.matches(row)) Object.assign(row, this.patch);
        return { data: null, error: null };
      }
      let found = rows.filter((r) => this.matches(r));
      for (const { col, asc } of [...this.orderBy].reverse()) {
        found = [...found].sort((a, b) => {
          const sa = String(a[col] ?? "");
          const sb = String(b[col] ?? "");
          const c = sa < sb ? -1 : sa > sb ? 1 : 0;
          return asc ? c : -c;
        });
      }
      if (this.limitN != null) found = found.slice(0, this.limitN);
      if (this.wantSingle) return { data: found[0] ?? null, error: null };
      return { data: found, error: null };
    }
  }

  return { client: { from: (t: string) => new QB(t) } as unknown as AgentDeps["supabase"], state };
}

function makeJob(ts: number, opts: { group?: boolean } = {}): BotJob {
  return {
    id: "job-1",
    kind: "inbound_reply",
    chat_id: opts.group ? GROUP_CHAT : CHAT,
    conversation_id: "c1",
    payload: {
      whapi_message_id: "wamid-0",
      body: "שאלה ראשונה",
      sender_id: opts.group ? "972500000002@s.whatsapp.net" : CHAT,
      sender_name: "דנה",
      chat_name: "",
      is_group: !!opts.group,
      ts,
      received_at: ts + 500,
    },
    status: "processing",
    attempts: 1,
    max_attempts: 3,
    run_after: new Date(ts).toISOString(),
    locked_until: null,
    locked_by: null,
    last_error: null,
    created_at: new Date(ts).toISOString(),
    updated_at: new Date(ts).toISOString(),
  };
}

function makeDeps(supabase: AgentDeps["supabase"], sendText: WhapiPort["sendText"]): AgentDeps {
  return {
    supabase,
    whapi: {
      sendText,
      sendPoll: async () => ({}),
      markRead: async () => {},
      react: async () => {},
      presence: async () => {},
    },
    trigger: "inbound",
    workerId: "test",
    // No pacing/top-up waits in tests; the consolidation check runs either way.
    humanPacing: false,
  };
}

const llmResult = (content: string) => ({
  content,
  model: "test-model",
  toolCalls: [],
  finishReason: "stop",
});

type LLMInput = { source: string; timeoutMs?: number; budgetMs?: number };

/** Wires callLLM per stage; onDraft/onConsolidate let a test inject arrivals mid-call. */
function wireLLM(hooks: { onDraft?: () => void; onConsolidate?: () => void } = {}) {
  const calls: LLMInput[] = [];
  callLLMMock.mockImplementation(async (input: LLMInput) => {
    calls.push(input);
    if (input.source === "agent_intent") {
      return llmResult(
        '{"intent":"question","language":"he","urgency":"normal","sentiment":"neutral","goal":"help","escalate":false,"escalate_reason":null}',
      );
    }
    if (input.source === "agent_draft") {
      hooks.onDraft?.();
      return llmResult('{"messages":["תשובה לשאלה הראשונה"],"reasoning":"draft"}');
    }
    if (input.source === "agent_consolidate") {
      hooks.onConsolidate?.();
      return llmResult('{"messages":["תשובה מאוחדת לשתי ההודעות"],"reasoning":"merged"}');
    }
    throw new Error(`unexpected LLM source: ${input.source}`);
  });
  return calls;
}

const flushLogs = () => new Promise((r) => setTimeout(r, 0));
const sourcesOf = (calls: LLMInput[]) => calls.map((c) => c.source);

describe("processInboundJob — newer-message consolidation instead of restart", () => {
  // Block body on purpose: mockReset() returns the mock, and a function
  // returned from a beforeEach hook is invoked by vitest as a cleanup hook.
  beforeEach(() => {
    callLLMMock.mockReset();
  });

  it("replies normally with ONE intent + ONE draft call when nothing new arrives", async () => {
    const fake = makeFakeSupabase();
    const calls = wireLLM();
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(Date.now() - 30_000),
    );

    expect(outcome).toEqual({ action: "replied", parts: ["תשובה לשאלה הראשונה"] });
    expect(sent).toEqual(["תשובה לשאלה הראשונה"]);
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft"]);
  });

  it("folds a message that arrived mid-draft into ONE consolidated reply and supersedes its pending job", async () => {
    const T0 = Date.now() - 30_000;
    const fake = makeFakeSupabase({
      // The newer message's own reply job, waiting in the queue.
      botJobs: [{ id: "job-2", chat_id: CHAT, kind: "inbound_reply", status: "pending" }],
    });
    // The newer message lands while the draft call is in flight — after the
    // pipeline's cheap early check, before the pre-send consolidation check.
    const calls = wireLLM({
      onDraft: () =>
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "ועוד שאלה קטנה",
          sender_name: "דנה",
          created_at: new Date().toISOString(),
        }),
    });
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0),
    );
    await flushLogs();

    // ONE cycle: intent once, draft once, consolidation once — no restart.
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft", "agent_consolidate"]);
    expect(outcome).toEqual({ action: "replied", parts: ["תשובה מאוחדת לשתי ההודעות"] });
    expect(sent).toEqual(["תשובה מאוחדת לשתי ההודעות"]);

    // The newer message's job must never run a second full cycle.
    expect(fake.state.bot_jobs.find((j) => j.id === "job-2")?.status).toBe("superseded");

    // Every reply-path call is budget-clamped (60s request wall / 90s SLA).
    const bySource = Object.fromEntries(calls.map((c) => [c.source, c]));
    expect(bySource.agent_intent).toMatchObject({ timeoutMs: 10_000, budgetMs: 12_000 });
    expect(bySource.agent_draft).toMatchObject({ timeoutMs: 15_000, budgetMs: 25_000 });
    expect(bySource.agent_consolidate).toMatchObject({ timeoutMs: 12_000, budgetMs: 15_000 });

    // The decision trail says what happened, in the draft stage.
    const summaries = fake.state.bot_decisions.map((d) => String(d.summary));
    expect(summaries).toContain("Consolidated 1 newer message(s) into the reply — no restart");
  });

  it("runs AT MOST one consolidation round — even-newer arrivals fall back to superseded with the pending job intact", async () => {
    const T0 = Date.now() - 30_000;
    const fake = makeFakeSupabase({
      // Stands in for the even-newer message's own reply job: superseded is
      // only allowed when a job like this OWNS the newest message, so its
      // payload ts must cover the arrival injected below.
      botJobs: [
        {
          id: "job-3",
          chat_id: CHAT,
          kind: "inbound_reply",
          status: "pending",
          payload: { ts: Date.now() + 60_000 },
        },
      ],
    });
    const calls = wireLLM({
      onDraft: () =>
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "ועוד שאלה",
          sender_name: "דנה",
          created_at: new Date().toISOString(),
        }),
      // The chat moves on AGAIN while consolidating: past the cutoff, so the
      // cycle gives up the old way instead of consolidating forever.
      onConsolidate: () =>
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "רגע, בעצם שאלה אחרת לגמרי",
          sender_name: "דנה",
          created_at: new Date(Date.now() + 5_000).toISOString(),
        }),
    });
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0),
    );

    expect(outcome).toEqual({ action: "skipped", reason: "superseded" });
    // Nothing was sent, and no second consolidation call was made.
    expect(sent).toEqual([]);
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft", "agent_consolidate"]);
    // Crucially the pending job was NOT superseded — it is the fallback that
    // answers the chat, so silence is impossible on this path.
    expect(fake.state.bot_jobs.find((j) => j.id === "job-3")?.status).toBe("pending");
  });

  it("does NOT bow out at the early check for a newer message with no owning job — trivial messages never enqueue one", async () => {
    const T0 = Date.now() - 30_000;
    // A trivial "תודה" landed after this job's message and was acknowledged
    // with a reaction in the inbound handler — so there is NO reply job for
    // it (bot_jobs is empty). The old behavior returned superseded here and
    // the ORIGINAL question was never answered by anyone.
    const fake = makeFakeSupabase({
      messages: [
        {
          conversation_id: "c1",
          direction: "inbound",
          body: "תודה",
          sender_name: "דנה",
          created_at: new Date(T0 + 5_000).toISOString(),
        },
      ],
    });
    const calls = wireLLM();
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0),
    );

    // The cycle continues and the pre-send consolidation folds the trivial
    // message in — one reply, nobody left unanswered.
    expect(outcome).toEqual({ action: "replied", parts: ["תשובה מאוחדת לשתי ההודעות"] });
    expect(sent).toEqual(["תשובה מאוחדת לשתי ההודעות"]);
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft", "agent_consolidate"]);
  });

  it("still bows out at the early check when the newer message HAS an owning job — nothing is spent", async () => {
    const T0 = Date.now() - 30_000;
    const newerTs = T0 + 5_000;
    const fake = makeFakeSupabase({
      messages: [
        {
          conversation_id: "c1",
          direction: "inbound",
          body: "ובעצם שאלה יותר טובה",
          sender_name: "דנה",
          created_at: new Date(newerTs).toISOString(),
        },
      ],
      botJobs: [
        {
          id: "job-owner",
          chat_id: CHAT,
          kind: "inbound_reply",
          status: "pending",
          payload: { ts: newerTs },
        },
      ],
    });
    const calls = wireLLM();
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0),
    );

    expect(outcome).toEqual({ action: "skipped", reason: "superseded" });
    expect(sent).toEqual([]);
    // The pre-LLM escape hatch: no reasoning call was spent on the dead cycle.
    expect(sourcesOf(calls)).toEqual([]);
  });

  it("sends the consolidated reply when the even-newer arrival has NO owning job (trivial mid-consolidation message)", async () => {
    const T0 = Date.now() - 30_000;
    const fake = makeFakeSupabase();
    const calls = wireLLM({
      onDraft: () =>
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "ועוד שאלה",
          sender_name: "דנה",
          created_at: new Date().toISOString(),
        }),
      // A trivial ack lands during consolidation — past the cutoff, but with
      // no job of its own. Bowing out here would answer NOBODY: sending the
      // consolidated reply is the only live path.
      onConsolidate: () =>
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "👍",
          sender_name: "דנה",
          created_at: new Date(Date.now() + 5_000).toISOString(),
        }),
    });
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0),
    );

    expect(outcome).toEqual({ action: "replied", parts: ["תשובה מאוחדת לשתי ההודעות"] });
    expect(sent).toEqual(["תשובה מאוחדת לשתי ההודעות"]);
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft", "agent_consolidate"]);
  });

  it("supersedes ONLY the jobs snapshotted before consolidation — a job enqueued during the call survives", async () => {
    const T0 = Date.now() - 30_000;
    const fake = makeFakeSupabase();
    const calls = wireLLM({
      onDraft: () => {
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "ועוד שאלה קטנה",
          sender_name: "דנה",
          created_at: new Date().toISOString(),
        });
        fake.state.bot_jobs.push({
          id: "job-covered",
          chat_id: CHAT,
          kind: "inbound_reply",
          status: "pending",
          payload: { ts: Date.now() },
        });
      },
      // Enqueued while the consolidation LLM call is in flight, for a message
      // whose row is not yet visible (insert race): the consolidated reply
      // does NOT cover it, so the old chat-wide supersede would have silently
      // dropped that message's answer.
      onConsolidate: () =>
        fake.state.bot_jobs.push({
          id: "job-late",
          chat_id: CHAT,
          kind: "inbound_reply",
          status: "pending",
          payload: { ts: Date.now() + 10_000 },
        }),
    });
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0),
    );
    await flushLogs();

    expect(outcome).toEqual({ action: "replied", parts: ["תשובה מאוחדת לשתי ההודעות"] });
    expect(sent).toEqual(["תשובה מאוחדת לשתי ההודעות"]);
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft", "agent_consolidate"]);
    // The snapshot job is covered by the consolidated reply → retired.
    expect(fake.state.bot_jobs.find((j) => j.id === "job-covered")?.status).toBe("superseded");
    // The mid-consolidation job is NOT covered → it must stay alive to answer.
    expect(fake.state.bot_jobs.find((j) => j.id === "job-late")?.status).toBe("pending");
  });

  it("groups NEVER consolidate: with an owning job the cycle bows out the old way, without one consolidation call", async () => {
    const T0 = Date.now() - 30_000;
    const fake = makeFakeSupabase();
    const calls = wireLLM({
      // A newer addressed message lands mid-draft, with its own reply job —
      // the group checkpoint hands the reply off instead of consolidating
      // (the consolidation prompt has no group context).
      onDraft: () => {
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "ושאלה נוספת לבוט",
          sender_name: "יוסי",
          created_at: new Date().toISOString(),
        });
        fake.state.bot_jobs.push({
          id: "job-group-owner",
          chat_id: GROUP_CHAT,
          kind: "inbound_reply",
          status: "pending",
          payload: { ts: Date.now() },
        });
      },
    });
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0, { group: true }),
    );

    expect(outcome).toEqual({ action: "skipped", reason: "superseded" });
    expect(sent).toEqual([]);
    // No consolidation call was ever attempted for the group.
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft"]);
    // The owning job stays alive — it is the one that answers.
    expect(fake.state.bot_jobs.find((j) => j.id === "job-group-owner")?.status).toBe("pending");
  });

  it("groups with newer chatter but NO owning job still send the drafted reply — the old path would have dropped it", async () => {
    const T0 = Date.now() - 30_000;
    const fake = makeFakeSupabase();
    const calls = wireLLM({
      // Unaddressed member chatter mid-draft: it never passed the reply gate,
      // so no job exists for it — this cycle is the only reply the group gets.
      onDraft: () =>
        fake.state.messages.push({
          conversation_id: "c1",
          direction: "inbound",
          body: "סתם פטפוט בין חברים",
          sender_name: "יוסי",
          created_at: new Date().toISOString(),
        }),
    });
    const sent: string[] = [];
    const outcome = await processInboundJob(
      makeDeps(fake.client, async (_chat, body) => {
        sent.push(body);
        return { message: { id: "m-out" } };
      }),
      makeJob(T0, { group: true }),
    );

    expect(outcome).toEqual({ action: "replied", parts: ["תשובה לשאלה הראשונה"] });
    expect(sent).toEqual(["תשובה לשאלה הראשונה"]);
    expect(sourcesOf(calls)).toEqual(["agent_intent", "agent_draft"]);
  });
});

// ---------------------------------------------------------------------------
// The owning-job check itself — the decision logic every superseded exit now
// depends on, exercised against the same in-memory fake as the pipeline runs.
// ---------------------------------------------------------------------------
describe("hasOwningReplyJob", () => {
  const NEWEST_TS = 1_800_000_000_000;
  const args = { chatId: CHAT, excludeJobId: "job-current", newestInboundTs: NEWEST_TS };

  function jobsSeed(rows: Row[]): { client: AgentDeps["supabase"] } {
    return makeFakeSupabase({ botJobs: rows });
  }

  it("true when a pending job's payload.ts covers the newest inbound", async () => {
    const fake = jobsSeed([
      { id: "j1", chat_id: CHAT, kind: "inbound_reply", status: "pending", payload: { ts: NEWEST_TS } },
    ]);
    expect(await hasOwningReplyJob(fake.client, args)).toBe(true);
  });

  it("true for a processing job too, and when the jsonb payload arrives as a JSON string", async () => {
    const fake = jobsSeed([
      {
        id: "j1",
        chat_id: CHAT,
        kind: "inbound_reply",
        status: "processing",
        payload: JSON.stringify({ ts: NEWEST_TS + 1_000 }),
      },
    ]);
    expect(await hasOwningReplyJob(fake.client, args)).toBe(true);
  });

  it("false when the only candidate is the current job itself", async () => {
    const fake = jobsSeed([
      {
        id: "job-current",
        chat_id: CHAT,
        kind: "inbound_reply",
        status: "processing",
        payload: { ts: NEWEST_TS },
      },
    ]);
    expect(await hasOwningReplyJob(fake.client, args)).toBe(false);
  });

  it("false when live jobs only cover OLDER messages", async () => {
    const fake = jobsSeed([
      {
        id: "j1",
        chat_id: CHAT,
        kind: "inbound_reply",
        status: "pending",
        payload: { ts: NEWEST_TS - 1 },
      },
    ]);
    expect(await hasOwningReplyJob(fake.client, args)).toBe(false);
  });

  it("false for retired/foreign jobs and junk payloads — none of them will ever write the reply", async () => {
    const fake = jobsSeed([
      { id: "j1", chat_id: CHAT, kind: "inbound_reply", status: "superseded", payload: { ts: NEWEST_TS } },
      { id: "j2", chat_id: CHAT, kind: "inbound_reply", status: "done", payload: { ts: NEWEST_TS } },
      { id: "j3", chat_id: CHAT, kind: "follow_up", status: "pending", payload: { ts: NEWEST_TS } },
      { id: "j4", chat_id: "other@s.whatsapp.net", kind: "inbound_reply", status: "pending", payload: { ts: NEWEST_TS } },
      { id: "j5", chat_id: CHAT, kind: "inbound_reply", status: "pending", payload: null },
      { id: "j6", chat_id: CHAT, kind: "inbound_reply", status: "pending", payload: "{not json" },
    ]);
    expect(await hasOwningReplyJob(fake.client, args)).toBe(false);
  });
});
