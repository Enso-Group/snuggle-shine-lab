// Pure planning logic for the non-participated-chats cleanup. No I/O — the
// server wrapper (cleanup.server.ts) feeds it query results and executes the
// returned plan. Unit-tested directly.
//
// Two different bars, on purpose:
// * CONVERSATIONS are kept when the ACCOUNT participated — any our-side
//   message, including the owner's own historical (from_me) messages brought
//   in by the 1:1 history import. That history was imported deliberately and
//   must survive.
// * PERSON PROFILES are kept only when the BOT (or the manager via the
//   dashboard) actually engaged the contact: a platform-sent message in their
//   1:1 chat, bot-learned analysis on the profile (facts / funnel stage /
//   sentiment), or an imminent engagement (pending reply job or approval
//   draft). A profile whose only claim is "the owner once texted them" or
//   "they spoke in a group we watch" is noise on the Profiles page.

/** The part of a WhatsApp id before the @suffix ("9725...@s.whatsapp.net" → "9725..."). */
export function phonePart(id: string | null | undefined): string {
  if (!id) return "";
  return id.split("@")[0];
}

export type CleanupPerson = {
  id: string;
  wa_id: string;
  factsCount: number;
  funnelStage: string | null;
  sentiment: string | null;
};

export type CleanupInput = {
  /** Every stored conversation. */
  conversations: Array<{ id: string; whapi_chat_id: string; is_group: boolean }>;
  /** Conversation ids with at least one our-side message (outbound row or from_me raw). */
  participatedConvIds: Set<string>;
  /**
   * Conversation ids that must survive even without an our-side message yet:
   * a reply in flight (pending/processing job) or a draft awaiting approval.
   */
  protectedConvIds: Set<string>;
  /** Conversation ids where the platform itself wrote (sender_id 'bot'/'manual'). */
  botConvIds: Set<string>;
  /** Every stored person profile. */
  people: CleanupPerson[];
};

export type CleanupPlan = {
  convIdsToDelete: string[];
  personIdsToDelete: string[];
  keptConvIds: string[];
};

/** True when the bot's pipeline has learned anything about this person. */
function hasBotAnalysis(p: CleanupPerson): boolean {
  if (p.factsCount > 0) return true;
  if (p.funnelStage && p.funnelStage !== "unknown") return true;
  if (p.sentiment) return true;
  return false;
}

export function planCleanup(input: CleanupInput): CleanupPlan {
  const keep = new Set<string>();
  for (const c of input.conversations) {
    if (input.participatedConvIds.has(c.id) || input.protectedConvIds.has(c.id)) {
      keep.add(c.id);
    }
  }
  const convIdsToDelete = input.conversations.filter((c) => !keep.has(c.id)).map((c) => c.id);

  // Phones whose 1:1 chat the platform wrote in, or is about to write in.
  const engagedPhones = new Set<string>();
  for (const c of input.conversations) {
    if (c.is_group || !keep.has(c.id)) continue;
    if (input.botConvIds.has(c.id) || input.protectedConvIds.has(c.id)) {
      engagedPhones.add(phonePart(c.whapi_chat_id));
    }
  }

  const personIdsToDelete = input.people
    .filter((p) => !hasBotAnalysis(p) && !engagedPhones.has(phonePart(p.wa_id)))
    .map((p) => p.id);

  return { convIdsToDelete, personIdsToDelete, keptConvIds: [...keep] };
}
