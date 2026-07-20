// Pure inbound-message helpers: Whapi payload parsing and human-delivery math.
// No I/O — unit-tested directly.

export type InboundMessage = {
  chatId: string;
  chatName: string;
  senderId: string;
  senderName: string;
  body: string;
  isGroup: boolean;
  fromMe: boolean;
  messageId: string;
  ts: number;
};

export function normalizeTimestampMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n > 9_999_999_999 ? n : n * 1000;
}

/** The subset of a raw Whapi webhook message the bot reads (fields vary by event shape). */
export type RawWhapiMessage = {
  id?: string;
  chat_id?: string;
  chatId?: string;
  from?: string;
  author?: string;
  from_me?: boolean;
  from_name?: string;
  author_name?: string;
  pushname?: string;
  chat_name?: string;
  group_name?: string;
  chat?: { name?: string };
  body?: string;
  caption?: string;
  text?: { body?: string } | string;
  timestamp?: number | string;
};

/** Extract the fields we care about from a raw Whapi webhook message. */
export function parseWhapiMessage(m: RawWhapiMessage | null | undefined): InboundMessage | null {
  if (!m) return null;
  const chatId = m.chat_id || m.from || m.chatId;
  if (!chatId) return null;
  const textBody = typeof m.text === "object" ? m.text?.body : m.text;
  const body = textBody ?? m.body ?? m.caption ?? "";
  return {
    chatId: String(chatId),
    chatName: m.chat_name || m.chat?.name || m.group_name || "",
    senderId: m.from || m.author || String(chatId),
    senderName: m.from_name || m.author_name || m.pushname || "",
    body: String(body || ""),
    isGroup: String(chatId).endsWith("@g.us"),
    fromMe: !!m.from_me,
    messageId: m.id || "",
    ts: normalizeTimestampMs(m.timestamp),
  };
}

/**
 * Typing-indicator duration for a message of the given length, in seconds.
 * Roughly human typing speed, clamped so short replies still feel considered
 * and long ones don't stall the conversation.
 */
export function typingSecondsFor(text: string): number {
  return Math.min(7, Math.max(2, Math.round(text.length / 25)));
}

/** Short natural pause between consecutive message parts, in milliseconds. */
export function interPartDelayMs(): number {
  return 900 + Math.floor(Math.random() * 800);
}

/**
 * Normalize a drafted reply into WhatsApp-natural parts: at most `maxParts`
 * non-empty messages. If the model returned one long wall of text, split it on
 * paragraph boundaries. Never splits mid-sentence.
 */
export function normalizeReplyParts(parts: string[], maxParts = 3): string[] {
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  if (cleaned.length > maxParts) {
    // Merge overflow into the last allowed part rather than dropping content.
    return [...cleaned.slice(0, maxParts - 1), cleaned.slice(maxParts - 1).join("\n\n")];
  }
  if (cleaned.length === 1 && cleaned[0].length > 500) {
    const paragraphs = cleaned[0]
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paragraphs.length > 1) {
      const merged: string[] = [];
      for (const p of paragraphs) {
        const last = merged[merged.length - 1];
        if (merged.length && (last.length + p.length < 300 || merged.length >= maxParts)) {
          merged[merged.length - 1] = `${last}\n\n${p}`;
        } else {
          merged.push(p);
        }
      }
      return merged.slice(0, maxParts);
    }
  }
  return cleaned;
}

/** Retry backoff for failed jobs: 30s, 2m, then 10m. */
export function retryBackoffMs(attempts: number): number {
  const steps = [30_000, 120_000, 600_000];
  return steps[Math.min(Math.max(attempts - 1, 0), steps.length - 1)];
}

/** Constant-time string comparison for webhook/cron secrets. */
export function secretsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  const len = Math.max(bufA.length, bufB.length, 1);
  let diff = bufA.length === bufB.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}
