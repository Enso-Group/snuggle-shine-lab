// Management mode: the tool-loop agent behind admin DMs. When a message
// arrives from a phone on the WhatsApp-admin list (agent_config.wa_admins),
// the inbound handler routes it HERE instead of the persona pipeline — the
// admin talks to the operations copilot, in natural language, with the
// dashboard's own powers: group steering, posts, approvals, settings, status
// and research.
//
// Security invariants (see wa-admins.ts for the recognition rules):
//  * The admin is RE-verified at processing time — removing a phone from the
//    list kills queued jobs too, not just future ones.
//  * Every executed action is logged to Activity with the admin's identity.
//  * There is deliberately NO tool to edit the admin list itself — that stays
//    a dashboard-only power (a compromised admin phone must not be able to
//    mint more admins).
//  * Replies go straight through Whapi (management channel — no persona
//    pacing/anti-ban), but are mirrored into the conversation history.
import type { Json } from "@/integrations/supabase/types";
import type { LLMMessage, LLMToolDef } from "@/lib/llm.server";
import { logDecision } from "./decisions.server";
import { findWaAdmin, type WaAdmin } from "./wa-admins";
import { supersedeJobsByIds } from "./queue.server";
import type { AgentDeps, AgentSettings, BotJob, PipelineOutcome, Supa } from "./types";

export const ADMIN_COMMAND_JOB_KIND = "admin_command";

// The whole job must fit the platform's ~60s request wall. LLM steps stop
// past this elapsed budget and the agent answers with what it has; the send
// itself needs the remaining headroom.
const LOOP_WALL_BUDGET_MS = 42_000;
const MAX_LLM_STEPS = 6;
const HISTORY_LIMIT = 16;

