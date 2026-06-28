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

// Simple web search via DuckDuckGo HTML scrape (no API key needed)
async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)",
      },
    });
    const html = await res.text();
    // Extract results: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = blockRe.exec(html)) !== null && results.length < 6) {
      const stripped = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
      let href = m[1];
      // DDG wraps urls: /l/?uddg=ENCODED
      const um = href.match(/uddg=([^&]+)/);
      if (um) href = decodeURIComponent(um[1]);
      results.push({ url: href, title: stripped(m[2]), snippet: stripped(m[3]) });
    }
    if (results.length === 0) return "לא נמצאו תוצאות.";
    return results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\nקישור: ${r.url}`).join("\n\n");
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

export type AIRunInput = {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
};

export async function runAI(input: AIRunInput): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: input.userMessage },
  ];

  // Up to 4 tool-call rounds
  for (let step = 0; step < 4; step++) {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        tools: TOOLS,
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
        if (tc.function?.name === "web_search") {
          let args: { query?: string } = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          const result = await webSearch(args.query || "");
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        } else {
          messages.push({ role: "tool", tool_call_id: tc.id, content: "כלי לא ידוע." });
        }
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
