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
//   dashboard) actually wrote in their 1:1 chat — sender_id 'bot'/'manual',
//   which imported from_me history does not set — or is about to (pending
//   reply job or approval draft). v2 also kept any profile carrying
//   bot-learned analysis (facts / funnel stage / sentiment), but the analyzer
//   runs on merely-observed contacts too, so that rule kept never-talked-to
//   noise on the Profiles page. '@simulation' profiles are simulator
//   leftovers and are always deleted (cleanupSimulations never touches
//   people).
import { normalizeWaId } from "./wa-id";

export type CleanupPerson = {
  id: string;
  wa_id: string;
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

export function planCleanup(input: CleanupInput): CleanupPlan {
  const keep = new Set<string>();
  for (const c of input.conversations) {
    if (input.participatedConvIds.has(c.id) || input.protectedConvIds.has(c.id)) {
      keep.add(c.id);
    }
  }
  const convIdsToDelete = input.conversations.filter((c) => !keep.has(c.id)).map((c) => c.id);

  // Canonical ids of 1:1 chats the platform wrote in, or is about to write
  // in. Canonical (normalizeWaId) rather than raw phone-part comparison, so
  // ':<device>' spellings and '@c.us'/'@s.whatsapp.net' variants all line up.
  const engagedIds = new Set<string>();
  for (const c of input.conversations) {
    if (c.is_group || !keep.has(c.id)) continue;
    if (input.botConvIds.has(c.id) || input.protectedConvIds.has(c.id)) {
      const canon = normalizeWaId(c.whapi_chat_id);
      if (canon) engagedIds.add(canon);
    }
  }

  const personIdsToDelete = input.people
    .filter((p) => {
      if (p.wa_id.endsWith("@simulation")) return true;
      const canon = normalizeWaId(p.wa_id);
      // Not a person id at all (group id / junk) → never a real profile.
      if (!canon) return true;
      return !engagedIds.has(canon);
    })
    .map((p) => p.id);

  return { convIdsToDelete, personIdsToDelete, keptConvIds: [...keep] };
}
