// Autonomous posting engine + research loop for managed groups.
//
// Every sweeper tick:
//  * due schedule slots become planned_posts rows (the partial unique index on
//    slot_key claims each occurrence exactly once across isolates),
//  * planned posts are generated (draft → self-review) with the group's
//    profile, recent activity, persisted insights and the knowledge base,
//    then sent — or queued for approval when the global gate is on,
//  * every ~6h per group the research loop refreshes insights: activity
//    stats, engagement of recent posts, and a topics read that can trigger
//    a reactive post when the profile allows it.
import { callLLM } from "@/lib/llm.server";
import type { Json } from "@/integrations/supabase/types";
import { logDecision } from "./decisions.server";
import { loadKnowledge } from "./kb.server";
import { groupPromptBlock, listEnabledGroupProfiles, type GroupProfile } from "./groups.server";
import { parseJsonLoose } from "@/lib/llm.server";
import { computeDueSlots } from "./posting-schedule";
import { buildHumanizeRules, buildDateContext } from "./prompts.server";
import { sanitizeParts } from "./stages.server";
import type { AgentDeps, AgentSettings } from "./types";
import { loadAgentSettings } from "./context.server";

const INSIGHTS_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_POSTS_PER_TICK = 2;
const REACTIVE_MIN_GAP_MS = 12 * 60 * 60 * 1000;

export type PostingRunResult = {
  planned: number;
  posted: Array<{ group: string; status: string }>;
  insightsRefreshed: string[];
};

export async function runGroupEngine(deps: AgentDeps): Promise<PostingRunResult> {
  const result: PostingRunResult = { planned: 0, posted: [], insightsRefreshed: [] };
  const settings = await loadAgentSettings(deps.supabase);
  if (!settings?.enabled) return result;

  await reconcileDecidedApprovals(deps);

  const profiles = await listEnabledGroupProfiles(deps.supabase);
  if (!profiles.length) return result;

  // 1) Claim due schedule slots.
  const now = new Date();
  for (const profile of profiles) {
    for (const due of computeDueSlots(profile.posting_schedule, now)) {
      const { error } = await deps.supabase.from("planned_posts").insert({
        group_chat_id: profile.chat_id,
        source: "schedule",
        slot_key: due.slotKey,
        pillar: due.slot.pillar ?? null,
        prompt: due.slot.prompt ?? null,
        scheduled_for: now.toISOString(),
      });
      if (!error) result.planned += 1;
      else if (error.code !== "23505") console.warn("[posting] slot claim failed:", error.message);
    }
  }

  // 2) Generate + send planned posts (oldest first, capped per tick).
  const { data: pending } = await deps.supabase
    .from("planned_posts")
    .select("id, group_chat_id, source, pillar, prompt")
    .eq("status", "planned")
    .order("created_at", { ascending: true })
    .limit(MAX_POSTS_PER_TICK);
  for (const post of pending ?? []) {
    const profile = profiles.find((p) => p.chat_id === post.group_chat_id);
    if (!profile) continue;
    const status = await generateAndSendPost(deps, settings, profile, post);
    result.posted.push({ group: profile.name ?? profile.chat_id, status });
  }

  // 3) Research loop.
  for (const profile of profiles) {
    const refreshed = await maybeRefreshInsights(deps, settings, profile);
    if (refreshed) result.insightsRefreshed.push(profile.name ?? profile.chat_id);
  }
  return result;
}

/**
 * Posts stuck in queued_approval whose approval was already decided — either
 * rows from before approvePending updated planned_posts, or a decide whose
 * post update failed mid-flight. Flip them to sent/cancelled so the dashboard
 * panels match reality. Matches by planned_post_id when the link column
 * exists, else by same group + body containment; an approval older than the
 * post can never be its approval, and posts with a still-pending approval are
 * left for the approve flow.
 */
