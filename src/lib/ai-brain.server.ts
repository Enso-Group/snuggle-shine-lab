// AI brain — calls Lovable AI Gateway with web search tool, returns reply in Hebrew.
// Uses raw fetch (OpenAI-compatible) to avoid extra deps.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

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

// Web search via DuckDuckGo HTML, with content fetch for top results
async function fetchPageText(url: string, maxChars = 2000): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
    });
    clearTimeout(t);
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

async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
    });
    const html = await res.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = blockRe.exec(html)) !== null && results.length < 5) {
      const stripped = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
      let href = m[1];
      const um = href.match(/uddg=([^&]+)/);
      if (um) href = decodeURIComponent(um[1]);
      if (href.startsWith("//")) href = "https:" + href;
      results.push({ url: href, title: stripped(m[2]), snippet: stripped(m[3]) });
    }
    if (results.length === 0) return "לא נמצאו תוצאות. נסה ניסוח אחר של השאילתה.";

    // Fetch content of top 2 results in parallel for real substance
    const top = results.slice(0, 2);
    const pages = await Promise.all(top.map((r) => fetchPageText(r.url)));

    const out = results.map((r, i) => {
      const content = pages[i] ? `\nתוכן: ${pages[i]}` : "";
      return `[${i + 1}] ${r.title}\n${r.snippet}${content}\nמקור: ${r.url}`;
    }).join("\n\n---\n\n");
    return out;
  } catch (e: any) {
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


export async function runAI(input: AIRunInput): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

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

  // Up to 6 tool-call rounds
  for (let step = 0; step < 6; step++) {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        tools: allTools,
        tool_choice: "auto",
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 429) throw new Error("יותר מדי בקשות ל-AI — נסי שוב בעוד דקה.");
      if (res.status === 402) throw new Error("נגמרו הקרדיטים ל-AI. הוסיפי קרדיטים בהגדרות.");
      throw new Error(`AI error ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
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
        if (name === "web_search") {
          result = await webSearch(String(args.query ?? ""));
        } else if (input.toolExecutor) {
          try {
            result = await input.toolExecutor(name, args);
          } catch (e: any) {
            result = `שגיאה בהרצת ${name}: ${String(e?.message ?? e)}`;
          }
        } else {
          result = "כלי לא ידוע.";
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
export async function runCommand(prompt: string, systemPrompt: string): Promise<string> {
  return runAI({
    systemPrompt: systemPrompt + "\n\nעכשיו, בצע את הבקשה הבאה והפק טקסט מוכן לשליחה לוואטסאפ. החזר רק את הטקסט הסופי לשליחה, ללא הקדמות.",
    history: [],
    userMessage: prompt,
  });
}
