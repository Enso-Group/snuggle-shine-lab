// Pure helpers for the research-promise flow ("I'll check and get back to
// you"). Detection, deadline math, payload shape, interim lines and the
// prompt block are all here so they can be unit-tested without I/O; the job
// engine lives in research.server.ts.
import type { XSearchOutcome } from "@/lib/apify-x.server";
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
  /**
   * Search results cached the moment the search succeeds, so a wall-killed
   * attempt's retry resumes at the draft instead of paying for the search
   * again (live 2026-07-25: attempts cost ~50-60s and died at the ~60s wall).
   */
  search_results?: TavilySearchOutcome | null;
  /**
   * Twitter/X results (Apify) cached like search_results — retries reuse them
   * instead of paying for another scraper run.
   */
  x_results?: XSearchOutcome | null;
  /** Set when the watchdog revived a failed job for one cheap final attempt. */
  revived?: boolean;
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
      search_results:
        p.search_results && typeof p.search_results === "object"
          ? {
              answer: typeof p.search_results.answer === "string" ? p.search_results.answer : null,
              results: Array.isArray(p.search_results.results) ? p.search_results.results : [],
            }
          : null,
      x_results:
        p.x_results && typeof p.x_results === "object"
          ? { results: Array.isArray(p.x_results.results) ? p.x_results.results : [] }
          : null,
      revived: p.revived === true,
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
  // Hebrew: "I'll send you / find you"
  new RegExp(`${HB}(אשלח|נשלח)\\s+(לך|לכם|אליך|בהמשך|בהקדם|את)`),
  new RegExp(`${HB}(אמצא|נמצא)\\s+(לך|לכם|עבורך)`),
  // English
  /\bi(?:'|’)?ll (?:check|verify|look into|look up|find out|find|ask|send|share|get)\b/i,
  /\bi will (?:check|verify|look into|look up|find out|find|ask|send|share|get)\b/i,
  /\blet me (?:check|verify|look into|look up|find out|find)\b/i,
  /\bwill (?:send|share|find|have) (?:it|that|one|some|the|a|you)\b/i,
  /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are) (?:on it|looking (?:it |that |this )?up|working on (?:it|that|this))\b/i,
  /\bcurrently looking\b/i,
  /\bas soon as (?:i|we) (?:have|find|know|get)\b/i,
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

// Holding line for an ESCALATED DM: the drafted reply parked in Approvals,
// but the contact must hear something now — a human-sounding "I'm on it".
const HOLDING_LINES: Record<string, string> = {
  he: "קיבלתי — אני בודק את זה לעומק ואחזור אליך עם תשובה מסודרת 🙏",
  en: "Got it — let me look into this properly and I'll get back to you with a full answer.",
  ru: "Понял — разберусь с этим как следует и вернусь к вам с полным ответом.",
  ar: "استلمت — سأبحث في الأمر جيدًا وأعود إليك بإجابة وافية.",
};

