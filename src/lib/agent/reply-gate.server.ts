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
        `${h.direction === "outbound" ? "אנחנו" : h.sender_name || "חבר"}: ${String(h.body).slice(0, 200)}`,
    )
    .join("\n");

  const system = `אתה שומר הסף של מנהל קבוצת וואטסאפ. החלט אם ההודעה האחרונה דורשת תגובה מהמנהל, והחזר JSON בלבד:
{"respond": true/false, "reason": "משפט קצר"}

הקבוצה: ${ctx.profile.purpose ?? "קהילה"}${ctx.profile.instructions ? `\nהנחיות המנהל: ${ctx.profile.instructions.slice(0, 500)}` : ""}

כלל ברזל — ברירת המחדל היא respond=false. respond=true רק אם:
- שאלה שמופנית בבירור למנהל/לעסק (לא לחבר אחר בקבוצה), או
- שאלה בתחום שהקבוצה קיימת בשבילו, שאף אחד לא ענה עליה.
שיחת חולין בין חברים, תגובות אחד לשני, דעות, בדיחות — respond=false תמיד. בספק — false.`;

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
          content: `שיחה אחרונה:\n${history || "(ריק)"}\n\nההודעה לבדיקה מאת ${m.senderName || "חבר"}:\n"""${m.body.slice(0, 600)}"""`,
        },
      ],
    });
    const parsed = parseJsonLoose<{ respond?: boolean; reason?: string }>(res.content);
    return {
      respond: parsed.respond === true,
      signal: "owned_question",
      reason: String(parsed.reason ?? (parsed.respond ? "שאלה שבבעלות המנהל" : "שיחה כללית")),
    };
  } catch (e) {
    // The gate must fail CLOSED — an error never makes the bot butt in.
    return {
      respond: false,
      signal: "owned_question",
      reason: `בדיקת הסיווג נכשלה — ברירת מחדל שקטה (${String((e as Error)?.message ?? e).slice(0, 80)})`,
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
        reason: "פנייה ישירה, אבל פרופיל הקבוצה מכבה תגובות לאזכורים",
      };
    } else {
      const labels: Record<string, string> = {
        mentioned: "הבוט תויג ישירות",
        reply_to_bot: "תגובה להודעה של הבוט",
        named: "השם של הבוט הוזכר",
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
      reason: "שיחה כללית בין חברי הקבוצה — לא מופנית לבוט",
    };
  }

  logDecision(deps.supabase, {
    conversation_id: conversationId,
    chat_id: m.chatId,
    trigger: deps.trigger,
    stage: "reply_gate",
    status: decision.respond ? "ok" : "skip",
    summary: `${decision.respond ? "עונה" : "שותק"} — ${decision.reason}`,
    data: {
      signal: decision.signal,
      sender: m.senderName || m.senderId,
      body_preview: m.body.slice(0, 120),
      managed_group: !!profile?.enabled,
    },
  });
  return decision;
}
