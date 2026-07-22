// Native WhatsApp poll structure — pure validation, no I/O.
// WhatsApp (via Whapi POST /messages/poll) requires 2-12 UNIQUE options;
// `count` is how many options the voter may select.

export type PollSpec = {
  question: string;
  options: string[];
  /** True → voters may pick multiple options. */
  multi: boolean;
};

const MAX_QUESTION = 255;
const MAX_OPTION = 100;
const MAX_OPTIONS = 12;

/**
 * Normalize a model-proposed poll into a sendable PollSpec, or null when it
 * can't form a valid poll (fewer than 2 usable options, empty question).
 */
export function normalizePoll(raw: unknown): PollSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const question = String(obj.question ?? "")
    .trim()
    .slice(0, MAX_QUESTION);
  if (!question) return null;

  const seen = new Set<string>();
  const options: string[] = [];
  for (const o of Array.isArray(obj.options) ? obj.options : []) {
    const text = String(o ?? "")
      .trim()
      // Strip leading emoji-number/bullet decorations the model might add.
      .replace(/^(?:[0-9]+[.)]\s*|[0-9]️?⃣\s*|[-•*]\s*)/u, "")
      .slice(0, MAX_OPTION);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // WhatsApp rejects duplicate options
    seen.add(key);
    options.push(text);
    if (options.length >= MAX_OPTIONS) break;
  }
  if (options.length < 2) return null;

  return { question, options, multi: obj.multi === true };
}

/** Selectable-answers count for the Whapi payload. */
export function pollCount(poll: PollSpec): number {
  return poll.multi ? poll.options.length : 1;
}

/** Plain-text rendering for message history / timelines (not for sending). */
export function pollAsHistoryText(poll: PollSpec): string {
  return `📊 ${poll.question}\n${poll.options.map((o) => `▫️ ${o}`).join("\n")}`;
}
