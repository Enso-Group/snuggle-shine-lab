// Pure helpers for the research-promise flow ("I'll check and get back to
// you"). Detection, deadline math, payload shape, interim lines and the
// prompt block are all here so they can be unit-tested without I/O; the job
// engine lives in research.server.ts.
import type { TavilySearchOutcome } from "@/lib/tavily.server";

export const RESEARCH_JOB_KIND = "research_answer";

/** Hard product cap: the answer must land within 10 minutes of the promise. */
export const RESEARCH_DEADLINE_MS = 10 * 60_000;

/**
 * When no answer has been sent by this point after the promise, an interim
 * update goes out instead of silence. 7.5 min leaves the every-minute
 * watchdog sweep plus delivery pacing comfortably inside the 10-min cap.
 */
export const RESEARCH_INTERIM_AFTER_MS = 7 * 60_000 + 30_000;

export type ResearchJobPayload = {
  /** Search query / open question the reply promised to check. */
  question: string;
  /** Epoch ms when the promise was delivered to the contact. */
  promised_at: number;
  /** Epoch ms by which the answer must be sent (promised_at + 10 min). */
  deadline_at: number;
  /** Reply language from the intent stage (he/en/...). */
  language: string;
  person_wa_id: string | null;
  /** The contact's message that triggered the promise. */
  source_body: string;
  /** What we sent (the promise text) — context for the answer draft. */
  promise_text: string;
  /** Set once the interim "taking longer" update was sent. */
  interim_sent?: boolean;
  /** Drafted answer cached across attempts (e.g. a min-gap deferral). */
  answer_parts?: string[];
  /** Set once the no-material admin alert fired — it must fire exactly once. */
  escalated_alerted?: boolean;
  /** Approval-mode: set once the answer was queued for approval. */
  approval_queued?: boolean;
  /** Approval-mode: id of the scheduled_approvals row holding the answer. */
  approval_id?: string | null;
};

/**
 * Build the payload for a fresh promise. Question falls back to the
 * contact's own message when the model didn't articulate one.
 */
export function buildResearchPayload(args: {
  question: string | null;
  promisedAtMs: number;
  language: string;
  personWaId: string | null;
  sourceBody: string;
  promiseText: string;
}): ResearchJobPayload {
  const question = (args.question ?? "").trim() || args.sourceBody.trim();
  return {
    question: question.slice(0, 400),
    promised_at: args.promisedAtMs,
    deadline_at: args.promisedAtMs + RESEARCH_DEADLINE_MS,
    language: args.language || "he",
    person_wa_id: args.personWaId,
    source_body: args.sourceBody.slice(0, 800),
    promise_text: args.promiseText.slice(0, 500),
  };
}

/**
 * bot_jobs.payload is jsonb and may surface as an object or a JSON string
 * depending on the client path — parsed here, never trusted raw.
 */
