// Activity feed — everything the bot did, in one stream. Merges:
//  * bot_decisions grouped by job (one entry per handled message, with the
//    full stage trace as its expandable reasoning),
//  * standalone decisions (posts, moderation, welcomes, follow-ups, insights,
//    reply-gate silences),
//  * new contacts (people created),
//  * system alerts (commands_log status='alert').
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import type { Json } from "@/integrations/supabase/types";
import { z } from "zod";

// Single source of truth for every kind an entry can carry. The zod filter
// enum below and the Activity page's chips are both derived from this list, so
// adding a kind here automatically makes it filterable end-to-end.
export const ACTIVITY_KINDS = [
  "reply",
  "approval",
  "handled",
  "gate",
  "post",
  "moderation",
  "welcome",
  "follow_up",
  "insight",
  "config",
  "new_contact",
  "alert",
  "error",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityStage = {
  stage: string;
  status: string;
  summary: string | null;
  data: Json;
  duration_ms: number | null;
  created_at: string;
};

export type ActivityEntry = {
  id: string;
  ts: string;
  kind: ActivityKind;
  chat_id: string | null;
  chat_name: string | null;
  title: string;
  stages: ActivityStage[];
};

export type ActivityResult = {
  entries: ActivityEntry[];
  counts: Record<string, number>;
};

const RANGES_H: Record<string, number> = { day: 24, week: 24 * 7, month: 24 * 30 };

function standaloneKind(stage: string, status: string): ActivityKind {
  if (status === "error" || stage === "error") return "error";
  switch (stage) {
    case "reply_gate":
      return "gate";
    case "post":
      return "post";
    case "moderation":
      return "moderation";
    case "welcome":
      return "welcome";
    case "follow_up":
      return "follow_up";
    case "insight":
      return "insight";
    case "config":
      return "config";
    default:
      return "handled";
  }
}

export const listActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        range: z.enum(["day", "week", "month"]).default("day"),
        // Derived from ACTIVITY_KINDS so the filter enum can never drift from
        // the kinds the counts produce (a missing value used to make the parse
        // throw and the page render "All quiet" under a non-zero count).
        kind: z.enum(["all", ...ACTIVITY_KINDS] as const).default("all"),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }): Promise<ActivityResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getChannelScope } = await import("@/lib/agent/channel.server");
    // Disconnected → no activity at all.
    const scope = await getChannelScope(supabaseAdmin);
    if (scope.mode === "disconnected") return { entries: [], counts: {} };
    // Strict per-account scoping once the isolation migration is in. Fresh
    // rows are stamped at insert; stragglers are adopted by the minutely
    // sweeper, so at worst an entry appears with sub-minute delay.
    const scoped = scope.mode === "scoped";
    const phone = scope.phone;
    const since = new Date(Date.now() - RANGES_H[data.range] * 3600_000).toISOString();
    // Presentation mode: while demo data is seeded, the stream shows demo
    // entries only — no real chat id or contact appears in a recording.
    const { isDemoViewOn } = await import("./demo-seed");
    const demoView = await isDemoViewOn(supabaseAdmin as never);

    let peopleQuery = supabaseAdmin
      .from("people")
      .select("id, wa_id, display_name, funnel_stage, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100);
    if (demoView) peopleQuery = peopleQuery.like("wa_id", "demo-%");
    else if (scoped) peopleQuery = peopleQuery.eq("channel_phone", phone);

    let decisionsQuery = supabaseAdmin
      .from("bot_decisions")
      .select("id, job_id, chat_id, trigger, stage, status, summary, data, duration_ms, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(600);
    if (demoView) decisionsQuery = decisionsQuery.like("chat_id", "demo-%");
    else if (scoped) decisionsQuery = decisionsQuery.eq("channel_phone", phone);

    let alertsQuery = supabaseAdmin
      .from("commands_log")
      .select("id, prompt, result, created_at")
      .eq("status", "alert")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);
    if (demoView) alertsQuery = alertsQuery.like("target_chat_id", "demo-%");
    else if (scoped) alertsQuery = alertsQuery.eq("channel_phone", phone);

    const [decisionsRes, peopleRes, alertsRes] = await Promise.all([
      decisionsQuery,
      peopleQuery,
      alertsQuery,
    ]);

    const decisions = decisionsRes.data ?? [];
    const entries: ActivityEntry[] = [];

    // Group decisions that belong to one job into a single entry.
    const byJob = new Map<string, typeof decisions>();
    for (const d of decisions) {
      if (!d.job_id) continue;
      const list = byJob.get(d.job_id) ?? [];
      list.push(d);
      byJob.set(d.job_id, list);
    }
    for (const [jobId, rows] of byJob) {
      const asc = rows.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
      const stages = new Set(asc.map((r) => r.stage));
      const hasError = asc.some((r) => r.status === "error");
      // The human's approve/reject is APPENDED to the job trace (approvePending
      // / rejectPending), so an entry reflects the CURRENT state: approved →
      // reply, rejected → handled — never frozen at "awaiting approval".
      const rejected = asc.find(
        (r) => (r.data as { approval_decision?: string } | null)?.approval_decision === "rejected",
      );
      const kind: ActivityKind = hasError
        ? "error"
        : stages.has("deliver")
          ? "reply"
          : rejected
            ? "handled"
            : stages.has("queued_approval")
              ? "approval"
              : "handled";
      const received = asc.find((r) => r.stage === "received");
      // Title preference mirrors state: the sent reply wins over the parked
      // draft, a rejection wins over "awaiting approval".
      const deliverRow = asc.find((r) => r.stage === "deliver");
      const queuedRow = asc.find((r) => r.stage === "queued_approval");
      entries.push({
        id: `job-${jobId}`,
        ts: asc[asc.length - 1].created_at,
        kind,
        chat_id: asc[0].chat_id,
        chat_name: null,
        title:
          deliverRow?.summary ??
          rejected?.summary ??
          queuedRow?.summary ??
          received?.summary ??
          asc[asc.length - 1].summary ??
          "Message handled",
        stages: asc.map((r) => ({
          stage: r.stage,
          status: r.status,
          summary: r.summary,
          data: r.data,
          duration_ms: r.duration_ms,
          created_at: r.created_at,
        })),
      });
    }

    // Standalone decisions (no job): one entry each.
    for (const d of decisions) {
      if (d.job_id) continue;
      entries.push({
        id: `dec-${d.id}`,
        ts: d.created_at,
        kind: standaloneKind(d.stage, d.status),
        chat_id: d.chat_id,
        chat_name: null,
        title: d.summary ?? d.stage,
        stages: [
          {
            stage: d.stage,
            status: d.status,
            summary: d.summary,
            data: d.data,
            duration_ms: d.duration_ms,
            created_at: d.created_at,
          },
        ],
      });
    }

    // New contacts.
    for (const p of peopleRes.data ?? []) {
      entries.push({
        id: `person-${p.id}`,
        ts: p.created_at,
        kind: "new_contact",
        chat_id: p.wa_id,
        chat_name: p.display_name,
        title: `New contact: ${p.display_name ?? p.wa_id}`,
        stages: [],
      });
    }

    // System alerts.
    for (const a of alertsRes.data ?? []) {
      entries.push({
        id: `alert-${a.id}`,
        ts: a.created_at,
        kind: "alert",
        chat_id: null,
        chat_name: null,
        title: String(a.prompt ?? "System alert").replace(/^\[ALERT\]\s*/, ""),
        stages: a.result
          ? [
              {
                stage: "error",
                status: "error",
                summary: String(a.result).slice(0, 500),
                data: {},
                duration_ms: null,
                created_at: a.created_at,
              },
            ]
          : [],
      });
    }

    entries.sort((a, b) => b.ts.localeCompare(a.ts));

    // Counts BEFORE kind filtering, so the filter chips show real totals.
    const counts: Record<string, number> = {};
    for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

    const filtered = data.kind === "all" ? entries : entries.filter((e) => e.kind === data.kind);

    // Resolve chat names in one query.
    const chatIds = [
      ...new Set(filtered.map((e) => e.chat_id).filter((c): c is string => !!c)),
    ].slice(0, 200);
    if (chatIds.length) {
      const { data: convs } = await supabaseAdmin
        .from("conversations")
        .select("whapi_chat_id, name")
        .in("whapi_chat_id", chatIds);
      const names = new Map((convs ?? []).map((c) => [c.whapi_chat_id, c.name]));
      for (const e of filtered) {
        if (e.chat_id && !e.chat_name) e.chat_name = names.get(e.chat_id) ?? null;
      }
    }

    return { entries: filtered.slice(0, 300), counts };
  });
