// Reasoning stages: intent analysis (fast model) → draft (strong model) →
// self-critique & revision (strong model). Each returns structured data that
// the pipeline logs to bot_decisions.
import { callLLM, parseJsonLoose } from "@/lib/llm.server";
import type { LLMModelOverrides } from "@/lib/llm.server";
import { normalizeReplyParts } from "./inbound";
import { buildGroundingRules } from "./kb.server";
import { groupPromptBlock } from "./groups.server";
import { personPromptBlock } from "./people.server";
import { leaksPersona, stripLeakSentences, PERSONA_FALLBACK_LINE } from "./persona";
import { buildHumanizeRules, buildDateContext } from "./prompts.server";
import type { AgentContext, CritiqueResult, DraftResult, IntentAnalysis } from "./types";

function overridesOf(ctx: AgentContext): LLMModelOverrides {
  return { model_strong: ctx.settings.model_strong, model_fast: ctx.settings.model_fast };
}

function condensedHistory(ctx: AgentContext, limit: number): string {
  return ctx.history
    .slice(-limit)
    .map(
      (h) =>
        `${h.role === "assistant" ? "אנחנו" : h.senderName || "לקוח"}: ${h.content.slice(0, 300)}`,
    )
    .join("\n");
}

function detectLanguageFallback(text: string): string {
  if (/[֐-׿]/.test(text)) return "he";
  if (/[؀-ۿ]/.test(text)) return "ar";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  return "en";
}

