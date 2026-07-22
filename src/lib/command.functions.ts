// Command Center chat — talk to the bot about a group and steer it in plain
// language. The model can inspect the group and APPLY changes through
// whitelisted tools; every applied change is validated (profile-patch.ts),
// persisted, and logged to bot_decisions with reasoning.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import type { Json } from "@/integrations/supabase/types";
import { z } from "zod";

export type CommandAction = { tool: string; summary: string };
export type CommandChatResult = { reply: string; actions: CommandAction[] };

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_group_status",
      description:
        "Load the group's current profile, 7-day stats, latest strategy memo, pending posts and recent bot actions. Call this before answering questions about the group or proposing changes.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_group_profile",
      description:
        "Apply changes to the group's management profile. Pass ONLY the fields to change. Allowed fields: enabled, instructions, purpose, audience, tone, language, content_pillars (string[]), posting_schedule ([{day:0-6|null,time:'HH:MM',pillar?,prompt?}]), rules (string[]), forbidden_topics (string[]), moderation ({enabled,delete_violations,warn_limit,remove_limit}), welcome ({enabled,hint}), reply_when_mentioned, reply_to_questions, allow_reactive_posts, escalation_rules, kpis. Content fields (rules, instructions, pillars…) should be written in the group's language.",
      parameters: {
        type: "object",
        properties: { patch: { type: "object", description: "Partial profile object" } },
        required: ["patch"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "plan_post",
      description:
        "Queue a one-off campaign post for this group. The posting engine drafts, self-reviews and publishes it within ~1 minute (or routes it to Approvals when approval mode is on). If the manager wants a poll, say so explicitly in the prompt (e.g. 'include a poll asking X with options A/B/C') — the engine sends it as a native tappable WhatsApp poll, never as inline text.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What the post should be about / achieve" },
          pillar: { type: "string", description: "Optional content pillar label" },
        },
        required: ["prompt"],
      },
    },
  },
];

export const commandChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        groupChatId: z.string().min(5).endsWith("@g.us"),
        groupName: z.string().max(200).optional(),
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
          .min(1)
          .max(30),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<CommandChatResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callLLM } = await import("@/lib/llm.server");
    const { logDecision } = await import("@/lib/agent/decisions.server");
    const { sanitizeProfilePatch } = await import("@/lib/agent/profile-patch");

    const chatId = data.groupChatId;
    const actions: CommandAction[] = [];

    async function getGroupStatus(): Promise<string> {
      const [profileRes, statsRes, memoRes, postsRes, actionsRes] = await Promise.all([
        supabaseAdmin.from("group_profiles").select("*").eq("chat_id", chatId).maybeSingle(),
        supabaseAdmin
          .from("group_daily_stats")
          .select("date, messages, active_members, bot_posts, post_replies")
          .eq("group_chat_id", chatId)
          .order("date", { ascending: false })
          .limit(7),
        supabaseAdmin
          .from("strategy_memos")
          .select("week_start, memo, recommendations")
          .eq("group_chat_id", chatId)
          .order("week_start", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from("planned_posts")
          .select("source, pillar, prompt, body, status, sent_at, engagement")
          .eq("group_chat_id", chatId)
          .order("created_at", { ascending: false })
          .limit(8),
        supabaseAdmin
          .from("moderation_actions")
          .select("action, target_name, reasoning, created_at")
          .eq("group_chat_id", chatId)
          .order("created_at", { ascending: false })
          .limit(8),
      ]);
      return JSON.stringify(
        {
          profile: profileRes.data ?? "NO PROFILE YET — update_group_profile will create one",
          stats_last_7_days: statsRes.data ?? [],
          latest_strategy_memo: memoRes.data ?? null,
          recent_posts: postsRes.data ?? [],
          recent_moderation: actionsRes.data ?? [],
        },
        null,
        1,
      ).slice(0, 12_000);
    }

    async function updateProfile(rawPatch: unknown): Promise<string> {
      const { patch, applied, rejected } = sanitizeProfilePatch(rawPatch);
      if (!applied.length) {
        return JSON.stringify({ ok: false, error: "no valid fields in patch", rejected });
      }
      const { error } = await supabaseAdmin.from("group_profiles").upsert(
        {
          chat_id: chatId,
          ...(data.groupName ? { name: data.groupName } : {}),
          ...(patch as Record<string, Json>),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "chat_id" },
      );
      if (error) return JSON.stringify({ ok: false, error: error.message });
      const summary = `Profile updated via Command Center: ${applied.join(", ")}`;
      actions.push({ tool: "update_group_profile", summary });
      logDecision(supabaseAdmin, {
        chat_id: chatId,
        trigger: "scheduled",
        stage: "config",
        summary,
        data: { applied, rejected, patch: patch as Record<string, unknown> },
      });
      return JSON.stringify({ ok: true, applied, rejected });
    }

    async function planPost(prompt: string, pillar?: string): Promise<string> {
      const { error } = await supabaseAdmin.from("planned_posts").insert({
        group_chat_id: chatId,
        source: "campaign",
        prompt: prompt.slice(0, 1000),
        pillar: pillar?.slice(0, 120) ?? null,
        scheduled_for: new Date().toISOString(),
      });
      if (error) return JSON.stringify({ ok: false, error: error.message });
      const summary = `Campaign post planned: ${prompt.slice(0, 100)}`;
      actions.push({ tool: "plan_post", summary });
      logDecision(supabaseAdmin, {
        chat_id: chatId,
        trigger: "scheduled",
        stage: "config",
        summary,
        data: { prompt, pillar: pillar ?? null },
      });
      return JSON.stringify({
        ok: true,
        note: "post queued — the engine publishes it within ~1 minute",
      });
    }

    const system = `You are the operations copilot for an autonomous WhatsApp community-manager agent. The manager is talking to you about ONE group: "${data.groupName ?? chatId}" (${chatId}).

You can: answer questions about how the agent runs this group (always ground answers in get_group_status data — never invent numbers), and APPLY changes the manager asks for using update_group_profile / plan_post.

Rules:
- Before proposing or applying changes, call get_group_status to see the current state.
- Translate plain-language requests into precise profile changes. Examples: "be stricter about spam" → moderation.enabled=true, lower warn_limit/remove_limit, add an explicit no-spam rule; "post more about X" → add X to content_pillars and/or extra posting_schedule slots; "stop welcoming people" → welcome.enabled=false.
- Group-facing text (rules, instructions, welcome hints, pillars) must be written in the group's language (see profile.language). Your replies to the manager are in English.
- After applying, confirm exactly what changed, field by field. If a request is ambiguous, ask one short clarifying question instead of guessing.
- Keep replies short and operational.`;

    type Msg = {
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    const messages: Msg[] = [
      { role: "system", content: system },
      ...data.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let step = 0; step < 5; step++) {
      const res = await callLLM({
        role: "strong",
        source: "command_chat",
        tools: TOOLS,
        messages,
      });
      if (!res.toolCalls.length) {
        return { reply: res.content.trim() || "Done.", actions };
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
          if (tc.function.name === "get_group_status") result = await getGroupStatus();
          else if (tc.function.name === "update_group_profile")
            result = await updateProfile(args.patch);
          else if (tc.function.name === "plan_post")
            result = await planPost(
              String(args.prompt ?? ""),
              args.pillar ? String(args.pillar) : undefined,
            );
          else result = JSON.stringify({ error: "unknown tool" });
        } catch (e) {
          result = JSON.stringify({ error: String((e as Error)?.message ?? e) });
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    return {
      reply:
        "I ran out of steps while working on that — the changes applied so far are listed below.",
      actions,
    };
  });
