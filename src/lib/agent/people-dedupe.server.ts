// Self-healing dedupe of duplicate person profiles.
//
// Why this runs from the sweeper and not (only) the SQL migration
// (20260724120000_people_dedupe_unique.sql): the Lovable Cloud database only
// receives migrations when a human applies them in Lovable — a normal deploy
// must be enough for the duplicates to collapse. This pass is the app-side
// twin of that migration; whichever runs first does the work and the other
// finds nothing left to do. The migration's unique index is still the real
// guarantee — this pass just converges the data without waiting for it.
import { planPeopleDedupe, type DedupePersonRow } from "./people-dedupe";
import type { PersonFact } from "./people.server";
import type { Json } from "@/integrations/supabase/types";
import type { Supa } from "./types";

// Re-check cadence. The first run after deploy does the real work; afterwards
// this is a cheap safety net, so a long gap keeps the sweeper light.
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Version marker in the summary: bump when the rules change so the throttle
// doesn't suppress the first run of a newer rule set.
const DEDUPE_SUMMARY_PREFIX = "People dedupe v1";
const CHUNK = 100;

export type PeopleDedupeResult =
  | { ran: true; merged: number; renamed: number; deleted: number }
  | { ran: false; reason: string };

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function dedupePeople(
  supabase: Supa,
  opts: { force?: boolean } = {},
): Promise<PeopleDedupeResult> {
  try {
    if (!opts.force) {
      const { data: lastRun } = await supabase
        .from("bot_decisions")
        .select("created_at")
        .eq("stage", "config")
        .like("summary", `${DEDUPE_SUMMARY_PREFIX}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastRun && Date.now() - new Date(lastRun.created_at).getTime() < MIN_INTERVAL_MS) {
        return { ran: false, reason: "ran recently" };
      }
    }

    const { data: rows, error } = await supabase
      .from("people")
      .select(
        "id, wa_id, created_at, display_name, language, sentiment, funnel_stage, facts, tags, first_seen_at, last_seen_at",
      )
      .limit(5000);
    // A failed read must never look like "nothing to dedupe".
    if (error) return { ran: false, reason: `people query failed: ${error.message}` };

    const plan = planPeopleDedupe(
      (rows ?? []).map(
        (r): DedupePersonRow => ({
          id: r.id,
          wa_id: r.wa_id,
          created_at: r.created_at,
          display_name: r.display_name ?? null,
          language: r.language ?? null,
          sentiment: r.sentiment ?? null,
          funnel_stage: r.funnel_stage ?? null,
          facts: Array.isArray(r.facts) ? (r.facts as PersonFact[]) : [],
          tags: Array.isArray(r.tags) ? r.tags : [],
          first_seen_at: r.first_seen_at,
          last_seen_at: r.last_seen_at,
        }),
      ),
    );

    let deleted = 0;
    for (const batch of chunked(plan.deletes, CHUNK)) {
      const { error: delErr } = await supabase.from("people").delete().in("id", batch);
      if (!delErr) deleted += batch.length;
      else console.error("[people-dedupe] junk delete failed", delErr);
    }

    let merged = 0;
    for (const merge of plan.merges) {
      // Order matters: a LOSER row may already hold the exact canonical
      // spelling, so renaming the survivor before the losers are gone would
      // hit the raw-string unique constraint (23505) on every run and the
      // group would never converge. Fold the memory first (safe), then clear
      // the losers, and only then claim the canonical id.
      const { error: upErr } = await supabase
        .from("people")
        .update({
          ...merge.survivorPatch,
          facts: merge.survivorPatch.facts as unknown as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", merge.survivorId);
      if (upErr) {
        // Without the folded memory on the survivor, deleting the losers
        // would lose data — leave this group for the next run.
        console.error("[people-dedupe] survivor update failed", upErr);
        continue;
      }
      const { error: loserErr } = await supabase
        .from("people")
        .delete()
        .in("id", merge.loserIds);
      if (loserErr) {
        console.error("[people-dedupe] loser delete failed", loserErr);
        continue;
      }
      const { error: rnErr } = await supabase
        .from("people")
        .update({ wa_id: merge.canon, updated_at: new Date().toISOString() })
        .eq("id", merge.survivorId);
      // 23505: another isolate claimed the canonical id since the losers were
      // deleted — the survivor keeps its legacy spelling and the next run
      // merges the pair; the folded memory is already safe on this row.
      if (rnErr && rnErr.code !== "23505") {
        console.error("[people-dedupe] survivor rename failed", rnErr);
        continue;
      }
      // follow_ups reference people by loose wa_id string (no FK) — point
      // every old spelling at the canonical key.
      const { error: fuErr } = await supabase
        .from("follow_ups")
        .update({ person_wa_id: merge.canon })
        .in("person_wa_id", merge.allVariantWaIds);
      if (fuErr) console.error("[people-dedupe] follow_ups retarget failed", fuErr);
      merged += 1;
    }

    let renamed = 0;
    for (const rename of plan.renames) {
      const { error: rnErr } = await supabase
        .from("people")
        .update({ wa_id: rename.wa_id, updated_at: new Date().toISOString() })
        .eq("id", rename.id);
      if (!rnErr) renamed += 1;
      // 23505: a row with the canonical spelling appeared since we planned —
      // now it's a duplicate group, which the next run merges.
      else if (rnErr.code !== "23505") console.error("[people-dedupe] rename failed", rnErr);
    }

    // Always logged (even 0/0/0) — the decision row is both the visibility in
    // Activity and the throttle marker for the next run. AWAITED, not
    // fire-and-forget: on Cloudflare a pending promise left behind when the
    // response returns can be dropped, which would lose the marker and make
    // the dedupe re-run every sweep.
    const { error: markerErr } = await supabase.from("bot_decisions").insert({
      trigger: "scheduled",
      stage: "config",
      status: "ok",
      summary: `${DEDUPE_SUMMARY_PREFIX}: merged ${merged} duplicate group(s), renamed ${renamed} profile(s) to canonical ids, removed ${deleted} non-person row(s)`,
      data: {
        merged_groups: merged,
        renamed_profiles: renamed,
        deleted_rows: deleted,
      },
    });
    if (markerErr) console.error("[people-dedupe] marker insert failed", markerErr);
    return { ran: true, merged, renamed, deleted };
  } catch (e) {
    console.error("[people-dedupe] failed", e);
    return { ran: false, reason: String((e as Error)?.message ?? e) };
  }
}
