// Channel/broadcast surfaces ('@newsletter', '@broadcast') are one-way: the
// bot must never store them, reply to them, send the never-silent fallback
// into them, or track research promises for them. Live 2026-07-26: a channel
// post fell through the '@g.us'-only group check, got the full DM treatment,
// wall-died 3x and the dead-job sweep fired the fallback machinery at a
// WhatsApp Channel.
import { describe, expect, it } from "vitest";

import { planCleanup } from "../cleanup";
import { isChannelChatId, isDmChatId } from "../inbound";
import { handleInboundMessage } from "../inbound-handler.server";
import { processInboundJob } from "../pipeline.server";
import { detectsResourceRequest, buildResearchBlock } from "../research";
import { sweepDeadReplyJobs } from "../worker.server";
import type { AgentDeps, AgentSettings, BotJob, InboundJobPayload } from "../types";
import { makeFakeSupa, makeFakeWhapi, seedDmTables, type FakeSupa, type Row } from "./fake-supa";

const NEWSLETTER_CHAT = "120363222944584134@newsletter";

function makeDeps(fake: FakeSupa) {
  const whapi = makeFakeWhapi();
  const deps: AgentDeps = {
    supabase: fake.client as unknown as AgentDeps["supabase"],
    whapi: whapi.port,
    trigger: "inbound",
    workerId: "test-worker",
    humanPacing: false,
  };
  return { deps, whapi };
}

const settings: AgentSettings = {
  id: "settings-1",
  enabled: true,
  system_prompt: "אתה עוזר.",
  bot_name: "Bot",
  require_approval_all: false,
  model_strong: null,
  model_fast: null,
  agent_config: {},
};

describe("chat-kind helpers", () => {
  it("classifies channels and broadcasts", () => {
    expect(isChannelChatId(NEWSLETTER_CHAT)).toBe(true);
    expect(isChannelChatId("status@broadcast")).toBe(true);
    expect(isChannelChatId("12345@broadcast")).toBe(true);
    expect(isChannelChatId("972500000777@s.whatsapp.net")).toBe(false);
    expect(isChannelChatId("123-456@g.us")).toBe(false);
  });

  it("isDmChatId accepts only person-to-person chats", () => {
    expect(isDmChatId("972500000777@s.whatsapp.net")).toBe(true);
    expect(isDmChatId("972500000777@c.us")).toBe(true);
    expect(isDmChatId("972500000777")).toBe(true);
    expect(isDmChatId("12345@lid")).toBe(true);
    expect(isDmChatId(NEWSLETTER_CHAT)).toBe(false);
    expect(isDmChatId("status@broadcast")).toBe(false);
    expect(isDmChatId("123-456@g.us")).toBe(false);
    expect(isDmChatId("sim-1@simulation")).toBe(false);
    expect(isDmChatId("")).toBe(false);
  });
});

describe("inbound handler channel gate", () => {
  it("never persists or enqueues for a channel post", async () => {
    const fake = makeFakeSupa(seedDmTables(Date.now()));
    const { deps } = makeDeps(fake);
    const outcome = await handleInboundMessage(
      deps,
      settings,
      {
        chatId: NEWSLETTER_CHAT,
        chatName: "ערוץ חדשות",
        senderId: NEWSLETTER_CHAT,
        senderName: "ערוץ",
        body: "פוסט חדש בערוץ",
        isGroup: false,
        fromMe: false,
        messageId: "wamid-ch-1",
        ts: Date.now(),
        mentions: [],
        quotedId: null,
        quotedAuthor: null,
      },
      {},
    );
    expect(outcome.action).toBe("channel_post");
    // No conversation, no message, no job — the channel is only observed.
    expect(
      fake.state.conversations.filter((c) => c.whapi_chat_id === NEWSLETTER_CHAT),
    ).toHaveLength(0);
    expect(fake.state.bot_jobs ?? []).toHaveLength(0);
    // One throttled breadcrumb so the Activity log explains the silence.
    const skips = (fake.state.bot_decisions ?? []).filter(
      (d) => d.chat_id === NEWSLETTER_CHAT && d.stage === "skipped",
    );
    expect(skips).toHaveLength(1);
  });
});

