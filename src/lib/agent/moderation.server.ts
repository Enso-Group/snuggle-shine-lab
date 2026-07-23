// Moderation & governance for managed groups. Every inbound group message in
// an enabled profile passes through here BEFORE the reply gates. Cheap
// heuristics run first; the fast model is consulted only when the profile has
// rules to enforce. Every action is written to moderation_actions with its
// reasoning, and mirrored to bot_decisions.
import { callLLM, parseJsonLoose } from "@/lib/llm.server";
import { logDecision } from "./decisions.server";
import type { GroupProfile } from "./groups.server";
import type { InboundMessage } from "./inbound";
import type { AgentDeps, AgentSettings } from "./types";
import type { Supa } from "./types";

export type ModerationVerdict = {
  violation: boolean;
  rule: string | null;
  severity: "low" | "medium" | "high";
  reasoning: string;
};

const DEFAULT_WARN_LIMIT = 2;
const DEFAULT_REMOVE_LIMIT = 4;

// Obvious-spam heuristics — free, before any model call.
const SPAM_PATTERNS = [
  /(https?:\/\/\S+.*){3,}/is, // 3+ links in one message
  /הצטרפו עכשיו.*קבוצה|לחצו על הלינק.*להצטרפ/i,
  /(earn|profit|crypto|forex).*(guaranteed|100%|x10)/i,
  /wa\.me\/\d+.*wa\.me\/\d+/is,
];

export function heuristicSpam(text: string): string | null {
  for (const re of SPAM_PATTERNS)
    if (re.test(text)) return "Spam / unapproved promotion (automatic detection)";
  return null;
}

async function classifyViolation(
  profile: GroupProfile,
  m: InboundMessage,
  settings: AgentSettings,
): Promise<ModerationVerdict> {
  const none: ModerationVerdict = { violation: false, rule: null, severity: "low", reasoning: "" };
  const heuristic = heuristicSpam(m.body);
  if (heuristic) {
    return {
      violation: true,
      rule: heuristic,
      severity: "high",
      reasoning: "Obvious spam pattern",
    };
  }
  if (!profile.rules.length && !profile.forbidden_topics.length) return none;

  const system = `אתה מודרטור של קבוצת וואטסאפ. בדוק אם ההודעה מפרה את חוקי הקבוצה והחזר JSON בלבד:
{"violation": true/false, "rule": "the violated rule as written, or null", "severity": "low/medium/high", "reasoning": "short sentence in English"}

חוקי הקבוצה:
${profile.rules.map((r) => `- ${r}`).join("\n") || "(אין)"}
נושאים אסורים:
${profile.forbidden_topics.map((t) => `- ${t}`).join("\n") || "(אין)"}

חשוב: הפרה = ברורה בלבד. שיחה לגיטימית, ביקורת עניינית או הומור אינם הפרה. בספק — violation=false.`;

  try {
    const res = await callLLM({
      role: "fast",
      source: "agent_moderation",
      json: true,
      overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `הודעה מאת ${m.senderName || m.senderId}:\n"""${m.body.slice(0, 800)}"""`,
        },
      ],
    });
    const parsed = parseJsonLoose<Partial<ModerationVerdict>>(res.content);
    return {
      violation: parsed.violation === true,
      rule: parsed.rule ? String(parsed.rule) : null,
      severity:
        parsed.severity === "high" || parsed.severity === "medium" ? parsed.severity : "low",
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch (e) {
    console.warn("[moderation] classify failed (treating as no violation):", e);
    return none;
  }
}

