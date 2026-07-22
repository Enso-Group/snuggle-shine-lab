// Reply-decision engine — the MANDATORY first gate for group messages.
// Decides whether the bot should respond at all, before any drafting happens,
// and logs every decision (respond or skip) with its reasoning.
//
// Respond only when:
//  * the bot is directly @-mentioned,
//  * someone replies to one of the bot's messages,
//  * the bot's name is used as a word,
//  * or the group profile owns the intervention: an open question clearly
//    aimed at the group's manager/business (strict fast-model check, only in
//    profile-enabled groups with reply_to_questions on).
// Everything else is member-to-member chatter and is skipped. 1:1 chats never
// pass through here — the bot always answers them.
import { callLLM, parseJsonLoose } from "@/lib/llm.server";
import { logDecision } from "./decisions.server";
import type { GroupProfile } from "./groups.server";
import type { InboundMessage } from "./inbound";
import { looksLikeQuestion } from "./posting-schedule";
import { detectDirectSignal, normalizeWaId } from "./reply-gate";
import type { AgentDeps, AgentSettings, Supa } from "./types";

export type GateDecision = {
  respond: boolean;
  signal: string;
  reason: string;
};

// The bot's own WA id, memoized per isolate (one Whapi health call).
let ownWaIdMemo: string | null = null;

async function getOwnWaId(): Promise<string> {
  if (ownWaIdMemo !== null) return ownWaIdMemo;
  try {
    const { checkHealth } = await import("@/lib/whapi.server");
    const health = await checkHealth();
    ownWaIdMemo = normalizeWaId(health.userId ?? "");
  } catch {
    ownWaIdMemo = "";
  }
  return ownWaIdMemo;
}

async function quotedIsBotMessage(
  supabase: Supa,
  conversationId: string,
  quotedId: string | null,
): Promise<boolean> {
  if (!quotedId) return false;
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .eq("whapi_message_id", quotedId)
    .limit(1);
  return !!data?.length;
}

/** Strict LLM check: does the group's manager own this message? Default NO. */
async function ownedQuestionCheck(
  ctx: { supabase: Supa; settings: AgentSettings; profile: GroupProfile },
  m: InboundMessage,
  conversationId: string,
): Promise<GateDecision> {
  const { data: hist } = await ctx.supabase
    .from("messages")
    .select("direction, sender_name, body")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(8);
  const history = (hist ?? [])
    .reverse()
    .filter((h) => h.body)
    .map(
      (h) =>
        `${h.direction === "outbound" ? "Us" : h.sender_name || "Member"}: ${String(h.body).slice(0, 200)}`,
    )
    .join("\n");

  const system = `You are the gatekeeper for a WhatsApp group's manager. Decide whether the LATEST message requires a response from the manager. Return JSON only:
{"respond": true/false, "reason": "short sentence in English"}

Group purpose: ${ctx.profile.purpose ?? "community"}${ctx.profile.instructions ? `\nManager's instructions: ${ctx.profile.instructions.slice(0, 500)}` : ""}

Iron rule — the default is respond=false. respond=true ONLY if:
- the question is clearly aimed at the manager/business (not at another member), or
- it is an unanswered question squarely in the group's domain that the manager owns.
Small talk between members, member-to-member replies, opinions, jokes — respond=false, always. When in doubt — false. The message may be in any language; your reason must be in English.`;

  try {
    const res = await callLLM({
      role: "fast",
      source: "agent_reply_gate",
      json: true,
      overrides: {
        model_strong: ctx.settings.model_strong,
        model_fast: ctx.settings.model_fast,
      },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Recent conversation:\n${history || "(empty)"}\n\nMessage to evaluate, from ${m.senderName || "a member"}:\n"""${m.body.slice(0, 600)}"""`,
        },
      ],
    });
    const parsed = parseJsonLoose<{ respond?: boolean; reason?: string }>(res.content);
    return {
      respond: parsed.respond === true,
      signal: "owned_question",
      reason: String(
        parsed.reason ?? (parsed.respond ? "Question owned by the manager" : "General chatter"),
      ),
    };
  } catch (e) {
    // The gate must fail CLOSED — an error never makes the bot butt in.
    return {
      respond: false,
      signal: "owned_question",
      reason: `Classification failed — staying silent by default (${String((e as Error)?.message ?? e).slice(0, 80)})`,
    };
  }
}

export async function decideGroupReply(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile | null,
  m: InboundMessage,
  conversationId: string,
): Promise<GateDecision> {
  const ownWaId = deps.trigger === "simulation" ? "" : await getOwnWaId();
  const quotedIsBot = await quotedIsBotMessage(deps.supabase, conversationId, m.quotedId);
  const signal = detectDirectSignal({
    message: m,
    ownWaId,
    botName: settings.bot_name ?? "",
    quotedIsBotMessage: quotedIsBot,
  });

  let decision: GateDecision;
  if (signal !== "none") {
    if (profile && !profile.reply_when_mentioned) {
      decision = {
        respond: false,
        signal,
        reason: "Directly addressed, but the group profile disables mention replies",
      };
    } else {
      const labels: Record<string, string> = {
        mentioned: "Bot was directly @-mentioned",
        reply_to_bot: "Reply to one of the bot's messages",
        named: "Bot's name was used",
      };
      decision = { respond: true, signal, reason: labels[signal] ?? signal };
    }
  } else if (profile?.enabled && profile.reply_to_questions && looksLikeQuestion(m.body)) {
    decision = await ownedQuestionCheck(
      { supabase: deps.supabase, settings, profile },
      m,
      conversationId,
    );
  } else {
    decision = {
      respond: false,
      signal: "none",
      reason: "General chatter between members — not addressed to the bot",
    };
  }

  logDecision(deps.supabase, {
    conversation_id: conversationId,
    chat_id: m.chatId,
    trigger: deps.trigger,
    stage: "reply_gate",
    status: decision.respond ? "ok" : "skip",
    summary: `${decision.respond ? "Responding" : "Staying silent"} — ${decision.reason}`,
    data: {
      signal: decision.signal,
      sender: m.senderName || m.senderId,
      body_preview: m.body.slice(0, 120),
      managed_group: !!profile?.enabled,
    },
  });
  return decision;
}