export async function enqueueAdminCommand(
  supabase: Supa,
  args: {
    chatId: string;
    conversationId: string;
    adminLabel: string;
    payload: {
      whapi_message_id: string;
      body: string;
      sender_id: string;
      sender_name: string;
      ts: number;
    };
  },
): Promise<string | null> {
  // Burst consolidation, like inbound replies: a newer admin message absorbs
  // older not-yet-started commands — the loop reads the full recent history,
  // so nothing is lost and the admin gets one coherent answer.
  await supabase
    .from("bot_jobs")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("chat_id", args.chatId)
    .eq("kind", ADMIN_COMMAND_JOB_KIND)
    .eq("status", "pending");

  const { data, error } = await supabase
    .from("bot_jobs")
    .insert({
      kind: ADMIN_COMMAND_JOB_KIND,
      chat_id: args.chatId,
      conversation_id: args.conversationId,
      payload: { ...args.payload, is_group: false, admin_label: args.adminLabel },
      run_after: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    console.error("[admin] enqueue failed", error);
    return null;
  }
  return data?.id ?? null;
}

export async function processAdminCommandJob(
  deps: AgentDeps,
  job: BotJob,
): Promise<PipelineOutcome> {
  const { supabase } = deps;
  const startedAt = Date.now();

  // Re-verify against the CURRENT list — the authorization check of record.
  const { loadWaAdmins } = await import("./wa-admins.server");
  const admins = await loadWaAdmins(supabase);
  const admin = findWaAdmin(admins, job.chat_id);
  if (!admin) {
    logDecision(supabase, {
      job_id: job.id,
      conversation_id: job.conversation_id,
      chat_id: job.chat_id,
      trigger: deps.trigger,
      stage: "skipped",
      status: "skip",
      summary: "Admin command dropped — the phone is no longer on the WhatsApp-admin list",
    });
    return { action: "skipped", reason: "not an admin" };
  }

  // Exactly-once guard for side-effectful commands: a retry after a wall-kill
  // must NOT replay the tool loop (an approve that sent before dying would
  // send twice). The marker is CAS'd on the job row before any tool runs.
  const p = job.payload as BotJob["payload"] & { admin_started?: boolean; admin_label?: string };
  if (p.admin_started) {
    const line =
      "⚠️ הפעולה הקודמת נקטעה באמצע. תבדוק בעמוד Activity מה בוצע בפועל, ואם צריך — תבקש שוב.";
    await sendAdminReply(deps, job, admin, line, []);
    return { action: "replied", parts: [line] };
  }
  const { data: cas } = await supabase
    .from("bot_jobs")
    .update({ payload: { ...p, admin_started: true } as unknown as Json })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select("id");
  if (!cas?.length) return { action: "skipped", reason: "lost admin job claim" };

  const { data: settingsRow } = await supabase
    .from("bot_settings")
    .select("id, enabled, bot_name, require_approval_all, model_strong, model_fast, agent_config")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // Conversation history (both directions) gives the loop its chat memory —
  // follow-ups like "approve the second one" resolve against what the bot
  // just listed.
  const { data: historyRows } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("conversation_id", job.conversation_id ?? "")
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history: LLMMessage[] = (historyRows ?? [])
    .reverse()
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: String(m.body ?? "").slice(0, 2000),
    }))
    .filter((m) => m.content);
  if (!history.some((m) => m.role === "user" && m.content === p.body)) {
    history.push({ role: "user", content: p.body });
  }

  const executed: Array<{ tool: string; summary: string }> = [];
  const logAction = (tool: string, summary: string, data?: Record<string, unknown>) => {
    executed.push({ tool, summary });
    logDecision(supabase, {
      job_id: job.id,
      conversation_id: job.conversation_id,
      chat_id: job.chat_id,
      trigger: deps.trigger,
      stage: "config",
      summary: `WhatsApp admin ${admin.label}: ${summary}`,
      data: { ...data, admin_mode: true, admin_phone: admin.phone, tool },
    });
  };

  const tools = buildTools(supabase, deps, admin, logAction);

  const system = `You are the operations copilot of an autonomous WhatsApp community-manager agent, talking over WhatsApp with ${admin.label} — a VERIFIED administrator (management mode). You are NOT the public persona here: be a concise, honest ops assistant.

You can inspect and OPERATE the whole system through your tools: system status and stats, the managed groups (status, profile changes, planned posts, AI images), the approval queue (list/approve/reject — approving SENDS the message for real), global settings (bot on/off, approval-all mode), recent activity, and web research.

Rules:
- Ground every claim in tool data — never invent numbers or statuses.
- Before changing a group or deciding an approval, load its current state first (get_group_status / list_pending_approvals).
- Destructive or irreversible asks (approve = a real send, reject, disabling the bot) need an unambiguous request; if the reference is ambiguous ("the post" when three are pending), ask ONE short clarifying question instead of guessing. Do not re-ask about an action the admin just explicitly requested.
- Approvals are referenced by the short id you list (first 8 characters).
- Group-facing text you write into profiles/posts follows the group's language; your replies to the admin are in the admin's own language (Hebrew if they write Hebrew).
- Keep replies short, WhatsApp-style: a few lines, no markdown headers. Confirm exactly what you did, field by field.
- If a tool errors, say so plainly and suggest the dashboard as fallback.`;

  const messages: LLMMessage[] = [{ role: "system", content: system }, ...history];
  const { callLLM } = await import("@/lib/llm.server");

  let reply = "";
  for (let step = 0; step < MAX_LLM_STEPS; step++) {
    const remaining = LOOP_WALL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 6_000) {
      reply =
        "התחלתי לטפל בזה אבל נגמר לי הזמן בסבב הזה. מה שכבר בוצע רשום ב-Activity — תשלח שוב את מה שנשאר.";
      break;
    }
    const res = await callLLM({
      role: "strong",
      source: "admin_command",
      tools: tools.defs,
      messages,
      timeoutMs: Math.min(20_000, remaining),
      budgetMs: remaining,
      overrides: {
        model_strong: settingsRow?.model_strong ?? null,
        model_fast: settingsRow?.model_fast ?? null,
      },
    });
    if (!res.toolCalls.length) {
      reply = res.content.trim();
      break;
    }
    messages.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* tolerate malformed args */
      }
      let result = "";
      try {
        result = await tools.run(tc.function.name, args);
      } catch (e) {
        result = JSON.stringify({ error: String((e as Error)?.message ?? e) });
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 12_000) });
    }
  }
  if (!reply) {
    reply = executed.length
      ? `ביצעתי: ${executed.map((a) => a.summary).join("; ")}`
      : "לא הצלחתי להשלים את זה הפעם — תנסה לנסח שוב או דרך הדשבורד.";
  }

  await sendAdminReply(deps, job, admin, reply, executed);
  return { action: "replied", parts: [reply] };
}