export function parseResearchPayload(raw: unknown): ResearchJobPayload | null {
  try {
    const p = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<ResearchJobPayload>;
    if (!p || typeof p !== "object") return null;
    const question = String(p.question ?? "").trim();
    const promisedAt = Number(p.promised_at);
    const deadlineAt = Number(p.deadline_at);
    if (!question || !Number.isFinite(promisedAt) || !Number.isFinite(deadlineAt)) return null;
    return {
      question,
      promised_at: promisedAt,
      deadline_at: deadlineAt,
      language: String(p.language ?? "he") || "he",
      person_wa_id: p.person_wa_id ? String(p.person_wa_id) : null,
      source_body: String(p.source_body ?? ""),
      promise_text: String(p.promise_text ?? ""),
      interim_sent: p.interim_sent === true,
      answer_parts: Array.isArray(p.answer_parts)
        ? p.answer_parts.map((x) => String(x)).filter(Boolean)
        : undefined,
      escalated_alerted: p.escalated_alerted === true,
      approval_queued: p.approval_queued === true,
      approval_id: p.approval_id ? String(p.approval_id) : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Promise detection — deterministic safety net behind the model's own
// open_question flag. NOTE: JS \b is ASCII-only and never matches next to
// Hebrew letters, so Hebrew patterns use explicit not-a-Hebrew-letter
// boundaries (the third time this repo learned that lesson).
// ---------------------------------------------------------------------------
const HB = "(^|[^\\u05d0-\\u05ea])"; // Hebrew-safe left boundary
const CHECK_BACK_PATTERNS: RegExp[] = [
  // Hebrew: "I'll check / find out"
  new RegExp(`${HB}(אבדוק|נבדוק|אברר|נברר)($|[^\\u05d0-\\u05ea])`),
  // Hebrew: "I'll get back to you / with an answer"
  new RegExp(`${HB}(אחזור|נחזור)\\s+(אליך|אלייך|אליכם|אליכן|עם\\s+תשובה|בהקדם)`),
  // Hebrew: "I'll update you"
  new RegExp(`${HB}(אעדכן|נעדכן)\\s+(אותך|אותכם|אתכם|בהמשך|בהקדם)`),
  // Hebrew: "checking it / on it and getting back"
  new RegExp(`${HB}(בודקת?|מבררת?)\\s+(את\\s+זה|ואחזור|ונחזור|לגבי)`),
  // English
  /\bi(?:'|’)?ll (?:check|verify|look into|find out|ask)\b/i,
  /\bi will (?:check|verify|look into|find out|ask)\b/i,
  /\blet me (?:check|verify|look into|find out)\b/i,
  /\b(?:will\s+)?get back to you\b/i,
  /\bwill get back\b/i,
  /\bcircle back\b/i,
];

/** True when reply text reads as a "I'll check and get back to you" promise. */
export function detectsCheckBackPromise(text: string): boolean {
  if (!text) return false;
  return CHECK_BACK_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Interim update — deliberately canned, no LLM: it also fires on paths where
// the LLM is exactly what failed. Both lines are persona-safe (checked
// against the leak patterns in tests).
// ---------------------------------------------------------------------------
const INTERIM_LINES: Record<string, string> = {
  he: "עדיין בודק את זה — לוקח קצת יותר זמן מהצפוי 🙏 אחזור אליך עם תשובה בהקדם.",
  en: "Still checking on this — it's taking a bit longer than expected. I'll get back to you shortly.",
  ru: "Всё ещё уточняю — это занимает немного больше времени, чем ожидалось. Скоро вернусь с ответом.",
  ar: "ما زلت أتحقق من الأمر — يستغرق وقتًا أطول قليلًا من المتوقع. سأعود إليك بالإجابة قريبًا.",
};

export function interimLineFor(language: string | null | undefined): string {
  const code = (language ?? "he").toLowerCase().slice(0, 2);
  return INTERIM_LINES[code] ?? INTERIM_LINES.en;
}

/**
 * Should the watchdog send an interim update for this job now? True once the
 * interim threshold passed and neither an interim nor an answer went out.
 */
export function researchNeedsInterim(payload: ResearchJobPayload, nowMs: number): boolean {
  if (payload.interim_sent) return false;
  return nowMs >= payload.promised_at + RESEARCH_INTERIM_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Research-results prompt block for the answer draft.
// ---------------------------------------------------------------------------
export function buildResearchBlock(search: TavilySearchOutcome | null): string {
  if (!search || (!search.answer && !search.results.length)) return "";
  const results = search.results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content.slice(0, 600)}`)
    .join("\n\n");
  return `

תוצאות חיפוש עדכניות מהאינטרנט (המקור לעובדות בתשובה הזו):
${search.answer ? `סיכום אוטומטי של תוצאות החיפוש: ${search.answer}\n\n` : ""}${results}

כללי שימוש בתוצאות: הסתמך רק על מה שמופיע כאן או במאגר הידע. אל תמציא פרטים מעבר לזה, ואל תזכיר שביצעת "חיפוש" — פשוט תן את התשובה כמו מישהו שבדק את הנושא. אסור לכלול בתשובה סימוני מקור כמו [1] או כתובות URL מהתוצאות — שתף קישור רק אם הקישור עצמו הוא מה שהלקוח ביקש.`;
}

/**
 * Strip "[1]"-style citation markers a model sometimes copies from numbered
 * search results — they read as machine output in a WhatsApp chat.
 */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/\s*\[\d{1,2}\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
