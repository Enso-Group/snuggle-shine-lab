// Pure planning logic for the people-profile dedupe. No I/O — the server
// wrapper (people-dedupe.server.ts) feeds it the people table and executes the
// returned plan. Unit-tested directly.
//
// Why this exists: people.wa_id is unique on the RAW string, and Whapi spells
// the same human several ways (bare digits, '@s.whatsapp.net', '@c.us',
// ':<device>'), so the table accumulated one profile per spelling. The plan
// collapses every canonical-key group (see wa-id.ts) into its earliest row,
// folds the duplicates' memory into it, and renames stragglers to the
// canonical spelling so future lookups hit one row.
import type { PersonFact } from "./people.server";
import { normalizeWaId } from "./wa-id";

const FACTS_CAP = 40;

export type DedupePersonRow = {
  id: string;
  wa_id: string;
  created_at: string;
  display_name: string | null;
  language: string | null;
  sentiment: string | null;
  funnel_stage: string | null;
  facts: PersonFact[];
  tags: string[];
  first_seen_at: string;
  last_seen_at: string;
};

export type DedupeSurvivorPatch = {
  display_name: string | null;
  language: string | null;
  sentiment: string | null;
  funnel_stage: string;
  facts: PersonFact[];
  tags: string[];
  first_seen_at: string;
  last_seen_at: string;
};

export type DedupeMerge = {
  survivorId: string;
  survivorPatch: DedupeSurvivorPatch;
  loserIds: string[];
  canon: string;
  /** Every raw spelling in the group — loose references (follow_ups) are retargeted from these. */
  allVariantWaIds: string[];
};

export type DedupePlan = {
  /** Rows that are not people at all (group ids, junk) — removed outright. */
  deletes: string[];
  merges: DedupeMerge[];
  /** Singleton rows whose stored spelling just isn't canonical yet. */
  renames: Array<{ id: string; wa_id: string }>;
};

function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  for (const v of values) if (v !== null && v !== undefined) return v;
  return null;
}

/** Union of fact lists: dedupe on normalized text (first spelling wins), oldest first, newest kept when over cap. */
function unionFacts(lists: PersonFact[][]): PersonFact[] {
  const seen = new Set<string>();
  const all: PersonFact[] = [];
  for (const list of lists) {
    for (const f of list) {
      if (!f || typeof f.text !== "string") continue;
      const key = f.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(f);
    }
  }
  all.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return all.slice(-FACTS_CAP);
}

export function planPeopleDedupe(rows: DedupePersonRow[]): DedupePlan {
  const deletes: string[] = [];
  const groups = new Map<string, DedupePersonRow[]>();
  for (const row of rows) {
    const canon = normalizeWaId(row.wa_id);
    if (!canon) {
      deletes.push(row.id);
      continue;
    }
    const group = groups.get(canon);
    if (group) group.push(row);
    else groups.set(canon, [row]);
  }

  const merges: DedupeMerge[] = [];
  const renames: Array<{ id: string; wa_id: string }> = [];
  for (const [canon, group] of groups) {
    if (group.length === 1) {
      const only = group[0];
      if (only.wa_id !== canon) renames.push({ id: only.id, wa_id: canon });
      continue;
    }
    // Survivor = earliest row: its id may already be referenced elsewhere, and
    // first_seen_at semantics favor the oldest profile.
    const sorted = [...group].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
    const [survivor, ...losers] = sorted;
    merges.push({
      survivorId: survivor.id,
      loserIds: losers.map((l) => l.id),
      canon,
      allVariantWaIds: [...new Set(sorted.map((r) => r.wa_id))],
      survivorPatch: {
        display_name: firstNonNull(sorted.map((r) => r.display_name)),
        language: firstNonNull(sorted.map((r) => r.language)),
        sentiment: firstNonNull(sorted.map((r) => r.sentiment)),
        funnel_stage:
          firstNonNull(
            sorted.map((r) => (r.funnel_stage && r.funnel_stage !== "unknown" ? r.funnel_stage : null)),
          ) ?? "unknown",
        facts: unionFacts(sorted.map((r) => (Array.isArray(r.facts) ? r.facts : []))),
        tags: [...new Set(sorted.flatMap((r) => (Array.isArray(r.tags) ? r.tags : [])))],
        first_seen_at: sorted
          .map((r) => r.first_seen_at)
          .reduce((a, b) => (a <= b ? a : b)),
        last_seen_at: sorted.map((r) => r.last_seen_at).reduce((a, b) => (a >= b ? a : b)),
      },
    });
  }

  return { deletes, merges, renames };
}
