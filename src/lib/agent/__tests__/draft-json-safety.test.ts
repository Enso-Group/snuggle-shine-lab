import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock only callLLM; keep the real parseJsonLoose so draftReply's parsing runs.
const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});

import { draftReply } from "../stages.server";
import type { AgentContext, IntentAnalysis } from "../types";

function llmReturns(content: string) {
  callLLMMock.mockResolvedValue({
    content,
    model: "test-model",
    toolCalls: [],
    finishReason: "stop",
  });
}

const intent: IntentAnalysis = {
  intent: "wants details",
  language: "he",
  urgency: "normal",
  sentiment: "neutral",
  goal: "reply helpfully",
  escalate: false,
  escalate_reason: null,
  context_relation: "continuation",
  context_reason: null,
};

function makeCtx(): AgentContext {
  return {
    settings: {
      id: "s1",
      enabled: true,
      system_prompt: "פרסונה",
      bot_name: "בוט",
      require_approval_all: false,
      model_strong: null,
      model_fast: null,
      agent_config: {},
    },
    conversation: {
      id: "c1",
      whapi_chat_id: "972500000000@s.whatsapp.net",
      name: null,
      is_group: false,
      inbound_count: 1,
      consecutive_outbound: 0,
      blocked: false,
      last_outbound_at: null,
      last_outbound_body: null,
    },
    history: [],
    message: {
      chatId: "972500000000@s.whatsapp.net",
      chatName: "",
      senderId: "972500000000@s.whatsapp.net",
      senderName: "אלעד",
      body: "היי, מה קורה?",
      isGroup: false,
      fromMe: false,
      messageId: "wamid-1",
      ts: Date.now(),
      mentions: [],
      quotedId: null,
      quotedAuthor: null,
    },
    kb: { block: "", count: 0 },
    person: null,
    groupProfile: null,
  };
}

describe("draftReply — JSON envelope never leaks to users", () => {
  beforeEach(() => callLLMMock.mockReset());

  it("returns only the messages strings from a valid envelope, never the reasoning", async () => {
    llmReturns(
      '{"messages": ["היי אלעד, הכל בסדר גמור, מה שלומך?"], "reasoning": "Responded naturally to the greeting."}',
    );
    const draft = await draftReply(makeCtx(), intent);
    expect(draft.messages).toEqual(["היי אלעד, הכל בסדר גמור, מה שלומך?"]);
    // The English reasoning is kept for logging but must not appear in any message.
    for (const part of draft.messages) {
      expect(part).not.toContain("reasoning");
      expect(part).not.toContain("Responded naturally");
      expect(part).not.toContain("{");
    }
  });

  it("REFUSES to send a truncated/garbled JSON envelope (throws instead of leaking raw JSON)", async () => {
    // The realistic failure: the model's JSON got cut off, so it can't be parsed.
    llmReturns('{"messages": ["היי אלעד, הכל בסדר גמור');
    await expect(draftReply(makeCtx(), intent)).rejects.toThrow();
  });

  it("REFUSES a well-formed object that has no usable messages array", async () => {
    llmReturns('{"reasoning": "I decided not to answer"}');
    await expect(draftReply(makeCtx(), intent)).rejects.toThrow();
  });

  it("still sends genuine plain-text output when the model ignores the JSON format", async () => {
    llmReturns("שלום אלעד, אפשר לעזור לך בכיף — מה תרצה לדעת?");
    const draft = await draftReply(makeCtx(), intent);
    expect(draft.messages).toEqual(["שלום אלעד, אפשר לעזור לך בכיף — מה תרצה לדעת?"]);
  });
});
