// WhapiPort implementations: the real client for production, and a recording
// stub for simulation mode (full pipeline, zero real WhatsApp traffic).
import type { WhapiPort } from "./types";

export function realWhapiPort(): WhapiPort {
  return {
    async sendText(chatId, body) {
      const { sendTextMessage } = await import("@/lib/whapi.server");
      return sendTextMessage(chatId, body);
    },
    async sendPoll(chatId, title, options, count) {
      const { sendPoll } = await import("@/lib/whapi.server");
      return sendPoll(chatId, title, options, count);
    },
    async markRead(messageId) {
      const { markMessageRead } = await import("@/lib/whapi.server");
      await markMessageRead(messageId);
    },
    async react(messageId, emoji) {
      const { reactToMessage } = await import("@/lib/whapi.server");
      await reactToMessage(messageId, emoji);
    },
    async presence(chatId, presence, delaySec) {
      const { sendPresence } = await import("@/lib/whapi.server");
      await sendPresence(chatId, presence, delaySec);
    },
  };
}

export type RecordedWhapiCall =
  | { kind: "sendText"; chatId: string; body: string }
  | { kind: "sendPoll"; chatId: string; title: string; options: string[]; count: number }
  | { kind: "markRead"; messageId: string }
  | { kind: "react"; messageId: string; emoji: string }
  | { kind: "presence"; chatId: string; presence: string; delaySec: number };

export function recordingWhapiPort(): { port: WhapiPort; calls: RecordedWhapiCall[] } {
  const calls: RecordedWhapiCall[] = [];
  let msgCounter = 0;
  const port: WhapiPort = {
    async sendText(chatId, body) {
      calls.push({ kind: "sendText", chatId, body });
      msgCounter += 1;
      return { message: { id: `sim-out-${msgCounter}` } };
    },
    async sendPoll(chatId, title, options, count) {
      calls.push({ kind: "sendPoll", chatId, title, options, count });
      msgCounter += 1;
      return { message: { id: `sim-out-${msgCounter}` } };
    },
    async markRead(messageId) {
      calls.push({ kind: "markRead", messageId });
    },
    async react(messageId, emoji) {
      calls.push({ kind: "react", messageId, emoji });
    },
    async presence(chatId, presence, delaySec) {
      calls.push({ kind: "presence", chatId, presence, delaySec });
    },
  };
  return { port, calls };
}
