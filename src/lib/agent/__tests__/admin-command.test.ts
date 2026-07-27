// Management-mode agent tests: REAL processAdminCommandJob with the in-memory
// Supabase and a recording Whapi port; only callLLM is mocked (per-call
// scripted responses so the tool loop is exercised for real).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});

import type { LLMCallResult } from "@/lib/llm.server";
import { processAdminCommandJob } from "../admin-command.server";
import type { BotJob, AgentDeps } from "../types";
import { makeFakeSupa, makeFakeWhapi, type FakeSupa, type Row } from "./fake-supa";

const ADMIN_PHONE = "972501111111";
const ADMIN_CHAT = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_CONV = "conv-admin-1";
const APPROVAL_ID = "abcd1234-0000-0000-0000-000000000001";

function seed(): Record<string, Row[]> {
  const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    bot_settings: [
      {
        id: "settings-1",
        enabled: true,
        system_prompt: "persona",
        bot_name: "Bot",
        require_approval_all: false,
        model_strong: null,
        model_fast: null,
        agent_config: { wa_admins: [{ phone: ADMIN_PHONE, label: "Itamar" }] },
        created_at: earlier,
      },
    ],
    conversations: [
      {
        id: ADMIN_CONV,
        whapi_chat_id: ADMIN_CHAT,
        name: "Itamar",
        is_group: false,
        created_at: earlier,
      },
    ],
    messages: [
      {
        id: "msg-admin-1",
        conversation_id: ADMIN_CONV,
        direction: "inbound",
        sender_id: ADMIN_CHAT,
        sender_name: "Itamar",
        body: "כבה את הבוט",
        created_at: new Date(Date.now() - 5_000).toISOString(),
      },
    ],
    scheduled_approvals: [
      {
        id: APPROVAL_ID,
        status: "pending",
        source: "ai_reply",
        target_chat_id: "972505000000@s.whatsapp.net",
        target_name: "דנה",
        conversation_id: "conv-dana",
        body: "טיוטת תשובה",
        created_at: earlier,
      },
    ],
    planned_posts: [],
    bot_jobs: [],
    bot_decisions: [],
    group_profiles: [],
  };
}

function makeJob(overrides: Partial<BotJob> = {}): BotJob {
  const now = Date.now();
  return {
    id: "admin-job-1",
    kind: "admin_command",
    chat_id: ADMIN_CHAT,
    conversation_id: ADMIN_CONV,
    payload: {
      whapi_message_id: "wamid-admin-1",
      body: "כבה את הבוט",
      sender_id: ADMIN_CHAT,
      sender_name: "Itamar",
      chat_name: "Itamar",
      is_group: false,
      ts: now - 5_000,
      admin_label: "Itamar",
    },
    status: "processing",
    attempts: 1,
    max_attempts: 3,
    run_after: new Date(now).toISOString(),
    locked_until: null,
    locked_by: "worker-test",
    last_error: null,
    created_at: new Date(now - 4_000).toISOString(),
    updated_at: new Date(now - 4_000).toISOString(),
    ...overrides,
  } as BotJob;
}

function makeDeps(fake: FakeSupa, whapi = makeFakeWhapi()): { deps: AgentDeps; whapi: ReturnType<typeof makeFakeWhapi> } {
  return {
    deps: {
      supabase: fake.client,
      whapi: whapi.port,
      trigger: "inbound",
      workerId: "worker-test",
      humanPacing: false,
    },
    whapi,
  };
}

/** Seed the claimed job row itself — the exactly-once CAS updates it. */
function seedJobRow(fake: FakeSupa, job: BotJob) {
  fake.state.bot_jobs.push({ ...(job as unknown as Row) });
}

