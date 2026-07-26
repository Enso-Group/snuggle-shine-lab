// Reasoning stages: intent analysis (fast model) → draft (strong model, with
// the quality rules baked into its prompt) → optional consolidation when newer
// messages arrived mid-draft. ONE strong call per reply: the old separate
// critique stage cost a second strong call (7–8s per cycle, measured live)
// and its checks now live inside the draft prompt — the deterministic gates
// (sanitizeParts + stripStructuredOutput) still run on every output.
import { callLLM, parseJsonLoose } from "@/lib/llm.server";
import type { LLMModelOverrides } from "@/lib/llm.server";
import { gapDescription, isSignificantGap } from "./conversation-gap";
import { looksLikeStructuredOutput, normalizeReplyParts } from "./inbound";
import { buildGroundingRules } from "./kb.server";
import { groupPromptBlock } from "./groups.server";
import { personPromptBlock } from "./people.server";
import { leaksPersona, stripLeakSentences, PERSONA_FALLBACK_LINE } from "./persona";
import { buildHumanizeRules, buildDateContext } from "./prompts.server";
import type { AgentContext, DraftResult, IntentAnalysis } from "./types";

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
    context_relation: "continuation",
    context_reason: null,
  };

  // DM after a real gap: same fast-model call also judges whether the message
  // continues the earlier thread or opens a new topic (content + gap, never
  // gap alone).
  const judgeGap =
    !ctx.message.isGroup && ctx.history.length > 0 && isSignificantGap(ctx.gapSinceLastMs);
  const gapText = judgeGap ? gapDescription(ctx.gapSinceLastMs!) : "";

  const system = `אתה מנתח הודעות נכנסות בוואטסאפ עבור צוות עסקי. נתח את ההודעה האחרונה בהקשר השיחה והחזר JSON בלבד, בלי טקסט נוסף, במבנה:
{"intent": "מה האדם באמת רוצה, במשפט קצר", "language": "קוד שפה של ההודעה האחרונה: he/en/ru/ar/...", "urgency": "low/normal/high", "sentiment": "מצב רגשי במילה-שתיים", "goal": "מה איש מקצוע מצטיין היה מנסה להשיג בתשובה הזו", "escalate": true/false, "escalate_reason": "אם escalate=true — סיבה קצרה, אחרת null"${judgeGap ? `, "context_relation": "continuation" או "fresh", "context_reason": "short English reason"` : ""}}
escalate=true רק אם יש איום משפטי, דרישת החזר כספי, נושא רגיש/משברי, או בקשה מפורשת לדבר עם בן אדם.${
    judgeGap
      ? `
context_relation — ההודעה החדשה הגיעה אחרי הפסקה של ${gapText}. שפוט לפי התוכן וההפסקה יחד:
- "continuation": ההודעה מתייחסת לשיחה הקודמת — תשובה לשאלה ששאלנו, המשך עניין ("כן, תעשה את זה", "אז מה סגרנו?"), שאלת המשך על אותו נושא. הפסקה ארוכה לבדה אינה סיבה ל-fresh אם התוכן ממשיך את השיחה.
- "fresh": נושא חדש שאינו קשור לשיחה הקודמת, או פתיחה כללית ("היי, מה שלומך?") שההקשר הישן רק יבלבל בה. במקרה כזה אל נגרור את הנושא הישן לתשובה.`
      : ""
  }
חשוב: כתוב את הערכים של intent / sentiment / goal / escalate_reason${judgeGap ? " / context_reason" : ""} באנגלית (הם מוצגים בלוח בקרה באנגלית). שדה language נשאר קוד שפה.`;

  const user = `היסטוריה אחרונה:
${condensedHistory(ctx, 10) || "(שיחה חדשה)"}
${judgeGap ? `\n(עברו ${gapText} מאז ההודעה האחרונה בשיחה)\n` : ""}
ההודעה החדשה מאת ${ctx.message.senderName || "לא ידוע"}:
"""${ctx.message.body.slice(0, 1000)}"""`;

  try {
    const res = await callLLM({
      role: "fast",
      source: "agent_intent",
      json: true,
      overrides: overridesOf(ctx),
      // Budget-clamped: the reply SLA is 90s and the runtime kills the request
      // after ~60s of wall — an unbudgeted retry ladder here would eat the
      // draft stage's time. Intent has a safe fallback, so it gets a small slice.
      timeoutMs: 10_000,
      budgetMs: 12_000,
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
      // Anything but an explicit "fresh" verdict keeps the thread — the safe
      // default when the model omits the field or wasn't asked.
      context_relation: judgeGap && parsed.context_relation === "fresh" ? "fresh" : "continuation",
      context_reason: judgeGap && parsed.context_reason ? String(parsed.context_reason) : null,
    };
  } catch (e) {
    console.warn(
      "[agent] intent analysis failed, using fallback:",
      String((e as Error)?.message ?? e),
    );
    return fallback;
  }
}

