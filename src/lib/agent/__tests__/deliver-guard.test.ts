// Send-layer approval guard (rule 2026-07-28): with the global toggle on, NO
// bot-initiated 1-on-1 send leaves deliverReply — it queues for approval
// instead. Groups never hit the guard (their own toggle governs, upstream).
import { describe, expect, it } from "vitest";
import { deliverReply, queueDmForApproval } from "../deliver.server";
import type { AgentContext } from "../types";
import { DM_CHAT_ID, makeFakeSupa, makeFakeWhapi, type FakeSupa } from "./fake-supa";

function seed(): Record<string, import("./fake-supa").Row[]> {
  return {
    scheduled_approvals: [],
    user_roles: [{ id: "r1", user_id: "admin-user-1", role: "admin", created_at: "2026-01-01" }],
    bot_decisions: [],
    messages: [],
    conversations: [],
    bot_settings: [],
  };
}

function ctxFor(opts: { chatId: string; isGroup: boolean; approvalAll: boolean }): AgentContext {
  return {
    settings: {
      enabled: true,
      system_prompt: "",
      bot_name: "Bot",
      require_approval_all: opts.approvalAll,
    },
    conversation: {
      id: "conv-1",
      whapi_chat_id: opts.chatId,
      name: "Test Contact",
      is_group: opts.isGroup,
      inbound_count: 3,
      consecutive_outbound: 0,
      blocked: false,
      last_outbound_at: null,
      last_outbound_body: null,
    },
    history: [],
    message: {
      chatId: opts.chatId,
      chatName: "",
      senderId: opts.chatId,
      senderName: "Test Contact",
      body: "היי",
      isGroup: opts.isGroup,
      fromMe: false,
      messageId: "m1",
      ts: 1_753_700_000_000,
      mentions: [],
      quotedId: null,
      quotedAuthor: null,
    },
  };
}

const approvals = (fake: FakeSupa) => fake.state.scheduled_approvals ?? [];

describe("deliverReply send-layer approval guard", () => {
  it("global ON + DM → nothing sent, message queued for approval", async () => {
    const fake = makeFakeSupa(seed());
    const whapi = makeFakeWhapi();
    const res = await deliverReply(
      fake.client as never,
      whapi.port,
      ctxFor({ chatId: DM_CHAT_ID, isGroup: false, approvalAll: true }),
      ["קיבלתי — אני בודק את זה"],
      { humanPacing: false, botName: "Bot" },
    );
    expect(whapi.sends).toHaveLength(0);
    expect(res.queuedApprovalId).toBeTruthy();
    expect(approvals(fake)).toHaveLength(1);
    expect(approvals(fake)[0]).toMatchObject({
      target_chat_id: DM_CHAT_ID,
      status: "pending",
      body: "קיבלתי — אני בודק את זה",
    });
  });

  it("global ON + DM: identical pending approval is not duplicated", async () => {
    const fake = makeFakeSupa(seed());
    const whapi = makeFakeWhapi();
    const ctx = ctxFor({ chatId: DM_CHAT_ID, isGroup: false, approvalAll: true });
    await deliverReply(fake.client as never, whapi.port, ctx, ["שורה"], {
      humanPacing: false,
      botName: "Bot",
    });
    await deliverReply(fake.client as never, whapi.port, ctx, ["שורה"], {
      humanPacing: false,
      botName: "Bot",
    });
    expect(approvals(fake)).toHaveLength(1);
  });

  it("global OFF + DM → sends normally", async () => {
    const fake = makeFakeSupa(seed());
    const whapi = makeFakeWhapi();
    const res = await deliverReply(
      fake.client as never,
      whapi.port,
      ctxFor({ chatId: DM_CHAT_ID, isGroup: false, approvalAll: false }),
      ["תשובה רגילה"],
      { humanPacing: false, botName: "Bot" },
    );
    expect(whapi.sends).toHaveLength(1);
    expect(res.queuedApprovalId).toBeUndefined();
    expect(approvals(fake)).toHaveLength(0);
  });

  it("global ON + GROUP → the guard does not apply (group toggle governs upstream)", async () => {
    const fake = makeFakeSupa(seed());
    const whapi = makeFakeWhapi();
    await deliverReply(
      fake.client as never,
      whapi.port,
      ctxFor({ chatId: "1203630000000@g.us", isGroup: true, approvalAll: true }),
      ["תשובה בקבוצה"],
      { humanPacing: false, botName: "Bot" },
    );
    expect(whapi.sends).toHaveLength(1);
    expect(approvals(fake)).toHaveLength(0);
  });
});

describe("queueDmForApproval", () => {
  it("creates a pending ai_reply approval owned by the admin", async () => {
    const fake = makeFakeSupa(seed());
    const id = await queueDmForApproval(fake.client as never, {
      conversationId: "conv-1",
      chatId: DM_CHAT_ID,
      targetName: "Test",
      body: "טיוטה",
    });
    expect(id).toBeTruthy();
    expect(approvals(fake)[0]).toMatchObject({
      user_id: "admin-user-1",
      source: "ai_reply",
      status: "pending",
    });
  });
});
