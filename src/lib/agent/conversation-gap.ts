// Conversation-gap awareness for private chats — pure helpers, no I/O.
//
// When a DM arrives long after the previous message, the intent stage asks
// the model whether it continues the earlier thread or opens a new topic.
// There is deliberately NO time-based reset: an old thread stays live when
// the content refers back to it ("כן, תעשה את זה" six hours later), and only
// the model's content+gap judgment retires it. The threshold below merely
// decides when the question is worth asking — under it, messages are a
// continuation by any human standard and asking would only invite wrong
// "fresh" verdicts.

export const SIGNIFICANT_GAP_MS = 30 * 60 * 1000;

export function isSignificantGap(gapMs: number | null | undefined): boolean {
  return typeof gapMs === "number" && gapMs >= SIGNIFICANT_GAP_MS;
}

/** Human Hebrew phrase for a time gap, for use inside prompts. */
export function gapDescription(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} דקות`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "כשעה" : `כ-${hours} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? "כיממה" : `כ-${days} ימים`;
}
