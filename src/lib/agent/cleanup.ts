// Pure planning logic for the non-participated-chats cleanup. No I/O — the
// server wrapper (cleanup.server.ts) feeds it query results and executes the
// returned plan. Unit-tested directly.

/** The part of a WhatsApp id before the @suffix ("9725...@s.whatsapp.net" → "9725..."). */
export function phonePart(id: string | null | undefined): string {
  if (!id) return "";
  return id.split("@")[0];
}

export type CleanupInput = {
  /** Every stored conversation. */
  conversations: Array<{ id: string; whapi_chat_id: string }>;
  /** Conversation ids with at least one our-side message (outbound row or from_me raw). */
  participatedConvIds: Set<string>;
  /**
   * Conversation ids that must survive even without an our-side message yet:
   * a reply in flight (pending/processing job) or a draft awaiting approval.
   */
  protectedConvIds: Set<string>;
  /** Every stored person profile. */
  people: Array<{ id: string; wa_id: string }>;
  /** sender_ids seen in the conversations that are being kept. */
  senderIdsInKeptConvs: string[];
};

export type CleanupPlan = {
  convIdsToDelete: string[];
  personIdsToDelete: string[];
  keptConvIds: string[];
};

/**
 * Decide which conversations and person profiles to delete.
 * A conversation is kept iff the account participated in it (or participation
 * is imminent — protected). A person is kept iff they're connected to a kept
 * conversation: its 1:1 counterpart (same phone part, any @suffix spelling) or
 * a sender inside it (e.g. members of managed groups the bot writes in).
 */
export function planCleanup(input: CleanupInput): CleanupPlan {
  const keep = new Set<string>();
  for (const c of input.conversations) {
    if (input.participatedConvIds.has(c.id) || input.protectedConvIds.has(c.id)) {
      keep.add(c.id);
    }
  }
  const convIdsToDelete = input.conversations.filter((c) => !keep.has(c.id)).map((c) => c.id);

  const keptPhones = new Set<string>();
  for (const c of input.conversations) {
    if (keep.has(c.id)) keptPhones.add(phonePart(c.whapi_chat_id));
  }
  for (const sender of input.senderIdsInKeptConvs) {
    const p = phonePart(sender);
    if (p) keptPhones.add(p);
  }

  const personIdsToDelete = input.people
    .filter((p) => !keptPhones.has(phonePart(p.wa_id)))
    .map((p) => p.id);

  return { convIdsToDelete, personIdsToDelete, keptConvIds: [...keep] };
}