/** Script callLLM responses in order; throws when called more than scripted. */
function scriptLLM(responses: Array<Partial<LLMCallResult>>) {
  let i = 0;
  callLLMMock.mockImplementation(async (): Promise<LLMCallResult> => {
    const r = responses[i++];
    if (!r) throw new Error("LLM called more times than scripted");
    return {
      content: r.content ?? "",
      model: "test-model",
      toolCalls: r.toolCalls ?? [],
      finishReason: "stop",
    } as LLMCallResult;
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  callLLMMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("processAdminCommandJob — authorization", () => {
  it("drops the job when the phone is no longer on the admin list (re-verify at processing time)", async () => {
    const tables = seed();
    (tables.bot_settings[0] as { agent_config: unknown }).agent_config = { wa_admins: [] };
    const fake = makeFakeSupa(tables);
    const { deps, whapi } = makeDeps(fake);

    const outcome = await processAdminCommandJob(deps, makeJob());
    expect(outcome).toEqual({ action: "skipped", reason: "not an admin" });
    expect(whapi.sends).toHaveLength(0);
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it("never replays tools on a retry after the exactly-once marker is set", async () => {
    const fake = makeFakeSupa(seed());
    const { deps, whapi } = makeDeps(fake);

    const job = makeJob();
    (job.payload as { admin_started?: boolean }).admin_started = true;
    const outcome = await processAdminCommandJob(deps, job);

    expect(outcome.action).toBe("replied");
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(whapi.sends).toHaveLength(1);
    expect(whapi.sends[0].chatId).toBe(ADMIN_CHAT);
    expect(whapi.sends[0].body).toContain("נקטעה");
  });
});

describe("processAdminCommandJob — tool loop", () => {
  it("executes update_bot_settings and logs the action with the admin identity", async () => {
    const fake = makeFakeSupa(seed());
    const { deps, whapi } = makeDeps(fake);
    scriptLLM([
      {
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "update_bot_settings", arguments: '{"enabled":false}' },
          },
        ],
      },
      { content: "כיביתי את הבוט. אפשר להדליק חזרה מכאן מתי שתרצה." },
    ]);

    const job = makeJob();
    seedJobRow(fake, job);
    const outcome = await processAdminCommandJob(deps, job);
    await flush();

    expect(outcome.action).toBe("replied");
    expect(fake.state.bot_settings[0].enabled).toBe(false);

    // Action logged to Activity with who did it and from where.
    const actionLogs = (fake.inserts.bot_decisions ?? []).filter(
      (d) => d.stage === "config" && String(d.summary).includes("WhatsApp admin Itamar"),
    );
    expect(actionLogs).toHaveLength(1);
    expect((actionLogs[0].data as { admin_phone?: string }).admin_phone).toBe(ADMIN_PHONE);

    // Reply delivered to the admin chat and mirrored into history.
    expect(whapi.sends).toHaveLength(1);
    expect(whapi.sends[0].chatId).toBe(ADMIN_CHAT);
    expect(whapi.sends[0].body).toContain("כיביתי");
    const mirrored = (fake.inserts.messages ?? []).filter((m) => m.direction === "outbound");
    expect(mirrored).toHaveLength(1);
  });

  it("rejects a pending approval by short id through the shared core", async () => {
    const fake = makeFakeSupa(seed());
    const { deps, whapi } = makeDeps(fake);
    scriptLLM([
      {
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "reject_pending", arguments: '{"id":"abcd1234"}' },
          },
        ],
      },
      { content: "דחיתי את הטיוטה." },
    ]);

    const job = makeJob();
    seedJobRow(fake, job);
    const outcome = await processAdminCommandJob(deps, job);
    await flush();

    expect(outcome.action).toBe("replied");
    const approval = fake.state.scheduled_approvals.find((r) => r.id === APPROVAL_ID);
    expect(approval?.status).toBe("rejected");
    // The rejection decision names the WhatsApp admin, not the dashboard.
    const decisionSummaries = (fake.inserts.bot_decisions ?? []).map((d) => String(d.summary));
    expect(decisionSummaries.some((s) => s.includes("Rejected by WhatsApp admin Itamar"))).toBe(
      true,
    );
    expect(whapi.sends).toHaveLength(1);
  });

  it("returns a tool error to the model for an ambiguous/unknown approval id", async () => {
    const fake = makeFakeSupa(seed());
    const { deps } = makeDeps(fake);
    scriptLLM([
      {
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "reject_pending", arguments: '{"id":"ffffffff"}' },
          },
        ],
      },
      { content: "אין פריט כזה ברשימה." },
    ]);

    const job = makeJob();
    seedJobRow(fake, job);
    await processAdminCommandJob(deps, job);
    const approval = fake.state.scheduled_approvals.find((r) => r.id === APPROVAL_ID);
    expect(approval?.status).toBe("pending");
  });
});