/**
 * Parse a strong-model reply envelope into sendable parts. Shared by
 * draftReply and consolidateReply so neither can ever surface the raw JSON
 * envelope — or its English "reasoning" field — to a user.
 */
function parseReplyEnvelope(content: string, maxParts: number, stage: string): DraftResult {
  try {
    const parsed = parseJsonLoose<{
      messages?: unknown;
      reasoning?: unknown;
      open_question?: unknown;
      image_request?: unknown;
    }>(content);
    const parts = Array.isArray(parsed.messages)
      ? normalizeReplyParts(
          parsed.messages.map((m) => String(m ?? "")),
          maxParts,
        )
      : [];
    if (parts.length) {
      // Only the strings inside "messages" are ever returned as reply text;
      // "reasoning", "open_question" and "image_request" stay internal
      // (decision log / research job / image generation) and are never
      // delivered as text.
      const openQuestion =
        typeof parsed.open_question === "string" && parsed.open_question.trim()
          ? parsed.open_question.trim().slice(0, 400)
          : null;
      const imageRequest =
        typeof parsed.image_request === "string" && parsed.image_request.trim()
          ? parsed.image_request.trim().slice(0, 1500)
          : null;
      return {
        messages: parts,
        reasoning: String(parsed.reasoning ?? ""),
        openQuestion,
        imageRequest,
      };
    }
    // Parsed as JSON but without a usable "messages" array: this is the raw
    // envelope, not a reply. Fall through to the leak guard below.
    throw new Error(`${stage} output had no usable messages array`);
  } catch {
    // The output could not be turned into a clean reply. NEVER fall back to
    // sending the raw model output when it is (or resembles) a JSON envelope —
    // that is exactly how the `{"messages":[...],"reasoning":"..."}` blob and
    // the English reasoning field leaked to users. Fail the stage instead so
    // the queue retries; if it never parses, the never-silent fallbacks take
    // over, which is the correct trade-off vs. leaking JSON.
    if (looksLikeStructuredOutput(content)) {
      throw new Error(
        `${stage} stage returned unparseable structured output — refusing to send raw JSON: ${content.slice(0, 120)}`,
      );
    }
    // Genuinely plain prose (the model ignored the JSON format and just wrote a
    // reply) is safe to send as-is.
    const plain = normalizeReplyParts([content], maxParts);
    if (!plain.length) throw new Error(`${stage} stage returned an empty reply`);
    // openQuestion null: the pipeline's deterministic promise detector still
    // scans the sent text, so a free-form "אבדוק ואחזור" is not lost.
    return {
      messages: plain,
      reasoning: "Free-form output — sent as-is",
      openQuestion: null,
      imageRequest: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Stage: draft — the ONE strong call per reply. The quality checks that used
// to be a second strong-model critique pass (language, KB grounding, tone,
// no-AI-tells, length) are rules of THIS prompt now: one call returns final
// parts, which is what keeps the whole cycle inside the 90s reply SLA.
// ---------------------------------------------------------------------------
export async function draftReply(
  ctx: AgentContext,
  intent: IntentAnalysis,
  opts: { timeoutMs?: number; budgetMs?: number; overrides?: LLMModelOverrides } = {},
): Promise<DraftResult> {
  const maxParts = ctx.settings.agent_config?.max_reply_parts ?? 3;

  // Time-gap awareness: on a fresh start the old thread is gone from the
  // history entirely (the pipeline cleared it); on a continuation after a
  // long gap the model should answer knowing hours passed, not as if the
  // last exchange was a minute ago.
  const gapBlock = ctx.freshStart
    ? `

הקשר זמן: ההודעה הגיעה אחרי הפסקה של ${ctx.freshStart.gap} והיא פותחת נושא חדש. התייחס אליה כשיחה חדשה — אל תחזור מיוזמתך לנושא שנדון בעבר.`
    : isSignificantGap(ctx.gapSinceLastMs)
      ? `

הקשר זמן: ההודעה ממשיכה את השיחה הקודמת אחרי הפסקה של ${gapDescription(ctx.gapSinceLastMs!)}. ענה בהמשכיות טבעית, בלי להעמיד פנים שהשיחה קרתה הרגע.`
      : "";

  const system =
    ctx.settings.system_prompt +
    buildHumanizeRules() +
    buildDateContext() +
    groupPromptBlock(ctx.groupProfile) +
    personPromptBlock(ctx.person) +
    buildGroundingRules(ctx.kb ?? { block: "", count: 0 }) +
    gapBlock +
    `

ניתוח ההודעה הנוכחית (שימוש פנימי — אל תצטט אותו):
- כוונה: ${intent.intent}
- שפת התשובה חייבת להיות: ${intent.language}
- דחיפות: ${intent.urgency} | מצב רגשי: ${intent.sentiment}
- המטרה שלך בתשובה: ${intent.goal}

כללי איכות מחייבים (אין שלב בדיקה אחריך — בדוק את עצמך מול כולם לפני שאתה מחזיר):
1. שפה: כל התשובה בשפה ${intent.language} בלבד.
2. דיוק: עובדות עסקיות (מחירים, מדיניות, מוצרים, לינקים) מותרות אך ורק אם הן מופיעות במאגר הידע או בהקשר השיחה. אם אין מקור — אמור בכנות שתבדוק ותחזור, אל תנחש ואל תמציא.
3. מקדם את המטרה: "${intent.goal}".
4. טון: מקצועי, חם וטבעי לוואטסאפ; בלי פתיחים רובוטיים; אורך סביר, לא חומת טקסט.
5. זהות: אסור כל רמז לבוט/AI/מערכת, ואסור גם להצהיר "אני בן אדם".
6. בטיחות: אין חשיפת פרטים טכניים, סודות או מידע על אנשים אחרים.

כלל מחייב — אף פעם לא שתיקה: לעולם אל תחזיר תשובה ריקה. אם ההודעה עוסקת בנושא שמחוץ לתחום שלנו או לידע שלך — ענה בקצרה ובטבעיות, בסגנון הדמות, שעם זה אתה לא יכול לעזור או שאתה פשוט לא יודע, ואם מתאים החזר את השיחה לתחום שלנו. אל תמציא תשובה ואל תשאיר את האדם בלי מענה.

פורמט פלט (חובה): החזר JSON בלבד במבנה {"messages": ["הודעה 1", "הודעה 2..."], "reasoning": "one short sentence in English on why this is the right reply", "open_question": null או "שאילתת חיפוש", "image_request": null או "english image prompt"}.
- בין 1 ל-${maxParts} הודעות, כמו שאדם כותב בוואטסאפ: קצרות, בלי חומות טקסט.
- ברוב המקרים הודעה אחת מספיקה. פצל רק אם יש באמת שני חלקים נפרדים (למשל תשובה + שאלת המשך).
- open_question: אם התשובה שלך מבטיחה לבדוק ולחזור (כי התשובה העובדתית לא נמצאת במאגר הידע או בשיחה) — כתוב כאן שאילתת חיפוש קצרה וממוקדת שתמצא את התשובה, בשפה שבה סביר שהמידע קיים ברשת. אם לא הבטחת לבדוק — null.
- image_request: אם האדם מבקש שתיצור/תכין/תשלח תמונה — יש לך יכולת אמיתית ליצור תמונות, והתמונה תישלח אליו מיד עם ההודעה. אל תתאר במילים איך התמונה תיראה, אל תשלח "פרומפט" כטקסט, ואל תבטיח "אכין בהמשך". כתוב ב-messages כיתוב קצר וטבעי אחד (משפט, כמו שאדם שולח תמונה עם הערה), ומלא כאן פרומפט תמונה מלא באנגלית: נושא, קומפוזיציה, סגנון, תאורה; בלי טקסט/אותיות בתוך התמונה. מותר לכל היותר שאלת הבהרה אחת ורק אם באמת חסר פרט קריטי — אחרת פשוט צור. אם לא ביקש תמונה — null.`;

  const messages = [
    { role: "system" as const, content: system },
    ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: ctx.message.body },
  ];

  const res = await callLLM({
    role: "strong",
    source: "agent_draft",
    json: true,
    // Retry attempts pass their own overrides to lead with the chain tail —
    // the pinned strong model already proved degraded on this thread.
    overrides: opts.overrides ?? overridesOf(ctx),
    // The draft gets the biggest slice of the 90s SLA. 15s per attempt (not
    // the 25s default) so a second candidate model gets a real shot inside
    // the budget — the pinned strong model is known to stall on long prompts.
    // Retry attempts pass tighter budgets: the whole attempt must fit the
    // ~60s request wall or it dies with no catch path (live 2026-07-25).
    timeoutMs: opts.timeoutMs ?? 15_000,
    budgetMs: opts.budgetMs ?? 25_000,
    messages,
  });

  return parseReplyEnvelope(res.content, maxParts, "Draft");
}

// ---------------------------------------------------------------------------
// Stage: consolidation — newer messages arrived while the reply was being
// drafted. One bounded strong call folds them into the already-drafted parts,
// instead of the old "superseded" restart that made the newest message's job
// redo intent+draft from scratch (measured live: intent ran 3x for one reply).
// ---------------------------------------------------------------------------

/** A message that arrived after the one this job is answering. */
export type NewerInbound = { body: string; senderName: string | null };

export async function consolidateReply(
  ctx: AgentContext,
  intent: IntentAnalysis,
  draftedParts: string[],
  newer: NewerInbound[],
): Promise<DraftResult> {
  const maxParts = ctx.settings.agent_config?.max_reply_parts ?? 3;

  const system =
    ctx.settings.system_prompt +
    buildHumanizeRules() +
    buildDateContext() +
    personPromptBlock(ctx.person) +
    buildGroundingRules(ctx.kb ?? { block: "", count: 0 }) +
    `

מצב: בזמן שכתבת את התשובה שלמטה, האדם שלח הודעות נוספות. כתוב תשובה אחת מעודכנת שמכסה את הכל — אל תענה בנפרד לכל הודעה ואל תתעלם מההודעות החדשות. אם ההודעות החדשות משנות את התמונה, עדכן את התשובה בהתאם.

כללי איכות מחייבים (אין שלב בדיקה אחריך): כל התשובה בשפה ${intent.language} בלבד; עובדות עסקיות רק ממאגר הידע או מהשיחה; טון טבעי לוואטסאפ בלי פתיחים רובוטיים; אסור כל רמז לבוט/AI/מערכת; לעולם לא תשובה ריקה.

פורמט פלט (חובה): החזר JSON בלבד במבנה {"messages": ["הודעה 1", ...], "reasoning": "one short sentence in English", "open_question": null או "שאילתת חיפוש אם הבטחת לבדוק ולחזור", "image_request": null או "english image prompt אם ביקשו ממך ליצור תמונה — ההודעות הן אז כיתוב קצר לתמונה"}.
- בין 1 ל-${maxParts} הודעות קצרות וטבעיות.`;

  const user = `היסטוריה אחרונה:
${condensedHistory(ctx, 8) || "(שיחה חדשה)"}

ההודעה שעליה התחלת לענות:
"""${ctx.message.body.slice(0, 800)}"""

הטיוטה שכתבת (טרם נשלחה):
${draftedParts.map((m, i) => `[${i + 1}] ${m}`).join("\n")}

ההודעות החדשות שהגיעו בינתיים:
${newer.map((n) => `${n.senderName || "הלקוח"}: ${n.body.slice(0, 500)}`).join("\n")}`;

  const res = await callLLM({
    role: "strong",
    source: "agent_consolidate",
    json: true,
    overrides: overridesOf(ctx),
    // Runs at the tail of the cycle, after the draft already spent its slice —
    // a tight budget keeps the worst case inside the 90s SLA and the ~60s
    // request wall. On failure the pipeline falls back to the old superseded
    // return, so the newest pending job still answers.
    timeoutMs: 12_000,
    budgetMs: 15_000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return parseReplyEnvelope(res.content, maxParts, "Consolidation");
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

// ---------------------------------------------------------------------------
// Never-silent fallback (DMs only): when the normal draft path produced
// nothing sendable, the pipeline asks for ONE short in-persona "can't help
// with that" line instead of going quiet on the contact.
// ---------------------------------------------------------------------------

/** Canned "can't help" line for when even the fallback LLM call fails. */
export const CANT_HELP_FALLBACK_LINE = "סליחה, לא בטוח שהבנתי — עם זה אני לא יכול לעזור 🙈";

/**
 * Validate a candidate fallback line: one short line, no JSON envelope, no
 * persona leak. Returns null when unusable so the caller substitutes the
 * fixed line. Pure — unit-tested directly.
 */
export function safeFallbackLine(raw: string | null | undefined): string | null {
  const line = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!line || line.length > 200) return null;
  if (looksLikeStructuredOutput(line) || leaksPersona(line)) return null;
  return line;
}

/**
 * One bounded fast-model shot for a natural "can't help with that right now"
 * sentence in the conversation's language. Runs at the END of an already-long
 * request, so it must never buy quality with time; any failure falls back to
 * the fixed Hebrew line.
 */
export async function draftCantHelpLine(ctx: AgentContext, language: string): Promise<string> {
  try {
    const res = await callLLM({
      role: "fast",
      source: "agent_fallback",
      overrides: overridesOf(ctx),
      timeoutMs: 8_000,
      budgetMs: 8_000,
      messages: [
        {
          role: "system",
          content: `${ctx.settings.system_prompt}

כתוב משפט אחד בלבד, קצר וטבעי בסגנון הדמות, בשפה "${language}", שאומר בנימוס שאתה לא יכול לעזור בזה כרגע. בלי JSON, בלי הסברים ובלי מרכאות — רק המשפט עצמו.`,
        },
        { role: "user", content: ctx.message.body.slice(0, 500) },
      ],
    });
    return safeFallbackLine(res.content) ?? CANT_HELP_FALLBACK_LINE;
  } catch {
    return CANT_HELP_FALLBACK_LINE;
  }
}