async function sendAdminReply(
  deps: AgentDeps,
  job: BotJob,
  admin: WaAdmin,
  text: string,
  executed: Array<{ tool: string; summary: string }>,
): Promise<void> {
  const body = text.slice(0, 3500);
  const sendRes = await deps.whapi.sendText(job.chat_id, body);
  const whapiId = (sendRes as { message?: { id?: string } })?.message?.id ?? null;
  if (job.conversation_id) {
    await deps.supabase.from("messages").insert({
      conversation_id: job.conversation_id,
      whapi_message_id: whapiId,
      direction: "outbound",
      sender_name: "Bot",
      sender_id: "bot",
      body,
      raw: sendRes as Json,
    });
  }
  logDecision(deps.supabase, {
    job_id: job.id,
    conversation_id: job.conversation_id,
    chat_id: job.chat_id,
    trigger: deps.trigger,
    stage: "deliver",
    summary: `Management-mode reply to WhatsApp admin ${admin.label}${
      executed.length ? ` (${executed.length} actions executed)` : ""
    }`,
    data: {
      admin_mode: true,
      admin_phone: admin.phone,
      parts: [body],
      whapi_ids: [whapiId],
      actions: executed as unknown as Json,
    },
  });
}

type ToolRunner = {
  defs: LLMToolDef[];
  run(name: string, args: Record<string, unknown>): Promise<string>;
};