async function reconcileDecidedApprovals(deps: AgentDeps): Promise<void> {
  const { data: queued } = await deps.supabase
    .from("planned_posts")
    .select("id, group_chat_id, body, created_at")
    .eq("status", "queued_approval");
  if (!queued?.length) return;

  const { data: approvals } = await deps.supabase
    .from("scheduled_approvals")
    .select("*")
    .eq("source", "group_post")
    .in("status", ["pending", "approved", "rejected"]);
  if (!approvals?.length) return;

  const matches = (
    a: {
      planned_post_id?: string | null;
      target_chat_id: string;
      body: string;
      created_at: string;
    },
    p: { id: string; group_chat_id: string; body: string | null; created_at: string },
  ) =>
    a.planned_post_id
      ? a.planned_post_id === p.id
      : a.target_chat_id === p.group_chat_id &&
        a.created_at >= p.created_at &&
        (p.body ?? "").includes(a.body);

  for (const post of queued) {
    if (approvals.some((a) => a.status === "pending" && matches(a, post))) continue;
    const decided = approvals
      .filter((a) => a.status !== "pending" && matches(a, post))
      .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))[0];
    if (!decided) continue;
    await deps.supabase
      .from("planned_posts")
      .update(
        decided.status === "approved"
          ? {
              status: "sent",
              sent_at: decided.decided_at ?? new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : { status: "cancelled", updated_at: new Date().toISOString() },
      )
      .eq("id", post.id)
      .eq("status", "queued_approval");
  }
}