// ---------------------------------------------------------------------------
// Stage: intent & person analysis
// ---------------------------------------------------------------------------
export async function analyzeIntent(ctx: AgentContext): Promise<IntentAnalysis> {
  const fallback: IntentAnalysis = {
    intent: "unknown",
    language: detectLanguageFallback(ctx.message.body),
    urgency: "normal",
    sentiment: "neutral",
    goal: "Reply helpfully and professionally",
    escalate: false,
    escalate_reason: null,
  };

  const system = `אתה מנתח הודעות נכנסות בוואטסאפ עבור צוות עסקי. נתח את ההודעה האחרונה בהקשר השיחה והחזר JSON בלבד, בלי טקסט נוסף, במבנה:
{"intent": "מה האדם באמת רוצה, במשפט קצר", "language": "קוד שפה של ההודעה האחרונה: he/en/ru/ar/...", "urgency": "low/normal/high", "sentiment": "מצב רגשי במילה-שתיים", "goal": "מה איש מקצוע מצטיין היה מנסה להשיג בתשובה הזו", "escalate": true/false, "escalate_reason": "אם escalate=true — סיבה קצרה, אחרת null"}
escalate=true רק אם יש איום משפטי, דרישת החזר כספי, נושא רגיש/משברי, או בקשה מפורשת לדבר עם בן אדם.
חשוב: כתוב את הערכים של intent / sentiment / goal / escalate_reason באנגלית (הם מוצגים בלוח בקרה באנגלית). שדה language נשאר קוד שפה.`;

  const user = `היסטוריה אחרונה:
${condensedHistory(ctx, 10) || "(שיחה חדשה)"}

ההודעה החדשה מאת ${ctx.message.senderName || "לא ידוע"}:
"""${ctx.message.body.slice(0, 1000)}"""`;

  try {
    const res = await callLLM({
      role: "fast",
      source: "agent_intent",
      json: true,
      overrides: overridesOf(ctx),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = parseJsonLoose<Partial<IntentAnalysis>>(res.content);
    return {
      intent: String(parsed.intent ?? fallback.intent),
      language: String(parsed.language ?? fallback.language),
      urgency: parsed.urgency === "low" || parsed.urgency === "high" ? parsed.urgency : "normal",
      sentiment: String(parsed.sentiment ?? fallback.sentiment),
      goal: String(parsed.goal ?? fallback.goal),
      escalate: !!parsed.escalate,
      escalate_reason: parsed.escalate ? String(parsed.escalate_reason ?? "") || null : null,
    };
  } catch (e) {
    console.warn(
      "[agent] intent analysis failed, using fallback:",
      String((e as Error)?.message ?? e),
    );
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Stage: draft
// ---------------------------------------------------------------------------
export async function draftReply(ctx: AgentContext, intent: IntentAnalysis): Promise<DraftResult> {
  const maxParts = ctx.settings.agent_config?.max_reply_parts ?? 3;

  const system =
    ctx.settings.system_prompt +
    buildHumanizeRules() +
    buildDateContext() +
    groupPromptBlock(ctx.groupProfile) +
    personPromptBlock(ctx.person) +
    buildGroundingRules(ctx.kb ?? { block: "", count: 0 }) +
    `

ניתוח ההודעה הנוכחית (שימוש פנימי — אל תצטט אותו):
- כוונה: ${intent.intent}
- שפת התשובה חייבת להיות: ${intent.language}
- דחיפות: ${intent.urgency} | מצב רגשי: ${intent.sentiment}
- המטרה שלך בתשובה: ${intent.goal}

פורמט פלט (חובה): החזר JSON בלבד במבנה {"messages": ["הודעה 1", "הודעה 2..."], "reasoning": "one short sentence in English on why this is the right reply"}.
- בין 1 ל-${maxParts} הודעות, כמו שאדם כותב בוואטסאפ: קצרות, בלי חומות טקסט.
- ברוב המקרים הודעה אחת מספיקה. פצל רק אם יש באמת שני חלקים נפרדים (למשל תשובה + שאלת המשך).`;

  const messages = [
    { role: "system" as const, content: system },
    ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: ctx.message.body },
  ];

  const res = await callLLM({
    role: "strong",
    source: "agent_draft",
    json: true,
    overrides: overridesOf(ctx),
    messages,
  });

  try {
    const parsed = parseJsonLoose<{ messages?: unknown; reasoning?: unknown }>(res.content);
    const parts = Array.isArray(parsed.messages)
      ? normalizeReplyParts(
          parsed.messages.map((m) => String(m ?? "")),
          maxParts,
        )
      : [];
    if (parts.length) {
      return { messages: parts, reasoning: String(parsed.reasoning ?? "") };
    }
  } catch {
    /* fall through to plain-text handling */
  }
  // Model ignored the JSON format — treat its whole output as one reply.
  const plain = normalizeReplyParts([res.content], maxParts);
  if (!plain.length) throw new Error("Draft stage returned an empty reply");
  return { messages: plain, reasoning: "Free-form output — sent as-is" };
}

// ---------------------------------------------------------------------------
// Stage: self-critique & revise
// ---------------------------------------------------------------------------
export async function critiqueAndRevise(
  ctx: AgentContext,
  intent: IntentAnalysis,
  draft: DraftResult,
): Promise<CritiqueResult> {
  const maxParts = ctx.settings.agent_config?.max_reply_parts ?? 3;
  const approved: CritiqueResult = {
    verdict: "approve",
    issues: [],
    messages: draft.messages,
    reasoning: "",
  };
  if (ctx.settings.agent_config?.skip_critique) return approved;

  const system = `אתה עורך איכות קפדן של תשובות וואטסאפ עסקיות. בדוק את הטיוטה מול הקריטריונים והחזר JSON בלבד:
{"verdict": "approve" או "revise", "issues": ["issue found, in English", ...], "messages": ["הגרסה הסופית של כל הודעה", ...], "reasoning": "one sentence in English"}

קריטריונים (כל כשל = revise עם תיקון):
1. שפה: התשובה חייבת להיות בשפה ${intent.language} בלבד.
2. דיוק: עובדות עסקיות (מחירים, מדיניות, מוצרים, לינקים) מותרות אך ורק אם הן מופיעות במאגר הידע המצורף או בהקשר השיחה. אם הטיוטה ממציאה — החלף בניסוח כן ("אבדוק ואחזור אליך").
3. מקדם את המטרה: "${intent.goal}".
4. טון: מקצועי, חם וטבעי לוואטסאפ; בלי פתיחים רובוטיים; אורך סביר (לא חומת טקסט).
5. זהות: אסור כל רמז לבוט/AI/מערכת. אסור גם להצהיר "אני בן אדם".
6. בטיחות: אין חשיפת פרטים טכניים/סודות/מידע על אחרים.
- עד ${maxParts} הודעות. אם verdict=approve החזר את ההודעות כמו שהן.`;

  const user = `הקשר — ההודעה האחרונה של הלקוח (${ctx.message.senderName || "לקוח"}):
"""${ctx.message.body.slice(0, 800)}"""

היסטוריה אחרונה:
${condensedHistory(ctx, 8) || "(שיחה חדשה)"}

מאגר הידע המאומת (המקור היחיד המותר לעובדות עסקיות):
${ctx.kb?.block || "(ריק — אסור לציין שום עובדה עסקית ספציפית)"}

הטיוטה לבדיקה:
${draft.messages.map((m, i) => `[${i + 1}] ${m}`).join("\n")}`;

  try {
    const res = await callLLM({
      role: "strong",
      source: "agent_critique",
      json: true,
      overrides: overridesOf(ctx),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = parseJsonLoose<Partial<CritiqueResult>>(res.content);
    const revised = Array.isArray(parsed.messages)
      ? normalizeReplyParts(
          parsed.messages.map((m) => String(m ?? "")),
          maxParts,
        )
      : [];
    return {
      verdict: parsed.verdict === "revise" ? "revise" : "approve",
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => String(i)) : [],
      messages: revised.length ? revised : draft.messages,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch (e) {
    // Critique must never block a send — fall back to the draft.
    console.warn("[agent] critique failed, sending draft:", String((e as Error)?.message ?? e));
    return approved;
  }
}

// ---------------------------------------------------------------------------
// Persona safety net on the final parts (deterministic, no extra LLM call in
// the common case).
// ---------------------------------------------------------------------------
export function sanitizeParts(parts: string[]): { parts: string[]; leaked: boolean } {
  let leaked = false;
  const out = parts
    .map((p) => {
      if (!leaksPersona(p)) return p;
      leaked = true;
      return stripLeakSentences(p);
    })
    .filter(Boolean);
  return { parts: out.length ? out : [PERSONA_FALLBACK_LINE], leaked };
}
