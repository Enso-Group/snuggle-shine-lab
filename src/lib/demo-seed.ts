// Pure demo-seed plumbing: the wipe plan and marker rules, testable without
// any server imports. The server functions live in demo-seed.functions.ts.

export const DEMO_MARKER_PREFIX = "demo-";

/** Tables that can hold demo rows, with the column carrying the marker.
 * Order matters: conversations go last so their messages cascade away. */
export const WIPE_PLAN: Array<{ table: string; column: string }> = [
  { table: "scheduled_approvals", column: "target_chat_id" },
  { table: "bot_decisions", column: "chat_id" },
  { table: "commands_log", column: "target_chat_id" },
  { table: "planned_posts", column: "group_chat_id" },
  { table: "moderation_actions", column: "group_chat_id" },
  { table: "group_insights", column: "group_chat_id" },
  { table: "group_daily_stats", column: "group_chat_id" },
  { table: "strategy_memos", column: "group_chat_id" },
  { table: "group_profiles", column: "chat_id" },
  { table: "follow_ups", column: "chat_id" },
  { table: "bot_jobs", column: "chat_id" },
  { table: "people", column: "wa_id" },
  { table: "conversations", column: "whapi_chat_id" },
];

/** Loose handle over the typed client — demo rows span many tables and some
 * columns (media) may predate their migration; runtime errors are handled. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseDb = { from(table: string): any };

/**
 * Presentation mode: while demo data is seeded, dashboard READ paths show
 * ONLY demo rows so no real contact name or number appears in a recording.
 * The BOT itself is unaffected — real messages keep being answered; they are
 * just hidden from the pages until the demo is wiped.
 * Stored in bot_settings.agent_config.demo_view (set by seed, cleared by
 * wipe); unknown agent_config keys are ignored by the pipeline.
 */
export async function isDemoViewOn(db: LooseDb): Promise<boolean> {
  try {
    const { data } = await db
      .from("bot_settings")
      .select("agent_config")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (data?.agent_config as { demo_view?: boolean } | null)?.demo_view === true;
  } catch {
    return false;
  }
}

/** Merge demo_view into agent_config without clobbering other knobs. */
export async function setDemoView(db: LooseDb, on: boolean): Promise<void> {
  const { data } = await db
    .from("bot_settings")
    .select("id, agent_config")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data?.id) return;
  const config = { ...((data.agent_config as Record<string, unknown>) ?? {}), demo_view: on };
  await db
    .from("bot_settings")
    .update({ agent_config: config, updated_at: new Date().toISOString() })
    .eq("id", data.id);
}

export type WipeResult = { removed: Record<string, number>; failed: Record<string, string> };

export async function wipeAll(db: LooseDb): Promise<WipeResult> {
  const removed: Record<string, number> = {};
  const failed: Record<string, string> = {};
  for (const { table, column } of WIPE_PLAN) {
    // supabase-js reports failures via the result object, not by throwing —
    // read `error` explicitly or a failed delete masquerades as "0 rows".
    const { count, error } = await db
      .from(table)
      .delete({ count: "exact" })
      .like(column, `${DEMO_MARKER_PREFIX}%`);
    if (error) {
      failed[table] = String(error.message ?? error);
      console.warn(`[demo] wipe of ${table} failed:`, error);
    } else if (count) {
      removed[table] = count;
    }
  }
  return { removed, failed };
}
