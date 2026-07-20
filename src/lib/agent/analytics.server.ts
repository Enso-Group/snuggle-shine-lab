// Analytics + self-improvement jobs, run from the every-minute sweeper with
// cheap date-based gating:
//  * daily rollup  — once per group per day, upserted idempotently,
//  * weekly memo   — once per group per week, written by the strong model
//    from the rolled-up numbers and post engagement, with structured
//    recommendations the posting engine feeds back into future drafts.
import { callLLM, parseJsonLoose } from "@/lib/llm.server";
import {
  aggregateDailyStats,
  israelDateKey,
  israelWeekStart,
  parseRecommendations,
  recommendationsPromptBlock,
  type StrategyRecommendations,
} from "./analytics";
import { loadAgentSettings } from "./context.server";
import { logDecision } from "./decisions.server";
import { listEnabledGroupProfiles, type GroupProfile } from "./groups.server";
import type { AgentDeps, AgentSettings } from "./types";
import type { Supa } from "./types";

export type AnalyticsRunResult = {
  rolledUp: string[];
  memos: string[];
};

export async function runAnalytics(deps: AgentDeps): Promise<AnalyticsRunResult> {
  const result: AnalyticsRunResult = { rolledUp: [], memos: [] };
  const settings = await loadAgentSettings(deps.supabase);
  if (!settings?.enabled) return result;

  const profiles = await listEnabledGroupProfiles(deps.supabase);
  for (const profile of profiles) {
    try {
      if (await rollupGroupDaily(deps.supabase, profile)) {
        result.rolledUp.push(profile.name ?? profile.chat_id);
      }
      if (await maybeWriteStrategyMemo(deps, settings, profile)) {
        result.memos.push(profile.name ?? profile.chat_id);
      }
    } catch (e) {
      console.warn("[analytics] group failed:", profile.chat_id, e);
    }
  }
  return result;
}

