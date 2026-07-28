// Twitter/X keyword search via Apify (actor apidojo/tweet-scraper, "Tweet
// Scraper V2") — the bot's second research source, next to Tavily. Chosen over
// the official X API deliberately: the actor is pay-per-result (~$0.40 per
// 1,000 tweets) instead of the API's expensive subscription tiers.
//
// Discipline mirrors tavily.server.ts: ONE bounded attempt (scraper runs are
// slow and pay-per-result — a retry would double cost and blow the research
// attempt's wall budget), the whole call never outlives budgetMs, and every
// call is logged to ai_usage_log. Resilience lives in the CALLER: research
// treats an X failure as "continue with Tavily only", never as an error.
//
// Configure with the APIFY_API_KEY secret (Lovable env; .env.local locally) —
// the same env var the sourcing feature already uses.

const ACTOR_URL = "https://api.apify.com/v2/acts/apidojo~tweet-scraper/run-sync-get-dataset-items";
const REQUEST_TIMEOUT_MS = 10_000;
const BUDGET_MS = 12_000;
// Bounds the per-search cost as well as the response size.
const DEFAULT_MAX_TWEETS = 10;

export type XTweetMedia = {
  type: "photo" | "video";
  /** Direct media URL (photo file / video variant) — a candidate for sending. */
  url: string;
};

export type XTweet = {
  text: string;
  url: string;
  /** "@userName (Display Name)" — ready for a prompt block. */
  author: string;
  /** ISO date string of the tweet, when the actor provided one. */
  date: string | null;
  likes: number | null;
  retweets: number | null;
  /** Photos/videos attached to the tweet — feed the media-from-search path.
   * Optional: cached payloads and older fixtures predate the field. */
  media?: XTweetMedia[];
};

export type XSearchOutcome = {
  results: XTweet[];
};

export function isApifyConfigured(): boolean {
  return !!process.env.APIFY_API_KEY;
}

/** Raw actor item — fields per apidojo/tweet-scraper's output schema. */
type RawTweet = {
  type?: string;
  text?: unknown;
  url?: unknown;
  twitterUrl?: unknown;
  createdAt?: unknown;
  likeCount?: unknown;
  retweetCount?: unknown;
  author?: { userName?: unknown; name?: unknown } | null;
  media?: unknown;
  photos?: unknown;
  videos?: unknown;
  extendedEntities?: { media?: unknown } | null;
};

/**
 * Pull attached photos/videos out of a raw tweet. The actor has shipped
 * several shapes over time (media[] / photos[] / videos[] /
 * extendedEntities.media[] with media_url_https + video_info.variants) —
 * each is read best-effort; anything unrecognized is simply skipped.
 * Exported for unit tests.
 */
