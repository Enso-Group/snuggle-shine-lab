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
  /** WA ids explicitly @-mentioned in the message. */
  mentions: string[];
  /** Whapi id of the message this one replies to (quoted), if any. */
  quotedId: string | null;
  /** WA id of the author of the quoted message, if any. */
  quotedAuthor: string | null;
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
  context?: {
    quoted_id?: string;
    quoted_message_id?: string;
    quoted_author?: string;
    participant?: string;
    mentions?: string[];
    mentioned?: string[];
  };
};

/** Extract the fields we care about from a raw Whapi webhook message. */
export function parseWhapiMessage(m: RawWhapiMessage | null | undefined): InboundMessage | null {
  if (!m) return null;
  const chatId = m.chat_id || m.from || m.chatId;
  if (!chatId) return null;
  const textBody = typeof m.text === "object" ? m.text?.body : m.text;
  const body = textBody ?? m.body ?? m.caption ?? "";
  const ctx = m.context ?? {};
  const mentions = (ctx.mentions ?? ctx.mentioned ?? []).map((x) => String(x)).filter(Boolean);
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
    mentions,
    quotedId: ctx.quoted_id || ctx.quoted_message_id || null,
    quotedAuthor: ctx.quoted_author || ctx.participant || null,
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

export const REPLY_TARGET_MIN_MS = 15_000;
export const REPLY_TARGET_MAX_MS = 120_000;

/**
 * How long after receiving a DM the reply should land, in milliseconds —
 * a fresh uniform draw in the 15s–2min window per message, so response timing
 * looks human rather than machine-constant. This is the DURABLE delay: it is
 * encoded in the job's run_after (see enqueueInboundReply), never slept out
 * inside the webhook request — a Cloudflare Worker cannot hold a request open
 * that long, and doing so used to strand the job under its claim lock and push
 * the reply out to several minutes.
 */
export function randomReplyDelayMs(): number {
  return (
    REPLY_TARGET_MIN_MS + Math.floor(Math.random() * (REPLY_TARGET_MAX_MS - REPLY_TARGET_MIN_MS))
  );
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

/**
 * True when a string looks like the model's raw structured output — a JSON
 * envelope (`{"messages": [...], "reasoning": "..."}`), a ```json fence, or a
 * bare `{"key": ...}` object — rather than a natural reply. The reply pipeline
 * uses this as a hard gate so the model's JSON envelope, and in particular its
 * English "reasoning" field, can never be delivered to a user even if JSON
 * parsing upstream failed or partially succeeded.
 */
export function looksLikeStructuredOutput(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Fenced code block, e.g. ```json ... ```
  if (t.startsWith("```")) return true;
  // Carries our reply envelope keys.
  if (/"(messages|reasoning)"\s*:/.test(t)) return true;
  // Starts like a JSON object with a quoted key: {"foo": ...}
  if (/^\{\s*"[^"]+"\s*:/.test(t)) return true;
  // A whole-string JSON object or array.
  if (/^[[{][\s\S]*[\]}]$/.test(t) && /^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return true;
    } catch {
      /* not valid JSON — fall through */
    }
  }
  return false;
}

/**
 * Final safety net over the parts about to be sent: drop any part that still
 * looks like raw structured output. Returns the safe parts and whether anything
 * was stripped, so the caller can log the leak and decide to send nothing
 * rather than deliver a JSON blob.
 */
export function stripStructuredOutput(parts: string[]): { parts: string[]; leaked: boolean } {
  let leaked = false;
  const safe = parts.filter((p) => {
    if (looksLikeStructuredOutput(p)) {
      leaked = true;
      return false;
    }
    return true;
  });
  return { parts: safe, leaked };
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
