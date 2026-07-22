// Post-exchange memory: after a reply is delivered, a fast model extracts
// durable facts about the person and (optionally) proposes a follow-up.
// This runs after the send, so failures here can never cost a reply — they
// only cost memory, and are logged.
import { callLLM, parseJsonLoose } from "@/lib/llm.server";
import { applyPersonUpdate, type PersonRow } from "./people.server";
import type { AgentContext } from "./types";
import type { Supa } from "./types";

export type MemoryExtraction = {
  facts: string[];
  language: string | null;
  sentiment: string | null;
  funnel_stage: string | null;
  follow_up: { hours: number; reason: string } | null;
};

export async function extractAndStoreMemory(
  supabase: Supa,
  ctx: AgentContext,
  person: PersonRow,
  sentParts: string[],
): Promise<MemoryExtraction | null> {
  const system = `אתה מנהל זיכרון לקוחות. מתוך חילופי ההודעות, חלץ רק מידע יציב ושימושי לעתיד והחזר JSON בלבד:
{"facts": ["short new fact, in English", ...], "language": "he/en/... או null", "sentiment": "one-two words in English or null", "funnel_stage": "lead/customer/community/vip/churned או null", "follow_up": {"hours": מספר, "reason": "why, in English"} או null}
כל הטקסטים החופשיים (facts/sentiment/reason) — באנגלית; הם מוצגים בלוח בקרה באנגלית.

חוקים:
- facts: רק עובדות חדשות שלא מופיעות ברשימה הקיימת — שם, צרכים, העדפות, התנגדויות, הבטחות שניתנו, פרטים אישיים רלוונטיים. בלי פרשנות, בלי כפילויות. אם אין — [].
- follow_up: הצע רק אם השיחה נעצרה בנקודה משמעותית (ליד שמתלבט, הבטחנו לחזור, ביקש זמן לחשוב). אחרת null. hours בין 4 ל-96.
- funnel_stage: עדכן רק אם יש עדות ברורה לשינוי.`;

  const user = `עובדות קיימות על ${person.display_name ?? "איש הקשר"}:
${person.facts.length ? person.facts.map((f) => `- ${f.text}`).join("\n") : "(אין עדיין)"}

ההודעה שלו:
"""${ctx.message.body.slice(0, 800)}"""

מה ענינו:
"""${sentParts.join("\n").slice(0, 800)}"""`;

  try {
    const res = await callLLM({
      role: "fast",
      source: "agent_memory",
      json: true,
      overrides: { model_strong: ctx.settings.model_strong, model_fast: ctx.settings.model_fast },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = parseJsonLoose<Partial<MemoryExtraction>>(res.content);
    const extraction: MemoryExtraction = {
      facts: Array.isArray(parsed.facts)
        ? parsed.facts.map((f) => String(f)).filter((f) => f.trim())
        : [],
      language: parsed.language ? String(parsed.language) : null,
      sentiment: parsed.sentiment ? String(parsed.sentiment) : null,
      funnel_stage: parsed.funnel_stage ? String(parsed.funnel_stage) : null,
      follow_up:
        parsed.follow_up && typeof parsed.follow_up === "object"
          ? {
              hours: clampHours(Number((parsed.follow_up as { hours?: unknown }).hours)),
              reason: String((parsed.follow_up as { reason?: unknown }).reason ?? "").slice(0, 300),
            }
          : null,
    };
    if (extraction.follow_up && !extraction.follow_up.reason) extraction.follow_up = null;

    await applyPersonUpdate(supabase, person, extraction);
    return extraction;
  } catch (e) {
    console.warn("[memory] extraction failed (reply already sent):", e);
    return null;
  }
}

function clampHours(h: number): number {
  if (!Number.isFinite(h)) return 24;
  return Math.min(96, Math.max(4, Math.round(h)));
}

/** Replace any pending follow-up for the conversation with the new proposal. */
export async function scheduleFollowUp(
  supabase: Supa,
  args: {
    conversationId: string;
    chatId: string;
    personWaId: string | null;
    hours: number;
    reason: string;
  },
): Promise<void> {
  try {
    await supabase
      .from("follow_ups")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("conversation_id", args.conversationId)
      .eq("status", "pending");
    const { error } = await supabase.from("follow_ups").insert({
      conversation_id: args.conversationId,
      chat_id: args.chatId,
      person_wa_id: args.personWaId,
      due_at: new Date(Date.now() + args.hours * 3_600_000).toISOString(),
      reason: args.reason,
    });
    if (error) console.warn("[memory] follow-up insert failed:", error.message);
  } catch (e) {
    console.warn("[memory] follow-up scheduling failed:", e);
  }
}