export function parseTweetMedia(t: RawTweet): XTweetMedia[] {
  const out: XTweetMedia[] = [];
  const push = (type: "photo" | "video", url: unknown) => {
    const u = String(url ?? "");
    if (/^https?:\/\//.test(u) && !out.some((m) => m.url === u)) out.push({ type, url: u });
  };
  const readEntity = (m: unknown) => {
    if (!m || typeof m !== "object") return;
    const e = m as {
      type?: unknown;
      media_url_https?: unknown;
      url?: unknown;
      video_info?: { variants?: unknown } | null;
      variants?: unknown;
    };
    const variants = (e.video_info?.variants ?? e.variants) as
      Array<{ url?: unknown; content_type?: unknown; bitrate?: unknown }> | undefined;
    if (Array.isArray(variants) && variants.length) {
      // Highest-bitrate mp4 variant is the sendable file.
      const mp4s = variants
        .filter((v) => String(v?.content_type ?? "").includes("mp4") && v?.url)
        .sort((a, b) => Number(b?.bitrate ?? 0) - Number(a?.bitrate ?? 0));
      if (mp4s[0]?.url) push("video", mp4s[0].url);
      return;
    }
    if (String(e.type ?? "") === "video") return; // video without variants — nothing sendable
    push("photo", e.media_url_https ?? e.url);
  };
  for (const list of [t.extendedEntities?.media, t.media]) {
    if (Array.isArray(list)) list.forEach(readEntity);
  }
  if (Array.isArray(t.photos)) {
    t.photos.forEach((p) =>
      push("photo", typeof p === "string" ? p : ((p as { url?: unknown })?.url ?? "")),
    );
  }
  if (Array.isArray(t.videos)) t.videos.forEach(readEntity);
  return out.slice(0, 4);
}

/** Pure item mapper — exported for unit tests. */
export function parseTweetItems(items: unknown): XTweet[] {
  if (!Array.isArray(items)) return [];
  return (items as RawTweet[])
    .filter((t) => t && (t.type === undefined || t.type === "tweet"))
    .map((t) => {
      const userName = String(t.author?.userName ?? "").trim();
      const name = String(t.author?.name ?? "").trim();
      return {
        text: String(t.text ?? "").slice(0, 500),
        url: String(t.url ?? t.twitterUrl ?? ""),
        author: userName ? `@${userName}${name ? ` (${name})` : ""}` : name || "unknown",
        date: typeof t.createdAt === "string" ? t.createdAt : null,
        likes: Number.isFinite(Number(t.likeCount)) ? Number(t.likeCount) : null,
        retweets: Number.isFinite(Number(t.retweetCount)) ? Number(t.retweetCount) : null,
        media: parseTweetMedia(t),
      };
    })
    .filter((t) => t.url && t.text);
}

export async function xSearch(
  query: string,
  opts: { maxItems?: number; timeoutMs?: number; budgetMs?: number; language?: string } = {},
): Promise<XSearchOutcome> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) throw new Error("APIFY_API_KEY not configured");

  const { logUsage } = await import("./usage-log.server");
  const timeoutMs = Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, opts.budgetMs ?? BUDGET_MS);

  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // run-sync: Apify starts the actor and streams the dataset items back in
    // the same response. `timeout` (seconds) caps the RUN server-side so an
    // abandoned run doesn't keep scraping after we abort the request.
    const res = await fetch(`${ACTOR_URL}?token=${apiKey}&timeout=${Math.ceil(timeoutMs / 1000)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchTerms: [query.slice(0, 300)],
        sort: "Latest",
        maxItems: opts.maxItems ?? DEFAULT_MAX_TWEETS,
        ...(opts.language ? { tweetLanguage: opts.language } : {}),
      }),
      signal: ctrl.signal,
    });
    const bodyText = await res.text();
    clearTimeout(timer);

    if (!res.ok) {
      const err = new Error(`Apify X search error ${res.status}: ${bodyText.slice(0, 200)}`);
      logUsage({
        kind: "tool",
        tool_name: "apify_x_search",
        source: "agent_research",
        status: "error",
        http_status: res.status,
        duration_ms: Date.now() - start,
        error_message: String(err.message).slice(0, 300),
        meta: { query_chars: query.length },
      });
      throw err;
    }

    let items: unknown;
    try {
      items = JSON.parse(bodyText);
    } catch {
      const err = new Error(
        `Apify X search returned an unparseable body (HTTP 200): ${bodyText.slice(0, 120)}`,
      );
      logUsage({
        kind: "tool",
        tool_name: "apify_x_search",
        source: "agent_research",
        status: "error",
        http_status: 200,
        duration_ms: Date.now() - start,
        error_message: String(err.message).slice(0, 300),
        meta: { query_chars: query.length },
      });
      throw err;
    }

    const results = parseTweetItems(items);
    logUsage({
      kind: "tool",
      tool_name: "apify_x_search",
      source: "agent_research",
      status: "success",
      http_status: res.status,
      duration_ms: Date.now() - start,
      meta: { query_chars: query.length, result_count: results.length },
    });
    return { results };
  } catch (e: unknown) {
    clearTimeout(timer);
    const err = e as Error;
    if (err?.name === "AbortError") {
      const timeoutErr = new Error("Apify X search timed out");
      logUsage({
        kind: "tool",
        tool_name: "apify_x_search",
        source: "agent_research",
        status: "error",
        duration_ms: Date.now() - start,
        error_message: timeoutErr.message,
        meta: { query_chars: query.length },
      });
      throw timeoutErr;
    }
    throw err;
  }
}
