// AI brain — calls Lovable AI Gateway with web search tool, returns reply in Hebrew.
// Uses raw fetch (OpenAI-compatible) to avoid extra deps.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const AI_REQUEST_TIMEOUT_MS = 18_000;
const SEARCH_REQUEST_TIMEOUT_MS = 6_000;
const PAGE_FETCH_TIMEOUT_MS = 4_000;
const AI_RUN_TIMEOUT_MS = 55_000;

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
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Web search via DuckDuckGo HTML, with content fetch for top results
async function fetchPageText(url: string, maxChars = 2000): Promise<string> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
    }, PAGE_FETCH_TIMEOUT_MS);
    const html = await res.text();
    // Strip scripts/styles, then tags
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, maxChars);
  } catch {
    return "";
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function extractDuckDuckGoUrl(href: string): string {
  const decoded = decodeHtml(href);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return decoded;
  }
}

async function searchDuckDuckGo(query: string, ua: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": ua, "Accept": "text/html" } }, SEARCH_REQUEST_TIMEOUT_MS);
  const html = await res.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result results_links/gi);
  for (let i = 1; i < blocks.length && results.length < 5; i++) {
    const chunk = blocks[i].slice(0, 5000);
    const link = chunk.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = chunk.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ??
      chunk.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
      "";
    results.push({ title: stripTags(link[2]), url: extractDuckDuckGoUrl(link[1]), snippet: stripTags(snippet) });
  }
  return results;
}

async function searchBing(query: string, ua: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": ua, "Accept": "text/html" } }, SEARCH_REQUEST_TIMEOUT_MS);
  const html = await res.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<li class="b_algo"/gi);
  for (let i = 1; i < blocks.length && results.length < 5; i++) {
    const chunk = blocks[i].slice(0, 5000);
    const link = chunk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    results.push({ title: stripTags(link[2]), url: decodeHtml(link[1]), snippet: stripTags(snippet) });
  }
  return results;
}

function shouldSearchBeforeModel(text: string): boolean {
  return /\b(news|today|latest|current|202[4-9]|stock|market|price|gpt|openai)\b/i.test(text) ||
    /(חדשות|עדכני|היום|כרגע|מניה|מניות|שוק|מחיר|סקירה|כתבה|כתבות|חפש|בדוק)/i.test(text);
}

async function webSearch(query: string): Promise<string> {
  const { logUsage } = await import("./usage-log.server");
  const start = Date.now();
  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  try {
    let provider = "duckduckgo";
    let results = await searchDuckDuckGo(query, UA);
    if (results.length === 0) {
      provider = "bing";
      results = await searchBing(query, UA);
    }

    if (results.length === 0) {
      logUsage({ kind: "tool", tool_name: "web_search", provider, status: "success", duration_ms: Date.now() - start, meta: { query, results: 0 } });
      return "לא נמצאו תוצאות. נסה ניסוח אחר של השאילתה.";
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
      description: "חיפוש מידע עדכני באינטרנט. השתמש כאשר נשאלת על אירועים אקטואליים, חדשות, או מידע שצריך להיות מעודכן.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "מילות החיפוש (יכול להיות באנגלית או עברית)" },
        },
        required: ["query"],
      },
    },
  },
];

export type AIToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AIRunInput = {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  extraTools?: AIToolDef[];
  toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string>;
};