export function holdingLineFor(language: string | null | undefined): string {
  const code = (language ?? "he").toLowerCase().slice(0, 2);
  return HOLDING_LINES[code] ?? HOLDING_LINES.en;
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

כללי שימוש בתוצאות: הסתמך רק על מה שמופיע כאן או במאגר הידע. אל תמציא פרטים מעבר לזה, ואל תזכיר שביצעת "חיפוש" — פשוט תן את התשובה כמו מישהו שבדק את הנושא. אסור סימוני מקור כמו [1].
כלל קישורים (חשוב): ההבטחה הייתה לחזור עם משהו קונקרטי. אם הלקוח ביקש קישור, דוח, מאמר, מדריך, סרטון או כל משאב — חובה לכלול בתשובה את כתובת ה-URL המלאה של התוצאה המתאימה ביותר מלמעלה, מועתקת אות-באות (לעולם אל תמציא כתובת ואל תקצר אותה). גם כשלא ביקש קישור במפורש, אם התשובה נשענת על מקור מרכזי אחד — צרף את הקישור שלו בסוף ההודעה האחרונה. אסור לסיים בהבטחה נוספת כמו "אשלח לך קישור" — הקישור נשלח עכשיו או שאין קישור.`;
}

/**
 * Prompt block for live Twitter/X results (Apify). Kept separate from the web
 * block so each carries its own usage rules: X is the "what people are saying
 * RIGHT NOW" source — takes, reactions, fresh links — never the source of
 * record for hard facts.
 */
export function buildXBlock(x: XSearchOutcome | null): string {
  if (!x || !x.results.length) return "";
  const tweets = x.results
    .slice(0, 5)
    .map((t) => {
      const when = t.date ? ` · ${String(t.date).slice(0, 10)}` : "";
      const engagement =
        t.likes != null || t.retweets != null
          ? ` · ${t.likes ?? 0} likes, ${t.retweets ?? 0} reposts`
          : "";
      return `- ${t.author}${when}${engagement}\n  "${t.text.slice(0, 280)}"\n  ${t.url}`;
    })
    .join("\n");
  return `

ציוצים עדכניים מ-X/טוויטר על הנושא (מה אנשים אומרים עכשיו):
${tweets}

כללי שימוש בציוצים: אלה דעות ותגובות של אנשים — השתמש בהם כדי לשקף "מה מדברים עליו עכשיו", טרנדים ותחושות, לא כמקור לעובדות קשות (עובדות רק מתוצאות החיפוש או ממאגר הידע). מותר לשתף קישור לציוץ רק אם הוא מופיע ברשימה למעלה, מועתק במדויק. אל תזכיר "טוויטר סרוק" או איך השגת את זה — פשוט "ראיתי ש..." כמו מישהו שמעודכן.`;
}

// ---------------------------------------------------------------------------
// Resource-request detection — when the contact asked for a THING (a link, a
// report, an article), the answer must physically contain a URL. Used both in
// the answer prompt and as a deterministic post-draft net that appends the
// top search result when the model still returned prose-only.
// ---------------------------------------------------------------------------
const RESOURCE_REQUEST_PATTERNS: RegExp[] = [
  // Hebrew: link / report / article / guide / study / document / video / file
  new RegExp(`${HB}(קישור|לינק|דוח|דו"ח|מאמר|כתבה|מדריך|מחקר|מסמך|סרטון|קובץ|מצגת)`),
  // Hebrew: "send me / share / where can I find"
  new RegExp(`${HB}(תשלח|שלח|תעביר|העבר|תשתף|שתף)\\s`),
  new RegExp(`${HB}איפה\\s+(אפשר|ניתן|מוצאים|אני)`),
  // English
  /\b(link|report|article|guide|study|paper|pdf|resource|whitepaper|video|doc|document|presentation)\b/i,
  /\b(send|share|forward)\s+(me|it|us|the|a)\b/i,
  /\bwhere (can|do) i (find|get|read|download)\b/i,
];

/** True when the text reads as a request for a concrete resource/link. */
export function detectsResourceRequest(text: string): boolean {
  if (!text) return false;
  return RESOURCE_REQUEST_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Honesty guard — promises of actions the bot has NO machinery for. Its real
// abilities are: replying in THIS chat, generating an image, researching the
// web and getting back (both tracked). Anything else — posting/replying in
// groups or other chats, messaging other people, booking/arranging things —
// is a fake commitment that will silently never happen (live 2026-07-26: the
// bot told a contact it would reply in a specific group). Deterministic net
// behind the prompt rules; matches stay narrow so backed promises ("אבדוק
// ואחזור", "אשלח לך") are never flagged.
// ---------------------------------------------------------------------------
const UNBACKED_ACTION_PATTERNS: RegExp[] = [
  // Hebrew: "I'll post/write/share/reply/send ... in/to a group"
  new RegExp(
    `${HB}(אפרסם|אעלה|אשתף|אכתוב|אגיב|אענה|אשלח|אעביר)[^.!?\\n]{0,40}(בקבוצה|לקבוצה|בקבוצת|לקבוצת)`,
  ),
  // Hebrew: "I'll send/forward/write to him/her/them" (never "לך" — sending
  // to the person in this chat is a real, backed ability)
  new RegExp(`${HB}(אשלח|אעביר|אכתוב|אמסור)\\s+(לו|לה|להם|לו את|לה את)($|[^\\u05d0-\\u05ea])`),
  // Hebrew: "I'll talk to / coordinate with / update <someone>"
  new RegExp(`${HB}(אדבר|אתאם|אסתדר)\\s+(עם|מול)`),
  new RegExp(`${HB}אעדכן\\s+(אותו|אותה|אותם|את\\s+[א-ת])`),
  // English
  /\bi(?:'|’)?ll (?:post|publish|share|reply|respond|write|send)\b[^.!?\n]{0,40}\b(?:in|to|on) (?:the |that |your )?group\b/i,
  /\bi(?:'|’)?ll (?:message|text|contact|talk to|tell|update) (?:him|her|them)\b/i,
];

/**
 * True when reply text promises an action outside the bot's real abilities —
 * the class of promise that must be rewritten to an honest "can't do that".
 */
export function detectsUnbackedActionPromise(text: string): boolean {
  if (!text) return false;
  return UNBACKED_ACTION_PATTERNS.some((re) => re.test(text));
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
