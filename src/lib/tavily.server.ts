// Tavily web search — the bot's research tool for "I'll check and get back
// to you" promises. One bounded call to POST https://api.tavily.com/search;
// transient failures (429/5xx/network/bad body) get one retry, and the WHOLE
// call (both attempts + the retry sleep) never outlives budgetMs — the same
// wall-clock discipline callLLM follows, so a research attempt's timing math
// stays honest inside the platform's ~60s request wall.
// Configure with the TAVILY_API_KEY secret (Lovable env; .env.local locally).

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 10_000;
const BUDGET_MS = 15_000;
const RETRY_DELAY_MS = 1_500;
// An attempt with less than this budget left can't realistically complete.
const MIN_ATTEMPT_BUDGET_MS = 2_000;

export type TavilyResult = {
  title: string;
  url: string;
  content: string;
  score: number | null;
};

export type TavilySearchOutcome = {
  /** Tavily's own synthesized answer, when include_answer returned one. */
  answer: string | null;
  results: TavilyResult[];
};

export function isTavilyConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; budgetMs?: number } = {},
): Promise<TavilySearchOutcome> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not configured");

  const { logUsage } = await import("./usage-log.server");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadlineAt = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  let lastError: Error = new Error("tavily search failed");

  for (let attempt = 0; attempt < 2; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < MIN_ATTEMPT_BUDGET_MS) throw lastError;
    const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);

    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
    try {
      const res = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: query.slice(0, 400),
          search_depth: "basic",
          max_results: opts.maxResults ?? 5,
          include_answer: true,
        }),
        signal: ctrl.signal,
      });
      const bodyText = await res.text();
      clearTimeout(timer);

      if (!res.ok) {
        lastError = new Error(`Tavily error ${res.status}: ${bodyText.slice(0, 200)}`);
        logUsage({
          kind: "tool",
          tool_name: "tavily_search",
          source: "agent_research",
          status: "error",
          http_status: res.status,
          duration_ms: Date.now() - start,
          error_message: bodyText.slice(0, 300),
          meta: { attempt, query_chars: query.length },
        });
        if (isTransientStatus(res.status) && attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw lastError;
      }

      // Parse OUTSIDE the transient-error funnel: a malformed 200 body gets a
      // descriptive error (with its real http_status logged), not a raw
      // SyntaxError masquerading as a network failure. Still retried once —
      // a truncated proxy response is transient in practice.
      let data: {
        answer?: unknown;
        results?: Array<{ title?: unknown; url?: unknown; content?: unknown; score?: unknown }>;
      };
      try {
        data = JSON.parse(bodyText);
      } catch {
        lastError = new Error(
          `Tavily returned an unparseable body (HTTP 200): ${bodyText.slice(0, 120)}`,
        );
        logUsage({
          kind: "tool",
          tool_name: "tavily_search",
          source: "agent_research",
          status: "error",
          http_status: 200,
          duration_ms: Date.now() - start,
          error_message: String(lastError.message).slice(0, 300),
          meta: { attempt, query_chars: query.length },
        });
        if (attempt === 0) await sleep(RETRY_DELAY_MS);
        continue;
      }

      const results: TavilyResult[] = (Array.isArray(data.results) ? data.results : [])
        .map((r) => ({
          title: String(r.title ?? "").slice(0, 200),
          url: String(r.url ?? ""),
          content: String(r.content ?? "").slice(0, 1_500),
          score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
        }))
        .filter((r) => r.url && r.content);
      logUsage({
        kind: "tool",
        tool_name: "tavily_search",
        source: "agent_research",
        status: "success",
        http_status: res.status,
        duration_ms: Date.now() - start,
        meta: { attempt, query_chars: query.length, result_count: results.length },
      });
      return {
        answer: typeof data.answer === "string" && data.answer.trim() ? data.answer.trim() : null,
        results,
      };
    } catch (e: unknown) {
      clearTimeout(timer);
      const err = e as Error;
      if (err === lastError) throw err; // non-transient HTTP error from above
      lastError = err?.name === "AbortError" ? new Error("Tavily request timed out") : err;
      logUsage({
        kind: "tool",
        tool_name: "tavily_search",
        source: "agent_research",
        status: "error",
        duration_ms: Date.now() - start,
        error_message: String(lastError.message).slice(0, 300),
        meta: { attempt, query_chars: query.length },
      });
      if (attempt === 0) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}