async function bumpMemberViolations(
  supabase: Supa,
  groupChatId: string,
  m: InboundMessage,
): Promise<{ violations: number; warned_count: number } | null> {
  try {
    const { data: existing } = await supabase
      .from("group_members")
      .select("id, violations, warned_count")
      .eq("group_chat_id", groupChatId)
      .eq("wa_id", m.senderId)
      .maybeSingle();
    if (existing) {
      const violations = (existing.violations ?? 0) + 1;
      await supabase
        .from("group_members")
        .update({
          violations,
          last_violation_at: new Date().toISOString(),
          ...(m.senderName ? { display_name: m.senderName } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return { violations, warned_count: existing.warned_count ?? 0 };
    }
    await supabase.from("group_members").insert({
      group_chat_id: groupChatId,
      wa_id: m.senderId,
      display_name: m.senderName || null,
      violations: 1,
      last_violation_at: new Date().toISOString(),
    });
    return { violations: 1, warned_count: 0 };
  } catch (e) {
    console.warn("[moderation] member tracking failed:", e);
    return null;
  }
}

async function recordAction(
  supabase: Supa,
  args: {
    groupChatId: string;
    m: InboundMessage;
    action: "warn" | "delete" | "remove" | "escalate";
    rule: string | null;
    reasoning: string;
    ok: boolean;
    error?: string;
  },
): Promise<void> {
  try {
    await supabase.from("moderation_actions").insert({
      group_chat_id: args.groupChatId,
      target_wa_id: args.m.senderId,
      target_name: args.m.senderName || null,
      whapi_message_id: args.m.messageId || null,
      action: args.action,
      rule_violated: args.rule,
      reasoning: args.reasoning,
      status: args.ok ? "done" : "failed",
      error: args.error ?? null,
    });
  } catch (e) {
    console.warn("[moderation] action log failed:", e);
  }
}

export async function notifyOwner(
  deps: AgentDeps,
  profile: GroupProfile,
  text: string,
): Promise<void> {
  if (!profile.owner_dm) return;
  try {
    await deps.whapi.sendText(profile.owner_dm, text);
  } catch (e) {
    console.warn("[moderation] owner DM failed:", e);
  }
}

/**
 * Handles a group message through moderation.
 * - `handled` is true when a violation was found (the message must not continue
 *   to the reply gates).
 * - `acted` is true when the bot actually posted a message into the group (a
 *   public warning) — i.e. the account participated, so the chat is worth
 *   persisting. Silent first-strike tracking sets handled=true, acted=false.
 * `conversationId` may be null for a group we've only observed so far (no
 * conversation row yet); it is used only for the decision-log link.
 */
export async function moderateGroupMessage(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile,
  m: InboundMessage,
  conversationId: string | null,
): Promise<{ handled: boolean; acted: boolean }> {
  if (!profile.moderation.enabled) return { handled: false, acted: false };
  const verdict = await classifyViolation(profile, m, settings);
  if (!verdict.violation) return { handled: false, acted: false };

  const { supabase } = deps;
  let acted = false;
  const member = await bumpMemberViolations(supabase, profile.chat_id, m);
  const violations = member?.violations ?? 1;
  const warnLimit = profile.moderation.warn_limit ?? DEFAULT_WARN_LIMIT;
  const removeLimit = profile.moderation.remove_limit ?? DEFAULT_REMOVE_LIMIT;

  // 1) Delete the offending message when configured (high severity or repeat).
  if (profile.moderation.delete_violations && m.messageId && verdict.severity !== "low") {
    const { deleteMessage } = await import("@/lib/whapi.server");
    const del = await deleteMessage(m.messageId);
    await recordAction(supabase, {
      groupChatId: profile.chat_id,
      m,
      action: "delete",
      rule: verdict.rule,
      reasoning: verdict.reasoning,
      ok: del.ok,
      error: del.error,
    });
  }

  // 2) Remove repeat offenders (requires the bot to be a group admin).
  if (violations >= removeLimit && verdict.severity !== "low") {
    const { removeGroupParticipants } = await import("@/lib/whapi.server");
    const rem = await removeGroupParticipants(profile.chat_id, [m.senderId]);
    await recordAction(supabase, {
      groupChatId: profile.chat_id,
      m,
      action: "remove",
      rule: verdict.rule,
      reasoning: `${verdict.reasoning} (violation ${violations}/${removeLimit})`,
      ok: rem.ok,
      error: rem.error,
    });
    if (rem.ok) {
      await supabase
        .from("group_members")
        .update({ removed: true, left_at: new Date().toISOString() })
        .eq("group_chat_id", profile.chat_id)
        .eq("wa_id", m.senderId);
    }
    await notifyOwner(
      deps,
      profile,
      `⚠️ ${m.senderName || m.senderId} הוסר/ה מהקבוצה "${profile.name ?? profile.chat_id}" אחרי ${violations} הפרות. סיבה: ${verdict.rule ?? verdict.reasoning}`,
    );
  } else if (violations >= warnLimit) {
    // 3) Public warning, generated in the group's tone.
    let warning = `לתשומת לבך ${m.senderName || ""} — נא לשמור על חוקי הקבוצה 🙏`;
    try {
      const res = await callLLM({
        role: "fast",
        source: "agent_moderation",
        overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
        messages: [
          {
            role: "system",
            content: `כתוב אזהרה קצרה ומנומסת (משפט אחד) לחבר קבוצה שהפר חוק, בשפה ${profile.language}. בלי להשפיל, בלי אימוג'ים מוגזמים. ציין את הכלל בעדינות. החזר רק את הטקסט.`,
          },
          {
            role: "user",
            content: `שם: ${m.senderName || "החבר"} | הכלל שהופר: ${verdict.rule ?? "חוקי הקבוצה"}`,
          },
        ],
      });
      if (res.content.trim()) warning = res.content.trim();
    } catch {
      /* fall back to the static warning */
    }
    try {
      await deps.whapi.sendText(profile.chat_id, warning);
      acted = true;
    } catch (e) {
      console.warn("[moderation] warn send failed:", e);
    }
    await supabase
      .from("group_members")
      .update({
        warned_count: (member?.warned_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("group_chat_id", profile.chat_id)
      .eq("wa_id", m.senderId);
    await recordAction(supabase, {
      groupChatId: profile.chat_id,
      m,
      action: "warn",
      rule: verdict.rule,
      reasoning: `${verdict.reasoning} (violation #${violations})`,
      ok: true,
    });
  } else {
    // First strike — tracked silently, no public action yet.
    await recordAction(supabase, {
      groupChatId: profile.chat_id,
      m,
      action: "escalate",
      rule: verdict.rule,
      reasoning: `${verdict.reasoning} (first strike — tracked only)`,
      ok: true,
    });
  }

  logDecision(supabase, {
    conversation_id: conversationId,
    chat_id: profile.chat_id,
    trigger: deps.trigger,
    stage: "moderation",
    status: "ok",
    summary: `Rule violation "${verdict.rule ?? "group rules"}" by ${m.senderName || m.senderId} — violation #${violations}`,
    data: { verdict: verdict as unknown as Record<string, unknown>, violations },
  });
  return { handled: true, acted };
}
