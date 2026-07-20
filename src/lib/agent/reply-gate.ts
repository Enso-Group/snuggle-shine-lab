// Reply-decision gate — pure signal detection, no I/O. The server wrapper
// (reply-gate.server.ts) resolves the bot's own WA id and the quoted-message
// lookup, then delegates the actual decision logic here so it's unit-testable.
import type { InboundMessage } from "./inbound";

export type DirectSignal = "mentioned" | "reply_to_bot" | "named" | "none";

/** Digits-only form of a WhatsApp id ("9725...@s.whatsapp.net" → "9725..."). */
export function normalizeWaId(id: string | null | undefined): string {
  if (!id) return "";
  return id.replace(/@.*$/, "").replace(/\D/g, "");
}

/**
 * Is the bot's display name used in the text as a standalone word?
 * JS \b is ASCII-only, so boundaries are "not a letter" checks (unicode-aware),
 * which works for Hebrew, Arabic, Cyrillic and Latin names alike.
 */
export function nameMentioned(body: string, botName: string): boolean {
  const name = botName.trim();
  if (name.length < 2) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A single Hebrew prefix letter (ל/ב/מ/ו/ה/ש/כ) attached to the name still
  // counts — "לדני" is "to Dani".
  return new RegExp(`(^|[^\\p{L}])[ולבמהשכ]?${escaped}([^\\p{L}]|$)`, "iu").test(body);
}

export type DirectSignalInput = {
  message: Pick<InboundMessage, "body" | "mentions" | "quotedAuthor">;
  /** The bot's own WA id (digits or full form). Empty string if unknown. */
  ownWaId: string;
  botName: string;
  /** True when the quoted message id was found among the bot's outbound messages. */
  quotedIsBotMessage: boolean;
};

/**
 * Deterministic signals that the message is addressed to the bot.
 * Deliberately narrow: a mention of ANYONE ELSE is not a signal (this replaces
 * the old /@\d+/ catch-all that made the bot answer chatter between members).
 */
export function detectDirectSignal(input: DirectSignalInput): DirectSignal {
  const own = normalizeWaId(input.ownWaId);
  if (own && input.message.mentions.some((id) => normalizeWaId(id) === own)) {
    return "mentioned";
  }
  if (input.quotedIsBotMessage) return "reply_to_bot";
  if (own && normalizeWaId(input.message.quotedAuthor) === own) return "reply_to_bot";
  if (nameMentioned(input.message.body, input.botName)) return "named";
  return "none";
}
