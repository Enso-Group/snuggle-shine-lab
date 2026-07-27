// Inbound routing for WhatsApp admins: a DM from a listed phone must switch to
// management mode (admin_command job), and NOTHING else may — the security
// contract is that regular users can never reach the admin path.
import { describe, expect, it } from "vitest";
import { handleInboundMessage } from "../inbound-handler.server";
import type { AgentDeps, AgentSettings } from "../types";
import type { InboundMessage } from "../inbound";
import { makeFakeSupa, makeFakeWhapi, type FakeSupa, type Row } from "./fake-supa";

const ADMIN_PHONE = "972501111111";
const ADMIN_CHAT = `${ADMIN_PHONE}@s.whatsapp.net`;

function makeSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    id: "settings-1",
    enabled: true,
    system_prompt: "persona",
    bot_name: "Bot",
    require_approval_all: false,
    agent_config: { wa_admins: [{ phone: ADMIN_PHONE, label: "Itamar" }] },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: ADMIN_CHAT,
    chatName: "Itamar",
    senderId: ADMIN_CHAT,
    senderName: "Itamar",
    body: "מה הסטטוס של הבוט?",
    isGroup: false,
    fromMe: false,
    messageId: "wamid-1",
    ts: Date.now() - 3_000,
    mentions: [],
    quotedId: null,
    quotedAuthor: null,
    ...overrides,
  };
}

function makeDeps(fake: FakeSupa): AgentDeps {
  return {
    supabase: fake.client,
    whapi: makeFakeWhapi().port,
    trigger: "inbound",
    workerId: "worker-test",
    humanPacing: false,
  };
}

function seedTables(): Record<string, Row[]> {
  return {
    conversations: [],
    messages: [],
    bot_jobs: [],
    bot_decisions: [],
    group_profiles: [],
  };
}

function jobKinds(fake: FakeSupa): string[] {
  return (fake.inserts.bot_jobs ?? []).map((j) => String(j.kind));
}

describe("admin recognition in the inbound handler", () => {
  it("routes an admin DM to an admin_command job, not the reply pipeline", async () => {
    const fake = makeFakeSupa(seedTables());
    const outcome = await handleInboundMessage(makeDeps(fake), makeSettings(), makeMessage(), {});
    expect(outcome.action).toBe("enqueued");
    expect(jobKinds(fake)).toEqual(["admin_command"]);
    // The admin chat was persisted with the inbound message.
    expect(fake.inserts.messages).toHaveLength(1);
  });

  it("works while the bot is DISABLED — admins can turn it back on by chat", async () => {
    const fake = makeFakeSupa(seedTables());
    const settings = makeSettings({ enabled: false });
    const outcome = await handleInboundMessage(makeDeps(fake), settings, makeMessage(), {});
    expect(outcome.action).toBe("enqueued");
    expect(jobKinds(fake)).toEqual(["admin_command"]);
  });

  it("bypasses the trivial-ack and stop-request gates for admin messages", async () => {
    const fake = makeFakeSupa(seedTables());
    const outcome = await handleInboundMessage(
      makeDeps(fake),
      makeSettings(),
      makeMessage({ body: "תודה" }),
      {},
    );
    expect(outcome.action).toBe("enqueued");
    expect(jobKinds(fake)).toEqual(["admin_command"]);
  });

  it("NEVER treats a group message as an admin command, even from an admin phone", async () => {
    const fake = makeFakeSupa(seedTables());
    const outcome = await handleInboundMessage(
      makeDeps(fake),
      makeSettings(),
      makeMessage({
        chatId: "120363000000000001@g.us",
        isGroup: true,
        senderId: ADMIN_CHAT,
      }),
      {},
    );
    expect(jobKinds(fake)).not.toContain("admin_command");
    expect(outcome.action).toBe("group_not_addressed");
  });

  it("NEVER routes a non-admin DM to management mode (display names are not trusted)", async () => {
    const fake = makeFakeSupa(seedTables());
    const outcome = await handleInboundMessage(
      makeDeps(fake),
      makeSettings(),
      makeMessage({
        chatId: "972509999999@s.whatsapp.net",
        senderId: "972509999999@s.whatsapp.net",
        senderName: "Itamar", // spoofed display name
      }),
      {},
    );
    expect(outcome.action).toBe("enqueued");
    expect(jobKinds(fake)).toEqual(["inbound_reply"]);
  });

  it("NEVER matches an '@lid' chat id whose digits collide with an admin phone", async () => {
    const fake = makeFakeSupa(seedTables());
    await handleInboundMessage(
      makeDeps(fake),
      makeSettings(),
      makeMessage({ chatId: `${ADMIN_PHONE}@lid`, senderId: `${ADMIN_PHONE}@lid` }),
      {},
    );
    expect(jobKinds(fake)).not.toContain("admin_command");
  });

  it("drops replayed (stale) admin messages instead of re-executing them", async () => {
    const fake = makeFakeSupa(seedTables());
    const outcome = await handleInboundMessage(
      makeDeps(fake),
      makeSettings(),
      makeMessage({ ts: Date.now() - 20 * 60 * 1000 }),
      {},
    );
    expect(outcome.action).toBe("stored_stale");
    expect(jobKinds(fake)).toEqual([]);
  });

  it("does nothing special when no admins are configured", async () => {
    const fake = makeFakeSupa(seedTables());
    const outcome = await handleInboundMessage(
      makeDeps(fake),
      makeSettings({ agent_config: {} }),
      makeMessage(),
      {},
    );
    expect(outcome.action).toBe("enqueued");
    expect(jobKinds(fake)).toEqual(["inbound_reply"]);
  });

  it("ignores admin routing in simulation", async () => {
    const fake = makeFakeSupa(seedTables());
    const deps = { ...makeDeps(fake), trigger: "simulation" as const };
    const outcome = await handleInboundMessage(deps, makeSettings(), makeMessage(), {});
    expect(jobKinds(fake)).not.toContain("admin_command");
    expect(outcome.action).toBe("enqueued");
  });
});