describe("pipeline channel guard", () => {
  it("skips a stale queued channel job without spending anything", async () => {
    const now = Date.now();
    const fake = makeFakeSupa(seedDmTables(now));
    const { deps } = makeDeps(fake);
    const payload: InboundJobPayload = {
      whapi_message_id: "wamid-ch-2",
      body: "פוסט ערוץ ישן",
      sender_id: NEWSLETTER_CHAT,
      sender_name: "ערוץ",
      chat_name: "ערוץ",
      is_group: false,
      ts: now - 60_000,
    };
    const job: BotJob = {
      id: "job-ch-1",
      kind: "inbound_reply",
      chat_id: NEWSLETTER_CHAT,
      conversation_id: "conv-ch-1",
      payload,
      status: "processing",
      attempts: 1,
      max_attempts: 3,
      run_after: new Date(now).toISOString(),
      locked_until: null,
      locked_by: null,
      last_error: null,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    const outcome = await processInboundJob(deps, job);
    expect(outcome).toEqual({ action: "skipped", reason: "channel chat" });
  });
});

describe("dead-job sweep channel fence", () => {
  it("never sends the canned fallback for a dead channel job", async () => {
    const now = Date.now();
    const fake = makeFakeSupa(seedDmTables(now));
    const { deps, whapi } = makeDeps(fake);
    const ts = now - 10 * 60_000;
    fake.state.bot_jobs.push({
      id: "dead-ch-1",
      kind: "inbound_reply",
      chat_id: NEWSLETTER_CHAT,
      conversation_id: "conv-ch-1",
      payload: {
        whapi_message_id: "wamid-ch-3",
        body: "פוסט ערוץ",
        sender_id: NEWSLETTER_CHAT,
        sender_name: "ערוץ",
        chat_name: "ערוץ",
        is_group: false,
        ts,
      },
      status: "failed",
      attempts: 3,
      max_attempts: 3,
      run_after: new Date(ts).toISOString(),
      locked_until: null,
      locked_by: null,
      last_error: "worker lock expired",
      created_at: new Date(ts + 1_000).toISOString(),
      updated_at: new Date(now - 2 * 60_000).toISOString(),
    } as unknown as Row);

    const res = await sweepDeadReplyJobs(deps, { max: 2 });
    expect(res.handled).toBe(0);
    expect(whapi.sends).toHaveLength(0);
    // No research follow-up job was enqueued for the channel either.
    const researchJobs = fake.state.bot_jobs.filter((j) => j.kind === "research_answer");
    expect(researchJobs).toHaveLength(0);
  });
});

describe("cleanup channel purge", () => {
  it("always deletes stored channel conversations, even 'participated' ones", () => {
    const plan = planCleanup({
      conversations: [
        { id: "c1", whapi_chat_id: NEWSLETTER_CHAT, is_group: false },
        { id: "c2", whapi_chat_id: "972500000777@s.whatsapp.net", is_group: false },
      ],
      participatedConvIds: new Set(["c1", "c2"]),
      protectedConvIds: new Set(),
      botConvIds: new Set(["c1", "c2"]),
      people: [],
    });
    expect(plan.convIdsToDelete).toContain("c1");
    expect(plan.convIdsToDelete).not.toContain("c2");
  });
});

describe("research resource-request detection", () => {
  it("detects Hebrew and English resource asks", () => {
    expect(detectsResourceRequest("אתם יכולים למצוא לי דוח AI מעניין?")).toBe(true);
    expect(detectsResourceRequest("תשלח לי קישור למאמר")).toBe(true);
    expect(detectsResourceRequest("can you send me the report?")).toBe(true);
    expect(detectsResourceRequest("where can I find the article")).toBe(true);
    expect(detectsResourceRequest("מה שעות הפתיחה שלכם?")).toBe(false);
    expect(detectsResourceRequest("thanks!")).toBe(false);
  });

  it("the research prompt block now REQUIRES a URL for resource asks", () => {
    const block = buildResearchBlock({
      answer: "סיכום",
      results: [
        { title: "AI Report 2026", url: "https://example.com/ai-report", content: "תוכן", score: 0.9 },
      ],
    });
    // The old rule forbade URLs outright; the new rule mandates them for
    // resource requests and forbids re-promising a link without sending one.
    expect(block).toContain("חובה לכלול בתשובה את כתובת ה-URL המלאה");
    expect(block).not.toContain("אסור לכלול בתשובה סימוני מקור כמו [1] או כתובות URL");
    expect(block).toContain("https://example.com/ai-report");
  });
});