function buildTools(
  supabase: Supa,
  deps: AgentDeps,
  admin: WaAdmin,
  logAction: (tool: string, summary: string, data?: Record<string, unknown>) => void,
): ToolRunner {
  const defs: LLMToolDef[] = [
    {
      type: "function",
      function: {
        name: "get_system_status",
        description:
          "Overall system snapshot: bot enabled/approval mode, WhatsApp connection, pending approvals count, queued jobs, today's posts/replies, errors in the last 24h.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "list_groups",
        description: "All managed group profiles: name, chat id, enabled, approval override.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "get_group_status",
        description:
          "One group's profile, 7-day stats, latest strategy memo, recent posts and moderation. `group` is a group name or chat id (fragment ok).",
        parameters: {
          type: "object",
          properties: { group: { type: "string" } },
          required: ["group"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_group_profile",
        description:
          "Apply changes to a group's management profile. Pass ONLY the fields to change. Allowed fields: enabled, instructions, purpose, audience, tone, language, content_pillars (string[]), posting_schedule ([{day:0-6|null,time:'HH:MM',pillar?,prompt?}]), rules (string[]), forbidden_topics (string[]), moderation ({enabled,delete_violations,warn_limit,remove_limit}), welcome ({enabled,hint}), reply_enabled (MASTER reply switch — false means the bot never replies in this group), reply_when_mentioned, reply_to_questions, allow_reactive_posts, require_approval (per-group approval toggle — overrides the global setting), escalation_rules, kpis.",
        parameters: {
          type: "object",
          properties: {
            group: { type: "string" },
            patch: { type: "object", description: "Partial profile object" },
          },
          required: ["group", "patch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "plan_post",
        description:
          "Queue a one-off campaign post for a group. The engine drafts and publishes within ~1 minute (or routes to Approvals when approval mode is on). For a poll, say so explicitly in the prompt with the question and options. For an image, call generate_post_image right after.",
        parameters: {
          type: "object",
          properties: {
            group: { type: "string" },
            prompt: { type: "string", description: "What the post should be about / achieve" },
            pillar: { type: "string" },
          },
          required: ["group", "prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_post_image",
        description:
          "Generate an AI image and attach it to the group's most recent unsent post. Takes up to ~30s — call it only when the admin asked for an image.",
        parameters: {
          type: "object",
          properties: {
            group: { type: "string" },
            description: { type: "string", description: "What the image should show (optional)" },
          },
          required: ["group"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_pending_approvals",
        description:
          "Everything waiting for human approval, newest first, with the short id used by approve_pending/reject_pending.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "approve_pending",
        description:
          "Approve a pending item by its short id — this SENDS it to WhatsApp for real. Optionally pass edited_body to send corrected text.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short id (first 8 chars) or full uuid" },
            edited_body: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reject_pending",
        description:
          "Reject a pending item by its short id — nothing is sent, linked post cancelled.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_bot_settings",
        description:
          "Change global settings: enabled (master kill switch for the whole bot) and/or require_approval_all (every outgoing message waits for human approval).",
        parameters: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            require_approval_all: { type: "boolean" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_recent_activity",
        description: "Recent bot activity summaries and alerts (default: last 6 hours).",
        parameters: {
          type: "object",
          properties: { hours: { type: "number" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_research",
        description:
          "Live web search (Tavily) for questions that need fresh outside information. Returns sources AND related image URLs; cite the URLs you use. To actually attach a found image to a post, call attach_web_media.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "attach_web_media",
        description:
          "Search the web (Tavily images + X media) for a REAL photo/video/PDF matching the query, download and validate it, and attach it to the group's most recent unsent post — the post then goes out as media with the text as caption, with the source link appended. Use when the admin wants a real image from the web rather than an AI-generated one. Honest failure: reports when nothing usable was found.",
        parameters: {
          type: "object",
          properties: {
            group: { type: "string" },
            query: { type: "string", description: "What to search for" },
          },
          required: ["group", "query"],
        },
      },
    },
  ];

  /** Resolve a human group reference (name fragment or chat id) to a profile. */
  async function resolveGroup(
    ref: string,
  ): Promise<{ chat_id: string; name: string | null } | { error: string }> {
    const q = String(ref ?? "").trim();
    if (!q) return { error: "empty group reference" };
    const { data: profiles } = await supabase.from("group_profiles").select("chat_id, name");
    const all = profiles ?? [];
    const exact = all.find(
      (g) => g.chat_id === q || (g.name ?? "").toLowerCase() === q.toLowerCase(),
    );
    if (exact) return exact;
    const matches = all.filter(
      (g) => g.chat_id.includes(q) || (g.name ?? "").toLowerCase().includes(q.toLowerCase()),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      return { error: `no managed group matches "${q}" — use list_groups` };
    }
    return {
      error: `ambiguous — matches: ${matches.map((m) => m.name ?? m.chat_id).join(", ")}`,
    };
  }

  /** Resolve a short approval id (8+ chars) to the full pending row id. */
  async function resolveApprovalId(ref: string): Promise<string | { error: string }> {
    const q = String(ref ?? "")
      .trim()
      .toLowerCase();
    if (q.length < 6) return { error: "id too short — use at least the 8 leading characters" };
    const { data: pending } = await supabase
      .from("scheduled_approvals")
      .select("id")
      .eq("status", "pending");
    const matches = (pending ?? []).filter((r) => r.id.toLowerCase().startsWith(q));
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) return { error: `no pending approval starts with "${q}"` };
    return { error: `ambiguous id "${q}" — matches ${matches.length} pending items` };
  }

  async function run(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "get_system_status": {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const [settings, approvals, jobs, postsToday, errors24h, groups] = await Promise.all([
          supabase
            .from("bot_settings")
            .select("enabled, bot_name, require_approval_all")
            .limit(1)
            .maybeSingle(),
          supabase
            .from("scheduled_approvals")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending"),
          supabase
            .from("bot_jobs")
            .select("id", { count: "exact", head: true })
            .in("status", ["pending", "processing"]),
          supabase
            .from("planned_posts")
            .select("id", { count: "exact", head: true })
            .eq("status", "sent")
            .gte("sent_at", midnight.toISOString()),
          supabase
            .from("bot_decisions")
            .select("id", { count: "exact", head: true })
            .eq("status", "error")
            .gte("created_at", dayAgo),
          supabase.from("group_profiles").select("chat_id, enabled"),
        ]);
        let connection: unknown = { connected: false };
        try {
          const { checkHealth } = await import("@/lib/whapi.server");
          const health = await checkHealth();
          connection = {
            ok: health.ok,
            status: health.status ?? null,
            user: health.userName ?? null,
          };
        } catch (e) {
          connection = { connected: false, error: String((e as Error)?.message ?? e) };
        }
        return JSON.stringify({
          bot: settings.data ?? null,
          whatsapp: connection,
          pending_approvals: approvals.count ?? 0,
          queued_jobs: jobs.count ?? 0,
          posts_sent_today: postsToday.count ?? 0,
          errors_last_24h: errors24h.count ?? 0,
          managed_groups: {
            total: groups.data?.length ?? 0,
            enabled: groups.data?.filter((g) => g.enabled).length ?? 0,
          },
        });
      }

      case "list_groups": {
        const { data } = await supabase
          .from("group_profiles")
          .select("chat_id, name, enabled, require_approval, language")
          .order("name", { ascending: true });
        return JSON.stringify(data ?? []);
      }

      case "get_group_status": {
        const group = await resolveGroup(String(args.group ?? ""));
        if ("error" in group) return JSON.stringify(group);
        const chatId = group.chat_id;
        const [profileRes, statsRes, memoRes, postsRes, actionsRes] = await Promise.all([
          supabase.from("group_profiles").select("*").eq("chat_id", chatId).maybeSingle(),
          supabase
            .from("group_daily_stats")
            .select("date, messages, active_members, bot_posts, post_replies")
            .eq("group_chat_id", chatId)
            .order("date", { ascending: false })
            .limit(7),
          supabase
            .from("strategy_memos")
            .select("week_start, memo, recommendations")
            .eq("group_chat_id", chatId)
            .order("week_start", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("planned_posts")
            .select("source, pillar, prompt, body, status, sent_at")
            .eq("group_chat_id", chatId)
            .order("created_at", { ascending: false })
            .limit(8),
          supabase
            .from("moderation_actions")
            .select("action, target_name, reasoning, created_at")
            .eq("group_chat_id", chatId)
            .order("created_at", { ascending: false })
            .limit(8),
        ]);
        return JSON.stringify({
          profile: profileRes.data ?? "NO PROFILE YET — update_group_profile will create one",
          stats_last_7_days: statsRes.data ?? [],
          latest_strategy_memo: memoRes.data ?? null,
          recent_posts: postsRes.data ?? [],
          recent_moderation: actionsRes.data ?? [],
        }).slice(0, 12_000);
      }

      case "update_group_profile": {
        const group = await resolveGroup(String(args.group ?? ""));
        if ("error" in group) return JSON.stringify(group);
        const { sanitizeProfilePatch } = await import("./profile-patch");
        const { patch, applied, rejected } = sanitizeProfilePatch(args.patch);
        if (!applied.length) {
          return JSON.stringify({ ok: false, error: "no valid fields in patch", rejected });
        }
        const { channelStamp } = await import("./channel.server");
        const { error } = await supabase.from("group_profiles").upsert(
          {
            chat_id: group.chat_id,
            ...(await channelStamp(supabase)),
            ...(group.name ? { name: group.name } : {}),
            ...(patch as Record<string, Json>),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "chat_id" },
        );
        if (error) return JSON.stringify({ ok: false, error: error.message });
        logAction(
          "update_group_profile",
          `updated ${group.name ?? group.chat_id} profile (${applied.join(", ")})`,
          { chat_id: group.chat_id, applied, rejected, patch: patch as Record<string, unknown> },
        );
        return JSON.stringify({ ok: true, applied, rejected });
      }

      case "plan_post": {
        const group = await resolveGroup(String(args.group ?? ""));
        if ("error" in group) return JSON.stringify(group);
        const prompt = String(args.prompt ?? "").slice(0, 1000);
        if (!prompt) return JSON.stringify({ ok: false, error: "empty prompt" });
        const { channelStamp } = await import("./channel.server");
        const { error } = await supabase.from("planned_posts").insert({
          group_chat_id: group.chat_id,
          ...(await channelStamp(supabase)),
          source: "campaign",
          prompt,
          pillar: args.pillar ? String(args.pillar).slice(0, 120) : null,
          scheduled_for: new Date().toISOString(),
        });
        if (error) return JSON.stringify({ ok: false, error: error.message });
        logAction(
          "plan_post",
          `planned a post in ${group.name ?? group.chat_id}: ${prompt.slice(0, 100)}`,
          {
            chat_id: group.chat_id,
            prompt,
          },
        );
        return JSON.stringify({
          ok: true,
          note: "post queued — the engine publishes it within ~1 minute (or routes it to Approvals)",
        });
      }

      case "generate_post_image": {
        const group = await resolveGroup(String(args.group ?? ""));
        if ("error" in group) return JSON.stringify(group);
        const { data: post } = await supabase
          .from("planned_posts")
          .select("id, prompt, body, status")
          .eq("group_chat_id", group.chat_id)
          .in("status", ["planned", "queued_approval"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!post) {
          return JSON.stringify({
            ok: false,
            error: "no unsent post to attach an image to — plan_post first",
          });
        }
        const { writeImagePrompt, generateImage } = await import("@/lib/image-gen.server");
        const baseText = String(post.body ?? post.prompt ?? "").trim();
        const imagePrompt = await writeImagePrompt({
          postText: baseText || String(args.description ?? ""),
          instruction: args.description ? String(args.description) : null,
        });
        const generated = await generateImage(imagePrompt, { source: "post_image_gen" });
        const { error } = await supabase
          .from("planned_posts")
          .update({ media: generated.attachment, updated_at: new Date().toISOString() } as never)
          .eq("id", post.id)
          .in("status", ["planned", "queued_approval"]);
        if (error) return JSON.stringify({ ok: false, error: error.message });
        // Mirror onto a pending approval row too (approvePending sends approval.media).
        try {
          await supabase
            .from("scheduled_approvals")
            .update({ media: generated.attachment } as never)
            .eq("planned_post_id", post.id)
            .eq("status", "pending");
        } catch (e) {
          console.warn("[admin] approval media mirror failed:", e);
        }
        logAction(
          "generate_post_image",
          `generated an AI image for the pending post in ${group.name ?? group.chat_id}`,
          { chat_id: group.chat_id, planned_post_id: post.id, model: generated.model },
        );
        return JSON.stringify({ ok: true, note: "image generated and attached to the post" });
      }

      case "list_pending_approvals": {
        const { data } = await supabase
          .from("scheduled_approvals")
          .select("id, source, target_chat_id, target_name, body, created_at, media, poll")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(20);
        return JSON.stringify(
          (data ?? []).map((r) => ({
            id: r.id.slice(0, 8),
            source: r.source,
            target: r.target_name ?? r.target_chat_id,
            body: String(r.body ?? "").slice(0, 300),
            has_media: !!r.media,
            has_poll: !!(r as { poll?: unknown }).poll,
            created_at: r.created_at,
          })),
        );
      }

      case "approve_pending": {
        const resolved = await resolveApprovalId(String(args.id ?? ""));
        if (typeof resolved !== "string") return JSON.stringify(resolved);
        const { approvePendingCore } = await import("./approvals.server");
        const editedBody = args.edited_body ? String(args.edited_body).slice(0, 4000) : undefined;
        const result = await approvePendingCore(supabase, {
          id: resolved,
          body: editedBody,
          decidedVia: `WhatsApp admin ${admin.label}`,
        });
        logAction("approve_pending", `approved ${resolved.slice(0, 8)} — sent`, {
          approval_id: resolved,
          edited: !!editedBody,
          warnings: result.warnings,
        });
        return JSON.stringify(result);
      }

      case "reject_pending": {
        const resolved = await resolveApprovalId(String(args.id ?? ""));
        if (typeof resolved !== "string") return JSON.stringify(resolved);
        const { rejectPendingCore } = await import("./approvals.server");
        const result = await rejectPendingCore(supabase, {
          id: resolved,
          decidedVia: `WhatsApp admin ${admin.label}`,
        });
        logAction("reject_pending", `rejected ${resolved.slice(0, 8)}`, {
          approval_id: resolved,
        });
        return JSON.stringify(result);
      }

      case "update_bot_settings": {
        const patch: Record<string, boolean> = {};
        if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
        if (typeof args.require_approval_all === "boolean") {
          patch.require_approval_all = args.require_approval_all;
        }
        if (!Object.keys(patch).length) {
          return JSON.stringify({ ok: false, error: "nothing to change" });
        }
        const { error } = await supabase
          .from("bot_settings")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .gte("created_at", "1970-01-01");
        if (error) return JSON.stringify({ ok: false, error: error.message });
        logAction(
          "update_bot_settings",
          `changed global settings: ${Object.entries(patch)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
          { patch },
        );
        return JSON.stringify({ ok: true, ...patch });
      }

      case "get_recent_activity": {
        const hours = Math.min(Math.max(Number(args.hours) || 6, 1), 72);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const [decisions, alerts] = await Promise.all([
          supabase
            .from("bot_decisions")
            .select("stage, status, summary, created_at")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(30),
          supabase
            .from("commands_log")
            .select("prompt, created_at")
            .eq("status", "alert")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(10),
        ]);
        return JSON.stringify({
          activity: decisions.data ?? [],
          alerts: alerts.data ?? [],
        }).slice(0, 12_000);
      }

      case "web_research": {
        const query = String(args.query ?? "").trim();
        if (!query) return JSON.stringify({ error: "empty query" });
        const { tavilySearch } = await import("@/lib/tavily.server");
        const outcome = await tavilySearch(query, { maxResults: 5, budgetMs: 10_000 });
        logAction("web_research", `ran web research: ${query.slice(0, 100)}`, { query });
        return JSON.stringify(outcome).slice(0, 10_000);
      }

      case "attach_web_media": {
        const group = await resolveGroup(String(args.group ?? ""));
        if ("error" in group) return JSON.stringify(group);
        const query = String(args.query ?? "").trim();
        if (!query) return JSON.stringify({ ok: false, error: "empty query" });
        const { data: post } = await supabase
          .from("planned_posts")
          .select("id, prompt, body, status")
          .eq("group_chat_id", group.chat_id)
          .in("status", ["planned", "queued_approval"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!post) {
          return JSON.stringify({
            ok: false,
            error: "no unsent post to attach media to — plan_post first",
          });
        }
        // Search both sources, then download+validate+re-host the first real
        // file. xSearch failure is additive-only, exactly like the research
        // engine treats it.
        const { isTavilyConfigured, tavilySearch } = await import("@/lib/tavily.server");
        const { isApifyConfigured, xSearch } = await import("@/lib/apify-x.server");
        if (!isTavilyConfigured()) {
          return JSON.stringify({ ok: false, error: "TAVILY_API_KEY not configured" });
        }
        const [tv, xs] = await Promise.allSettled([
          tavilySearch(query, { maxResults: 5, timeoutMs: 8_000, budgetMs: 10_000 }),
          isApifyConfigured()
            ? xSearch(query, { maxItems: 8, timeoutMs: 9_000, budgetMs: 10_000 })
            : Promise.resolve(null),
        ]);
        const { collectMediaCandidates, fetchFirstUsableMedia } =
          await import("./research-media.server");
        const candidates = collectMediaCandidates(
          tv.status === "fulfilled" ? tv.value : null,
          xs.status === "fulfilled" ? xs.value : null,
        );
        const preferKind = /וידאו|וידיאו|סרטון|video|clip/i.test(query)
          ? ("video" as const)
          : /pdf|דוח|דו"ח|מסמך|document|report/i.test(query)
            ? ("document" as const)
            : ("image" as const);
        const stored = candidates.length
          ? await fetchFirstUsableMedia(candidates, { budgetMs: 12_000, preferKind })
          : null;
        if (!stored) {
          return JSON.stringify({
            ok: false,
            found: false,
            candidates_tried: candidates.length,
            note: "no usable real media survived download+validation — tell the admin honestly; generate_post_image is the AI alternative",
          });
        }
        // Attach to the post + mirror to its pending approval; append the
        // source link to the post body so the caption credits the origin.
        const { formatUrlForMessage } = await import("./url-display.server");
        const sourceLink = await formatUrlForMessage(stored.sourceUrl);
        const appendSource = (body: unknown) => {
          const b = String(body ?? "").trim();
          return b && !b.includes(stored.sourceUrl) && !b.includes(sourceLink)
            ? `${b}\n\nמקור: ${sourceLink}`
            : b;
        };
        const { error } = await supabase
          .from("planned_posts")
          .update({
            media: stored.attachment,
            ...(post.body ? { body: appendSource(post.body) } : {}),
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", post.id)
          .in("status", ["planned", "queued_approval"]);
        if (error) return JSON.stringify({ ok: false, error: error.message });
        try {
          const { data: appr } = await supabase
            .from("scheduled_approvals")
            .select("id, body")
            .eq("planned_post_id", post.id)
            .eq("status", "pending")
            .maybeSingle();
          if (appr) {
            await supabase
              .from("scheduled_approvals")
              .update({ media: stored.attachment, body: appendSource(appr.body) } as never)
              .eq("id", appr.id);
          }
        } catch (e) {
          console.warn("[admin] approval media mirror failed:", e);
        }
        logAction(
          "attach_web_media",
          `attached a real ${stored.attachment.kind} from web search to the pending post in ${group.name ?? group.chat_id}`,
          {
            chat_id: group.chat_id,
            planned_post_id: post.id,
            query,
            source_url: stored.sourceUrl,
            storage_path: stored.attachment.storage_path,
          },
        );
        return JSON.stringify({
          ok: true,
          kind: stored.attachment.kind,
          source_url: stored.sourceUrl,
          note: "real media downloaded, validated and attached — the post will send it with the text as caption",
        });
      }

      default:
        return JSON.stringify({ error: "unknown tool" });
    }
  }

  return { defs, run };
}

/**
 * Kill any queued admin jobs for chats that are no longer admins — called
 * when the dashboard removes a number, so a pending command from the removed
 * phone can't still execute on the next tick.
 */
export async function supersedeAdminJobsForChat(supabase: Supa, chatId: string): Promise<void> {
  const { data } = await supabase
    .from("bot_jobs")
    .select("id")
    .eq("chat_id", chatId)
    .eq("kind", ADMIN_COMMAND_JOB_KIND)
    .eq("status", "pending");
  await supersedeJobsByIds(
    supabase,
    (data ?? []).map((r) => r.id),
  );
}