async function recentGroupActivity(deps: AgentDeps, chatId: string, limit = 30): Promise<string> {
  const { data: conv } = await deps.supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", chatId)
    .maybeSingle();
  if (!conv) return "";
  const { data: msgs } = await deps.supabase
    .from("messages")
    .select("direction, sender_name, body, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (msgs ?? [])
    .reverse()
    .filter((m) => m.body)
    .map(
      (m) =>
        `${m.direction === "outbound" ? "אנחנו" : m.sender_name || "חבר"}: ${String(m.body).slice(0, 200)}`,
    )
    .join("\n");
}

async function latestInsights(deps: AgentDeps, chatId: string): Promise<string> {
  const { data } = await deps.supabase
    .from("group_insights")
    .select("kind, content")
    .eq("group_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(3);
  return (data ?? []).map((i) => `[${i.kind}] ${i.content}`).join("\n");
}

async function recentPostBodies(deps: AgentDeps, chatId: string): Promise<string[]> {
  const { data } = await deps.supabase
    .from("planned_posts")
    .select("body")
    .eq("group_chat_id", chatId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(5);
  return (data ?? []).map((p) => String(p.body ?? "")).filter(Boolean);
}

async function generateAndSendPost(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile,
  post: { id: string; source: string; pillar: string | null; prompt: string | null },
): Promise<string> {
  const { supabase } = deps;
  const overrides = { model_strong: settings.model_strong, model_fast: settings.model_fast };

  try {
    const { latestRecommendationsBlock } = await import("./analytics.server");
    const [activity, insights, pastPosts, kb, memoBlock] = await Promise.all([
      recentGroupActivity(deps, profile.chat_id),
      latestInsights(deps, profile.chat_id),
      recentPostBodies(deps, profile.chat_id),
      loadKnowledge(supabase, `${post.pillar ?? ""} ${post.prompt ?? ""} ${profile.purpose ?? ""}`),
      latestRecommendationsBlock(supabase, profile.chat_id),
    ]);

    // Draft.
    const draftSystem =
      (settings.system_prompt || "") +
      buildHumanizeRules() +
      buildDateContext() +
      groupPromptBlock(profile) +
      memoBlock +
      (kb.count ? `\n\nמאגר ידע מאומת (עובדות עסקיות מותרות רק מכאן):\n${kb.block}` : "") +
      `

משימה: כתוב פוסט אחד לקבוצה, בשפה ${profile.language}.
${post.pillar ? `- עמוד תוכן: ${post.pillar}` : ""}
${post.prompt ? `- הנחיה לפוסט: ${post.prompt}` : ""}
- מטרת הפוסט: להניע שיחה אמיתית בקבוצה, לא "תוכן שיווקי".
- אורך וואטסאפ טבעי: 2-5 משפטים. מותר אימוג'י אחד-שניים. בלי כותרות מודגשות מוגזמות.
- אל תחזור על פוסטים קודמים.

פורמט פלט (חובה): החזר JSON בלבד:
{"post": "טקסט הפוסט (או מחרוזת ריקה אם הכל בסקר)", "poll": {"question": "שאלת הסקר", "options": ["אפשרות", ...], "multi": false} או null}

חוקי סקר (קריטי):
- כלול poll רק אם ההנחיה לפוסט / הוראות המנהל מבקשות סקר או הצבעה. אחרת poll=null.
- סקר נשלח כסקר וואטסאפ אמיתי (לחיץ) — לעולם אל תכתוב את הסקר או את האפשרויות בתוך טקסט הפוסט, בלי 1️⃣2️⃣3️⃣ ובלי רשימות ממוספרות של אפשרויות.
- 2 עד 12 אפשרויות, קצרות וייחודיות, בשפת הקבוצה. multi=true רק אם הגיוני לבחור כמה תשובות.`;

    const draftUser = `פעילות אחרונה בקבוצה:
${activity || "(שקט בקבוצה)"}

תובנות שמורות:
${insights || "(אין עדיין)"}

פוסטים אחרונים שכבר פורסמו (אל תחזור עליהם):
${pastPosts.map((p, i) => `[${i + 1}] ${p.slice(0, 150)}`).join("\n") || "(אין)"}`;

    const draft = await callLLM({
      role: "strong",
      source: "agent_post_draft",
      overrides,
      messages: [
        { role: "system", content: draftSystem },
        { role: "user", content: draftUser },
      ],
    });

    // Parse the structured draft ({post, poll}); tolerate plain-text output.
    const { normalizePoll, pollCount, pollAsHistoryText } = await import("./poll");
    let final = "";
    let poll: import("./poll").PollSpec | null = null;
    try {
      const parsedDraft = parseJsonLoose<{ post?: unknown; poll?: unknown }>(draft.content);
      final = String(parsedDraft.post ?? "").trim();
      poll = normalizePoll(parsedDraft.poll);
    } catch {
      final = draft.content.trim();
    }

    // Self-review.
    let reviewNote = "";
    try {
      const review = await callLLM({
        role: "strong",
        source: "agent_post_review",
        json: true,
        overrides,
        messages: [
          {
            role: "system",
            content: `אתה עורך תוכן קפדן. בדוק את הפוסט והחזר JSON בלבד: {"ok": true/false, "post": "הגרסה הסופית של הטקסט", "poll": {"question": "...", "options": [...], "multi": false} או null, "note": "what was fixed, in English — or empty"}.
בדוק: מתאים למטרת הקבוצה ולטון (${profile.tone ?? "מקצועי-חם"}), בשפה ${profile.language}, לא חוזר על פוסטים קודמים, בלי עובדות עסקיות שאינן במאגר הידע, בלי רמז לבוט/AI, אורך וואטסאפ סביר.
כלל סקרים: אם יש poll — הטקסט אסור שיכיל את שאלת הסקר או את האפשרויות (בלי 1️⃣2️⃣3️⃣ ובלי רשימות אפשרויות בטקסט); הסקר נשלח בנפרד כסקר לחיץ. אם הטקסט מכיל סקר-בטקסט — העבר אותו לשדה poll ונקה את הטקסט. שמור על ה-poll אם הוא תקין. תקן בעצמך אם צריך.`,
          },
          {
            role: "user",
            content: `הפוסט:\n"""${final}"""\n\nסקר מצורף:\n${poll ? JSON.stringify(poll) : "(אין)"}\n\nפוסטים קודמים:\n${pastPosts.map((p) => p.slice(0, 120)).join("\n") || "(אין)"}${kb.count ? `\n\nמאגר הידע:\n${kb.block}` : ""}`,
          },
        ],
      });
      const parsed = parseJsonLoose<{
        ok?: boolean;
        post?: unknown;
        poll?: unknown;
        note?: string;
      }>(review.content);
      if (parsed.post !== undefined) final = String(parsed.post ?? "").trim();
      if (parsed.poll !== undefined) poll = normalizePoll(parsed.poll) ?? poll;
      reviewNote = String(parsed.note ?? "");
    } catch (e) {
      console.warn("[posting] review failed, using draft:", e);
    }
    final = sanitizeParts([final]).parts[0] ?? "";
    if (!final && !poll) throw new Error("post generation returned neither text nor poll");
    const bodyForRecord = [final, poll ? pollAsHistoryText(poll) : ""].filter(Boolean).join("\n\n");

    // Approval gate.
    if (settings.require_approval_all) {
      const { data: adminRole } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin")
        .limit(1)
        .maybeSingle();
      if (!adminRole?.user_id) throw new Error("no approval owner");
      const approvalRow = {
        user_id: adminRole.user_id,
        target_chat_id: profile.chat_id,
        target_name: profile.name ?? profile.chat_id,
        body: final || poll!.question,
        source: "group_post",
        status: "pending",
      };
      const { error: apprErr } = await supabase
        .from("scheduled_approvals")
        .insert({ ...approvalRow, poll: poll as unknown as Json, planned_post_id: post.id });
      if (apprErr) {
        // Pre-migration fallback (poll/planned_post_id column absent): embed
        // the poll as text so nothing is lost, and flag it in the log.
        console.warn("[posting] approval insert with poll failed, falling back:", apprErr.message);
        await supabase.from("scheduled_approvals").insert({
          ...approvalRow,
          body: bodyForRecord,
        });
      }
      await supabase
        .from("planned_posts")
        .update({
          body: bodyForRecord,
          reasoning: reviewNote,
          status: "queued_approval",
          updated_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      return "queued_approval";
    }

    // Send: text first (when present), then the native tappable poll.
    let textSendId: string | null = null;
    if (final) {
      const sendRes = (await deps.whapi.sendText(profile.chat_id, final)) as {
        message?: { id?: string };
      };
      textSendId = sendRes?.message?.id ?? null;
    }
    let pollSendId: string | null = null;
    if (poll) {
      const pollRes = (await deps.whapi.sendPoll(
        profile.chat_id,
        poll.question,
        poll.options,
        pollCount(poll),
      )) as { message?: { id?: string } };
      pollSendId = pollRes?.message?.id ?? null;
    }

    await supabase
      .from("planned_posts")
      .update({
        body: bodyForRecord,
        reasoning: reviewNote,
        status: "sent",
        sent_at: new Date().toISOString(),
        whapi_message_id: textSendId ?? pollSendId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id);

    // Mirror into the conversation so the chat view shows it.
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("whapi_chat_id", profile.chat_id)
      .maybeSingle();
    if (conv) {
      if (final) {
        await supabase.from("messages").insert({
          conversation_id: conv.id,
          whapi_message_id: textSendId,
          direction: "outbound",
          sender_name: settings.bot_name || "Bot",
          sender_id: "bot",
          body: final,
        });
      }
      if (poll) {
        await supabase.from("messages").insert({
          conversation_id: conv.id,
          whapi_message_id: pollSendId,
          direction: "outbound",
          sender_name: settings.bot_name || "Bot",
          sender_id: "bot",
          body: pollAsHistoryText(poll),
        });
      }
    }

    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "post",
      summary: `Published a ${post.source} post${post.pillar ? ` (${post.pillar})` : ""}${poll ? " with a native poll" : ""} in ${profile.name ?? profile.chat_id}`,
      data: {
        post: final,
        poll: poll as unknown as Record<string, unknown>,
        review_note: reviewNote,
        planned_post_id: post.id,
      },
    });
    return "sent";
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await supabase
      .from("planned_posts")
      .update({
        status: "failed",
        reasoning: msg.slice(0, 300),
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id);
    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "error",
      status: "error",
      summary: `Post publishing failed: ${msg.slice(0, 150)}`,
    });
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Research loop
// ---------------------------------------------------------------------------
async function maybeRefreshInsights(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile,
): Promise<boolean> {
  const { supabase } = deps;
  const { data: last } = await supabase
    .from("group_insights")
    .select("created_at")
    .eq("group_chat_id", profile.chat_id)
    .eq("kind", "activity")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < INSIGHTS_EVERY_MS) return false;

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", profile.chat_id)
    .maybeSingle();
  if (!conv) return false;

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: weekMsgs } = await supabase
    .from("messages")
    .select("sender_id, created_at, direction")
    .eq("conversation_id", conv.id)
    .gte("created_at", weekAgo)
    .limit(2000);
  const inbound = (weekMsgs ?? []).filter((m) => m.direction === "inbound");
  const perDay = Math.round((inbound.length / 7) * 10) / 10;
  const activeMembers = new Set(inbound.map((m) => m.sender_id)).size;

  await supabase.from("group_insights").insert({
    group_chat_id: profile.chat_id,
    kind: "activity",
    content: `Last 7 days: ${inbound.length} messages (${perDay}/day average) from ${activeMembers} active members.`,
    data: { messages_7d: inbound.length, per_day: perDay, active_members: activeMembers },
  });

  // Engagement for posts sent in the last 48h: replies within 24h of the post.
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: recentPosts } = await supabase
    .from("planned_posts")
    .select("id, sent_at, body")
    .eq("group_chat_id", profile.chat_id)
    .eq("status", "sent")
    .gte("sent_at", twoDaysAgo);
  for (const p of recentPosts ?? []) {
    if (!p.sent_at) continue;
    const until = new Date(new Date(p.sent_at).getTime() + 24 * 3600_000).toISOString();
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id)
      .eq("direction", "inbound")
      .gt("created_at", p.sent_at)
      .lte("created_at", until);
    await supabase
      .from("planned_posts")
      .update({
        engagement: { replies_24h: count ?? 0, checked_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
  }

  // Topics read (fast model) — also the reactive-post trigger.
  if (inbound.length >= 10) {
    const activity = await recentGroupActivity(deps, profile.chat_id, 50);
    try {
      const res = await callLLM({
        role: "fast",
        source: "agent_insights",
        json: true,
        overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
        messages: [
          {
            role: "system",
            content: `נתח את השיחות האחרונות בקבוצה והחזר JSON בלבד:
{"topics": "one-two sentences IN ENGLISH: what members are discussing and what interests them", "hot_topic": "a hot topic that justifies a post right now (in English), or null"}`,
          },
          { role: "user", content: activity.slice(0, 6000) },
        ],
      });
      const parsed = parseJsonLoose<{ topics?: string; hot_topic?: string | null }>(res.content);
      if (parsed.topics) {
        await supabase.from("group_insights").insert({
          group_chat_id: profile.chat_id,
          kind: "topics",
          content: String(parsed.topics),
          data: { hot_topic: parsed.hot_topic ?? null },
        });
      }
      // Reactive post: hot topic + profile allows + no recent post.
      if (parsed.hot_topic && profile.allow_reactive_posts) {
        const { data: lastPost } = await supabase
          .from("planned_posts")
          .select("sent_at")
          .eq("group_chat_id", profile.chat_id)
          .eq("status", "sent")
          .order("sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastSent = lastPost?.sent_at ? new Date(lastPost.sent_at).getTime() : 0;
        if (Date.now() - lastSent > REACTIVE_MIN_GAP_MS) {
          await supabase.from("planned_posts").insert({
            group_chat_id: profile.chat_id,
            source: "reactive",
            prompt: `תגובה לנושא חם שעולה עכשיו בקבוצה: ${parsed.hot_topic}. הצטרף לשיחה בצורה שמוסיפה ערך.`,
          });
          logDecision(supabase, {
            chat_id: profile.chat_id,
            trigger: "scheduled",
            stage: "insight",
            summary: `Hot topic detected ("${parsed.hot_topic}") — reactive post planned`,
          });
        }
      }
    } catch (e) {
      console.warn("[posting] topics read failed:", e);
    }
  }

  logDecision(supabase, {
    chat_id: profile.chat_id,
    trigger: "scheduled",
    stage: "insight",
    summary: `Insights refreshed: ${perDay} messages/day, ${activeMembers} active members`,
  });
  return true;
}