/** Latest memo recommendations for a group — consumed by the posting engine. */
export async function latestRecommendationsBlock(supabase: Supa, chatId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from("strategy_memos")
      .select("recommendations")
      .eq("group_chat_id", chatId)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return "";
    return recommendationsPromptBlock(parseRecommendations(data.recommendations));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Daily rollup
// ---------------------------------------------------------------------------
async function rollupGroupDaily(supabase: Supa, profile: GroupProfile): Promise<boolean> {
  const today = israelDateKey(new Date());
  const { data: last } = await supabase
    .from("group_daily_stats")
    .select("date")
    .eq("group_chat_id", profile.chat_id)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  // Roll up once per day (covering the previous ~3 days so late data heals).
  if (last?.date === today) return false;

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", profile.chat_id)
    .maybeSingle();
  if (!conv) return false;

  const since = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
  const { data: rows } = await supabase
    .from("messages")
    .select("direction, sender_id, created_at")
    .eq("conversation_id", conv.id)
    .gte("created_at", since)
    .limit(5000);
  const days = aggregateDailyStats(rows ?? []);

  for (const day of days) {
    // Replies earned by posts sent that day (from the engagement checks).
    const { data: posts } = await supabase
      .from("planned_posts")
      .select("engagement")
      .eq("group_chat_id", profile.chat_id)
      .eq("status", "sent")
      .gte("sent_at", `${day.date}T00:00:00Z`)
      .lte("sent_at", `${day.date}T23:59:59Z`);
    const postReplies = (posts ?? []).reduce(
      (sum, p) => sum + Number((p.engagement as { replies_24h?: number })?.replies_24h ?? 0),
      0,
    );

    // Membership changes that day.
    const { count: joined } = await supabase
      .from("group_members")
      .select("id", { count: "exact", head: true })
      .eq("group_chat_id", profile.chat_id)
      .gte("joined_at", `${day.date}T00:00:00Z`)
      .lte("joined_at", `${day.date}T23:59:59Z`);
    const { count: left } = await supabase
      .from("group_members")
      .select("id", { count: "exact", head: true })
      .eq("group_chat_id", profile.chat_id)
      .gte("left_at", `${day.date}T00:00:00Z`)
      .lte("left_at", `${day.date}T23:59:59Z`);

    await supabase.from("group_daily_stats").upsert(
      {
        group_chat_id: profile.chat_id,
        date: day.date,
        messages: day.messages,
        active_members: day.active_members,
        bot_posts: day.bot_posts,
        post_replies: postReplies,
        new_members: joined ?? 0,
        left_members: left ?? 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "group_chat_id,date" },
    );
  }
  return days.length > 0;
}

// ---------------------------------------------------------------------------
// Weekly strategy memo
// ---------------------------------------------------------------------------
async function maybeWriteStrategyMemo(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile,
): Promise<boolean> {
  const { supabase } = deps;
  const thisWeek = israelWeekStart(new Date());
  const { data: existing } = await supabase
    .from("strategy_memos")
    .select("id")
    .eq("group_chat_id", profile.chat_id)
    .eq("week_start", thisWeek)
    .maybeSingle();
  if (existing) return false;

  const { data: stats } = await supabase
    .from("group_daily_stats")
    .select("date, messages, active_members, bot_posts, post_replies, new_members, left_members")
    .eq("group_chat_id", profile.chat_id)
    .order("date", { ascending: false })
    .limit(28);
  // Not enough history to say anything useful yet.
  if (!stats || stats.length < 5) return false;

  const { data: posts } = await supabase
    .from("planned_posts")
    .select("pillar, body, sent_at, engagement")
    .eq("group_chat_id", profile.chat_id)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(20);

  const postLines = (posts ?? []).map((p) => {
    const replies = Number((p.engagement as { replies_24h?: number })?.replies_24h ?? 0);
    const hour = p.sent_at
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Jerusalem",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(p.sent_at))
      : "?";
    return `[${hour}${p.pillar ? ` / ${p.pillar}` : ""}] ${String(p.body ?? "").slice(0, 100)} → ${replies} תגובות`;
  });

  const statLines = stats
    .slice()
    .reverse()
    .map(
      (s) =>
        `${s.date}: ${s.messages} הודעות, ${s.active_members} פעילים, ${s.bot_posts} פוסטים שלנו (${s.post_replies} תגובות), +${s.new_members}/-${s.left_members} חברים`,
    );

  try {
    const res = await callLLM({
      role: "strong",
      source: "agent_strategy_memo",
      json: true,
      overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
      messages: [
        {
          role: "system",
          content: `אתה מנהל קהילות בכיר שכותב מזכר אסטרטגיה שבועי לעצמו על קבוצת וואטסאפ שהוא מנהל. החזר JSON בלבד:
{"memo": "מזכר של 4-8 משפטים בעברית: מה עבד, מה לא, מה משנים השבוע", "recommendations": {"best_times": ["HH:MM", ...], "pillar_ranking": ["עמוד תוכן מהכי מוצלח", ...], "notes": "הנחיה תמציתית לפוסטים הבאים"}}

הקשר: מטרת הקבוצה — ${profile.purpose ?? "לא הוגדרה"}. עמודי תוכן מוגדרים: ${profile.content_pillars.join(", ") || "אין"}. KPIs: ${profile.kpis ?? "לא הוגדרו"}.
בסס הכל על הנתונים בלבד; אל תמציא מספרים.`,
        },
        {
          role: "user",
          content: `נתונים יומיים (ישן→חדש):
${statLines.join("\n")}

ביצועי פוסטים אחרונים:
${postLines.join("\n") || "(אין פוסטים עדיין)"}`,
        },
      ],
    });
    const parsed = parseJsonLoose<{ memo?: string; recommendations?: unknown }>(res.content);
    const memo = String(parsed.memo ?? "").trim();
    if (!memo) return false;
    const recommendations: StrategyRecommendations = parseRecommendations(parsed.recommendations);

    const { error } = await supabase.from("strategy_memos").insert({
      group_chat_id: profile.chat_id,
      week_start: thisWeek,
      memo,
      recommendations,
    });
    if (error) {
      if (error.code !== "23505") console.warn("[analytics] memo insert failed:", error.message);
      return false;
    }
    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "insight",
      summary: `נכתב מזכר אסטרטגיה שבועי לקבוצה ${profile.name ?? profile.chat_id}`,
      data: { memo, recommendations: recommendations as unknown as Record<string, unknown> },
    });
    return true;
  } catch (e) {
    console.warn("[analytics] memo generation failed:", e);
    return false;
  }
}