export async function runAI(input: AIRunInput & { source?: string }): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
  const { logUsage } = await import("./usage-log.server");
  const { estimateCostUSD, providerFromModel } = await import("./ai-pricing.server");

  const humanize = `

הנחיות סגנון קריטיות (חובה):
- דבר/י כמו אדם אמיתי בוואטסאפ: קצר, ישיר, חם, בלי רשמיות מיותרת.
- אסור להתחיל ב"נראה ש...", "סליחה, לא הצלחתי...", "כעוזר AI..." או כל פתיח שמסגיר שאתה בוט.
- אם החיפוש לא החזיר משהו טוב, פשוט תגיד מה כן ידוע לך ותציע כיוון — בלי להתנצל ובלי "האם תרצה ש...".
- אל תחזור על עצמך, אל תכפיל משפטים, ואל תוסיף "אם יש שאלות נוספות אני כאן".
- כשמחפשים מידע ולא נמצא — תנסח/י שאלת חיפוש שונה (אנגלית, מילים אחרות) ותחפש/י שוב לפני שמוותרים.
- תשובה ממוצעת: 1–4 משפטים. רק אם באמת מבקשים פירוט — תרחיב/י.`;

  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt + humanize },
    ...input.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: input.userMessage },
  ];

  const allTools = [...TOOLS, ...(input.extraTools ?? [])];
  const source = input.source ?? "chat";
  const runDeadline = Date.now() + AI_RUN_TIMEOUT_MS;

  for (let step = 0; step < 6; step++) {
    const remainingMs = runDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("ה-AI לקח יותר מדי זמן לסיים את הבקשה. נסי בקשה קצרה יותר או שליחה ישירה.");
    }
    const start = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(GATEWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages, tools: allTools, tool_choice: "auto" }),
      }, Math.min(AI_REQUEST_TIMEOUT_MS, remainingMs));
    } catch (e: any) {
      logUsage({ kind: "llm", provider: providerFromModel(DEFAULT_MODEL), model: DEFAULT_MODEL, source, status: "error", duration_ms: Date.now() - start, error_message: String(e?.message ?? e), meta: { step } });
      if (e?.name === "AbortError") {
        throw new Error("ה-AI לקח יותר מדי זמן לענות. נסי שוב עם בקשה קצרה יותר או בלי חיפוש אינטרנט.");
      }
      throw e;
    }

    if (!res.ok) {
      const txt = await res.text();
      logUsage({ kind: "llm", provider: providerFromModel(DEFAULT_MODEL), model: DEFAULT_MODEL, source, status: "error", http_status: res.status, duration_ms: Date.now() - start, error_message: txt.slice(0, 500), meta: { step } });
      if (res.status === 429) throw new Error("יותר מדי בקשות ל-AI — נסי שוב בעוד דקה.");
      if (res.status === 402) throw new Error("נגמרו הקרדיטים ל-AI. הוסיפי קרדיטים בהגדרות.");
      throw new Error(`AI error ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const usage = data.usage ?? {};
    const inTok = Number(usage.prompt_tokens ?? 0);
    const outTok = Number(usage.completion_tokens ?? 0);
    const totalTok = Number(usage.total_tokens ?? inTok + outTok);
    const cost = estimateCostUSD(DEFAULT_MODEL, inTok, outTok);
    logUsage({
      kind: "llm",
      provider: providerFromModel(DEFAULT_MODEL),
      model: DEFAULT_MODEL,
      source,
      status: "success",
      http_status: res.status,
      duration_ms: Date.now() - start,
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: totalTok,
      cost_usd: cost,
      meta: { step, finish_reason: data.choices?.[0]?.finish_reason },
    });

    const choice = data.choices?.[0];
    const msg = choice?.message;
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
            logUsage({ kind: "tool", tool_name: name, source, status: "error", duration_ms: Date.now() - toolStart, error_message: String(e?.message ?? e), meta: { args } });
          }
        } else {
          result = "כלי לא ידוע.";
          logUsage({ kind: "tool", tool_name: name, source, status: "error", duration_ms: Date.now() - toolStart, error_message: "unknown tool" });
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue;
    }

    return (msg.content ?? "").trim() || "סליחה, לא הצלחתי להבין.";
  }
  return "סליחה, נתקעתי בחיפוש מידע. נסי שוב.";
}


// Standalone "command from dashboard": prompt + send to chat
export async function runCommand(prompt: string, systemPrompt: string, source = "send"): Promise<string> {
  return runAI({
    source,
    systemPrompt: systemPrompt + "\n\nעכשיו, בצע את הבקשה הבאה והפק טקסט מוכן לשליחה לוואטסאפ. החזר רק את הטקסט הסופי לשליחה, ללא הקדמות.",
    history: [],
    userMessage: prompt,
  });
}
