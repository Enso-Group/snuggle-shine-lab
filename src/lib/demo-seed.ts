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

export async function wipeAll(db: LooseDb): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const { table, column } of WIPE_PLAN) {
    try {
      const { count } = await db
        .from(table)
        .delete({ count: "exact" })
        .like(column, `${DEMO_MARKER_PREFIX}%`);
      if (count) removed[table] = count;
    } catch (e) {
      console.warn(`[demo] wipe of ${table} skipped:`, e);
    }
  }
  return removed;
}
