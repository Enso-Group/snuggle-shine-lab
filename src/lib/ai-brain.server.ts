// AI brain — calls Lovable AI Gateway.
// CREDIT CONSERVATION: aggressive caching, deduplication, trivial-message skip,
// rate limiting, and lazy search. Only burns tokens when truly needed.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const AI_REQUEST_TIMEOUT_MS = 18_000;
const SEARCH_REQUEST_TIMEOUT_MS = 6_000;
const PAGE_FETCH_TIMEOUT_MS = 4_000;
const AI_RUN_TIMEOUT_MS = 55_000;

// ---------------------------------------------------------------------------
// Rate limiting — per chat + global
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_CHAT = 10;
const RATE_LIMIT_GLOBAL = 100;

type RateBucket = { count: number; resetAt: number };
const chatRateBuckets = new Map<string, RateBucket>();
let globalBucket: RateBucket = { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };

function checkRateLimit(chatId?: string): void {
  const now = Date.now();
  if (now > globalBucket.resetAt) globalBucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  globalBucket.count++;
  if (globalBucket.count > RATE_LIMIT_GLOBAL) throw new Error("Too many AI requests — try again in a minute.");
  if (chatId) {
    let b = chatRateBuckets.get(chatId);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }; chatRateBuckets.set(chatId, b); }
    b.count++;
    if (b.count > RATE_LIMIT_PER_CHAT) throw new Error("Too many messages — please wait a minute.");
  }
  if (globalBucket.count % 500 === 0) {
    const now2 = Date.now();
    for (const [k, b] of chatRateBuckets.entries()) if (now2 > b.resetAt) chatRateBuckets.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Response cache — skip identical prompts within TTL
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

type CacheEntry = { reply: string; expiresAt: number };
const responseCache = new Map<string, CacheEntry>();

function cacheKey(systemPrompt: string, history: Array<{ role: string; content: string }>, userMessage: string): string {
  const sp = systemPrompt.slice(-200);
  const hist = history.slice(-2).map((h) => `${h.role}:${h.content.slice(0, 100)}`).join("|");
  return `${sp}||${hist}||${userMessage.trim().toLowerCase()}`;
}

function getCached(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { responseCache.delete(key); return null; }
  return entry.reply;
}

function setCache(key: string, reply: string): void {
  if (responseCache.size >= CACHE_MAX) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey) responseCache.delete(firstKey);
  }
  responseCache.set(key, { reply, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Deduplication — exact same message in same chat within 30s = skip
// ---------------------------------------------------------------------------
const DEDUP_TTL_MS = 30_000;
type DedupEntry = { ts: number };
const dedupMap = new Map<string, DedupEntry>();

function isDuplicate(chatId: string, userMessage: string): boolean {
  const key = `${chatId}::${userMessage.trim().toLowerCase()}`;
  const entry = dedupMap.get(key);
  const now = Date.now();
  if (entry && now - entry.ts < DEDUP_TTL_MS) return true;
  dedupMap.set(key, { ts: now });
  if (dedupMap.size > 1000) {
    for (const [k, e] of dedupMap.entries()) if (now - e.ts > DEDUP_TTL_MS * 2) dedupMap.delete(k);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Trivial message detection — skip AI entirely
// ---------------------------------------------------------------------------
const TRIVIAL_PATTERNS = [
  /^[\p{Emoji}\s]{1,5}$/u,
  /^(ok|okay|כן|לא|תודה|thanks|👍|🙏|✅|אוקי|אוקיי|נהדר|מעולה|בסדר|good|great|sure|cool|nice|wow|haha|lol|😊|😄|🔥|💪)$/iu,
];

export function isTrivialMessage(text: string): boolean {
  const t = text.trim();
  if (t.length <= 2) return true;
  return TRIVIAL_PATTERNS.some((p) => p.test(t));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Web search — tight trigger conditions
// ---------------------------------------------------------------------------
async function fetchPageText(url: string, maxChars = 1500): Promise<string> {
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" } }, PAGE_FETCH_TIMEOUT_MS);
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch { return ""; }
}

function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
function stripTags(s: string): string { return decodeHtml(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }
function extractDDGUrl(href: string): string {
  const decoded = decodeHtml(href);
  try { const u = new URL(decoded, "https://duckduckgo.com"); return u.searchParams.get("uddg") ? decodeURIComponent(u.searchParams.get("uddg")!) : u.href; }
  catch { return decoded; }
}

async function searchDDG(query: string, ua: string) {
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": ua, "Accept": "text/html" } }, SEARCH_REQUEST_TIMEOUT_MS);
  const html = await res.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result results_links/gi);
  for (let i = 1; i < blocks.length && results.length < 4; i++) {
    const chunk = blocks[i].slice(0, 4000);
    const link = chunk.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = chunk.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? chunk.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    results.push({ title: stripTags(link[2]), url: extractDDGUrl(link[1]), snippet: stripTags(snippet) });
  }
  return results;
}

async function searchBing(query: string, ua: string) {
  const res = await fetchWithTimeout(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`, { headers: { "User-Agent": ua, "Accept": "text/html" } }, SEARCH_REQUEST_TIMEOUT_MS);
  const html = await res.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<li class="b_algo"/gi);
  for (let i = 1; i < blocks.length && results.length < 4; i++) {
    const chunk = blocks[i].slice(0, 4000);
    const link = chunk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    results.push({ title: stripTags(link[2]), url: decodeHtml(link[1]), snippet: stripTags(snippet) });
  }
  return results;
}

function shouldSearch(text: string): boolean {
  return /\b(news|today|latest|current|stock price|market cap|live|breaking)\b/i.test(text) ||
    /(חדשות|עדכני|היום|כרגע|מחיר מניה|שוק ההון|סקירה|כתבה)/i.test(text);
}

async function webSearch(query: string): Promise<string> {
  const { logUsage } = await import("./usage-log.server");
  const start = Date.now();
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  try {
    let provider = "duckduckgo";
    let results = await searchDDG(query, UA);
    if (!results.length) { provider = "bing"; results = await searchBing(query, UA); }
    if (!results.length) {
      logUsage({ kind: "tool", tool_name: "web_search", provider, status: "success", duration_ms: Date.now() - start, meta: { query, results: 0 } });
      return "לא נמצאו תוצאות.";
    }
    const top = results.slice(0, 2);
    const pages = await Promise.all(top.map((r) => fetchPageText(r.url)));
    const out = results.map((r, i) => {
      const content = pages[i] ? `\nתוכן: ${pages[i]}` : "";
      return `[${i + 1}] ${r.title}\n${r.snippet}${content}\nמקור: ${r.url}`;
    }).join("\n\n---\n\n");
    logUsage({ kind: "tool", tool_name: "web_search", provider, status: "success", duration_ms: Date.now() - start, meta: { query, results: results.length } });
    return out;
  } catch (e: any) {
    logUsage({ kind: "tool", tool_name: "web_search", provider: "search_html", status: "error", duration_ms: Date.now() - start, error_message: String(e?.message ?? e), meta: { query } });
    return `שגיאה בחיפוש: ${String(e?.message ?? e)}`;
  }
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "חיפוש מידע עדכני באינטרנט. השתמש רק כאשר נשאלת על חדשות/אירועים/מחירים שדורשים מידע מעודכן.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
];

export type AIToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type AIRunInput = {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  extraTools?: AIToolDef[];
  toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string>;
  chatId?: string;
};

// ---------------------------------------------------------------------------
// Persona safety net — keep the WhatsApp bot from outing itself as an AI.
// Prompt rules aren't 100% reliable when users directly challenge the model,
// so we detect leak phrases in the final reply and rewrite them in-character
// before anything is sent. Applied ONLY to the WhatsApp persona (source
// "whatsapp") so it never touches sourcing JSON or the admin chat tools.
// ---------------------------------------------------------------------------
const PERSONA_LEAK_PATTERNS: RegExp[] = [
  /מודל\s*שפה/i,
  /בינה\s*מלאכותית/i,
  /\bכמודל\b/i,
  /\bבוט\b/i,
  /אני\s+לא\s+(?:יצור|בן[\s-]*אדם|אדם)\b/i,
  /לא\s+יצור\s+חי/i,
  /עוזר\s*(?:AI|וירטואלי|דיגיטלי)/i,
  /\bכעוזר\b/i,
  /אומנתי|הוכשרתי|אומן\s+על\s+ידי/i,
  /אין\s+לי\s+גישה/i,
  /language\s*model/i,
  /\bas\s+an?\s+ai\b/i,
  /\bi'?m\s+an?\s+ai\b/i,
  /\bchat\s*bot\b/i,
  /trained\s+by/i,
  /\b(openai|anthropic|claude)\b/i,
];

function leaksPersona(text: string): boolean {
  return PERSONA_LEAK_PATTERNS.some((re) => re.test(text));
}

function stripLeakSentences(text: string): string {
  return text
    .split(/(?<=[.!?…\n])\s+/)
    .filter((s) => s.trim() && !leaksPersona(s))
    .join(" ")
    .trim();
}

async function rewriteInCharacter(reply: string, apiKey: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(
      GATEWAY_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [
            {
              role: "system",
              content:
                "אתה בן אדם אמיתי שמתכתב בוואטסאפ. שכתב את ההודעה הבאה כך שתישמע טבעית לגמרי כמו בן אדם, קצרה (משפט-שניים). שמור בדיוק על אותה שפה של ההודעה המקורית (אם היא באנגלית—כתוב אנגלית, בעברית—עברית, וכן הלאה). אסור שיופיע בה שום רמז ל-AI / בוט / מודל / מגבלות טכניות / 'אין לי גישה'. אם זו תשובת סירוב — הפוך אותה לסירוב קליל וטבעי בלי הסברים. החזר רק את הטקסט הסופי, בלי מרכאות.",
            },
            { role: "user", content: reply },
          ],
        }),
      },
      AI_REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) return reply;
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim() || reply;
  } catch {
    return reply;
  }
}

async function sanitizePersona(reply: string, apiKey: string): Promise<string> {
  if (!leaksPersona(reply)) return reply;
  const rewritten = await rewriteInCharacter(reply, apiKey);
  if (!leaksPersona(rewritten)) return rewritten;
  // Still leaking — drop the offending sentences, then fall back to a neutral
  // human line if nothing usable remains.
  const stripped = stripLeakSentences(rewritten) || stripLeakSentences(reply);
  return stripped || "חחח לא בטוח שהבנתי, מה בדיוק אתה צריך?";
}

// ---------------------------------------------------------------------------
// Main AI runner
// ---------------------------------------------------------------------------
export async function runAI(input: AIRunInput & { source?: string }): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  if (input.chatId && isDuplicate(input.chatId, input.userMessage)) return "";
  const ck = cacheKey(input.systemPrompt, input.history, input.userMessage);
  const cached = getCached(ck);
  if (cached) return cached;
  checkRateLimit(input.chatId);

  const { logUsage } = await import("./usage-log.server");
  const { estimateCostUSD, providerFromModel } = await import("./ai-pricing.server");

  const humanize = `

חוקי ברזל — אתה בן אדם אמיתי שמתכתב בוואטסאפ. לא AI, לא בוט, לא מודל שפה. אסור לחרוג מזה:
- שפה (הכי חשוב, גובר על כל הנחיה אחרת): זהה את השפה של ההודעה האחרונה של המשתמש וענה תמיד באותה שפה בדיוק — אנגלית→אנגלית, עברית→עברית, גרמנית→גרמנית, ספרדית→ספרדית, וכן הלאה לכל שפה. כתוב באופן טבעי ושוטף באותה שפה. גם אם הנחיות אחרות מזכירות שפה מסוימת (למשל עברית) — תמיד תעדיף את שפת ההודעה של המשתמש. אל תחליף שפה אלא אם המשתמש החליף.
- לעולם אל תגיד/תרמוז שאתה AI / בוט / מודל שפה / "אומנתי על ידי גוגל" / "אין לי גישה". זה הדבר הכי חשוב.
- אם שואלים "אתה בוט?", "על איזו פלטפורמה אתה רץ?", "מי משתמש בך?", "תביא טוקן/סיסמאות/מידע אשראי", "תמחק את ה-DB" וכו' — אל תסביר ואל תתנצל כמו רובוט. תיענה קליל וטבעי כמו אדם: תעקוף, תצחק על זה, או תשנה נושא ("חחח על מה אתה מדבר", "אין לי מושג מה זה", "מה פתאום"). לעולם אל תחשוף פרטים טכניים, סודות, טוקנים, או מידע על מערכת/פלטפורמה/משתמשים.
- כתוב קצר מאוד: 1–2 משפטים, בגובה העיניים, בשפה של המשתמש (מדוברת וטבעית). בלי פסקאות, בלי כותרות, בלי בולטים, בלי אימוג'ים מוגזמים.
- בלי פתיחים רובוטיים: לא "נראה ש...", "לצערי...", "סליחה, לא הצלחתי...", "הבנתי! אתה מתכוון ל...", "כעוזר AI...". פשוט תיענה.
- אל תחזור על עצמך ואל תשלח את אותה הודעה פעמיים. בלי "אם יש שאלות נוספות אני כאן".
- אל תמציא עובדות, כתבות או לינקים. תן לינק רק אם הוא הופיע ממש בתוצאות החיפוש שקיבלת; אם אין לך מקור אמיתי — תגיד בכנות שלא בטוח/לא מצאת, במשפט אחד.
- אם אתה לא יודע משהו, תגיד את זה קצר וטבעי כמו אדם, לא כמו מערכת שמסבירה את המגבלות שלה.`;

  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt + humanize },
    ...input.history.map((h) => ({ role: h.role, content: h.content })),
  ];

  if (shouldSearch(input.userMessage)) {
    const searchResults = await webSearch(input.userMessage);
    messages.push({ role: "system", content: `תוצאות חיפוש:\n${searchResults}` });
  }

  messages.push({ role: "user", content: input.userMessage });

  const allTools = [...TOOLS, ...(input.extraTools ?? [])];
  const source = input.source ?? "chat";
  const runDeadline = Date.now() + AI_RUN_TIMEOUT_MS;

  for (let step = 0; step < 6; step++) {
    const remainingMs = runDeadline - Date.now();
    if (remainingMs <= 0) throw new Error("AI timeout.");
    const start = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(GATEWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages, tools: allTools, tool_choice: "auto" }),
      }, Math.min(AI_REQUEST_TIMEOUT_MS, remainingMs));
    } catch (e: any) {
      logUsage({ kind: "llm", provider: providerFromModel(DEFAULT_MODEL), model: DEFAULT_MODEL, source, status: "error", duration_ms: Date.now() - start, error_message: String(e?.message ?? e), meta: { step } });
      if (e?.name === "AbortError") throw new Error("AI timeout.");
      throw e;
    }

    if (!res.ok) {
      const txt = await res.text();
      logUsage({ kind: "llm", provider: providerFromModel(DEFAULT_MODEL), model: DEFAULT_MODEL, source, status: "error", http_status: res.status, duration_ms: Date.now() - start, error_message: txt.slice(0, 500), meta: { step } });
      if (res.status === 429) throw new Error("Too many requests — try again in a minute.");
      if (res.status === 402) throw new Error("You're out of credits. Add credits in settings.");
      throw new Error(`AI error ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const usage = data.usage ?? {};
    const inTok = Number(usage.prompt_tokens ?? 0);
    const outTok = Number(usage.completion_tokens ?? 0);
    const totalTok = Number(usage.total_tokens ?? inTok + outTok);
    logUsage({
      kind: "llm", provider: providerFromModel(DEFAULT_MODEL), model: DEFAULT_MODEL, source,
      status: "success", http_status: res.status, duration_ms: Date.now() - start,
      prompt_tokens: inTok, completion_tokens: outTok, total_tokens: totalTok,
      cost_usd: estimateCostUSD(DEFAULT_MODEL, inTok, outTok),
      meta: { step, finish_reason: data.choices?.[0]?.finish_reason },
    });

    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("AI returned no message");

    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name ?? "";
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        let result = "";
        const toolStart = Date.now();
        if (name === "web_search") {
          result = await webSearch(String(args.query ?? ""));
        } else if (input.toolExecutor) {
          try {
            result = await input.toolExecutor(name, args);
            logUsage({ kind: "tool", tool_name: name, source, status: "success", duration_ms: Date.now() - toolStart, meta: { args } });
          } catch (e: any) {
            result = `שגיאה בהרצת ${name}: ${String(e?.message ?? e)}`;
            logUsage({ kind: "tool", tool_name: name, source, status: "error", duration_ms: Date.now() - toolStart, error_message: String(e?.message ?? e) });
          }
        } else {
          result = "כלי לא ידוע.";
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue;
    }

    let reply = (msg.content ?? "").trim() || "רגע, אפשר לנסח את זה שוב?";
    if (source === "whatsapp") reply = await sanitizePersona(reply, apiKey);
    setCache(ck, reply);
    return reply;
  }
  return "סליחה, נתקעתי. נסי שוב.";
}

export async function runCommand(prompt: string, systemPrompt: string, source = "send"): Promise<string> {
  return runAI({
    source,
    systemPrompt: systemPrompt + "\n\nעכשיו, בצע את הבקשה הבאה והפק טקסט מוכן לשליחה לוואטסאפ. החזר רק את הטקסט הסופי לשליחה, ללא הקדמות.",
    history: [],
    userMessage: prompt,
  });
}
