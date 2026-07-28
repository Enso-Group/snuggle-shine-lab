// X/Twitter research source (Apify tweet-scraper): item parsing, the prompt
// block, payload caching, and the resilience contract — an X failure must
// never fail or block a research answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usage-log.server", () => ({ logUsage: vi.fn() }));

import { parseTweetItems, xSearch } from "@/lib/apify-x.server";
import { buildXBlock, parseResearchPayload } from "../research";

const RAW_ITEMS = [
  {
    type: "tweet",
    text: "Anthropic just shipped a new model — thread with benchmarks:",
    url: "https://x.com/airesearcher/status/1234567890",
    createdAt: "2026-07-25T14:00:00.000Z",
    likeCount: 320,
    retweetCount: 41,
    author: { userName: "airesearcher", name: "AI Researcher" },
  },
  {
    // Non-tweet items (the actor emits meta rows on some plans) are dropped.
    type: "mock_tweet",
    text: "ignore me",
    url: "https://x.com/x/status/2",
  },
  {
    // Missing URL → unusable, dropped.
    type: "tweet",
    text: "no url here",
    author: { userName: "someone" },
  },
];

describe("parseTweetItems", () => {
  it("maps actor items to tweets and drops junk", () => {
    const tweets = parseTweetItems(RAW_ITEMS);
    expect(tweets).toHaveLength(1);
    expect(tweets[0]).toEqual({
      text: "Anthropic just shipped a new model — thread with benchmarks:",
      url: "https://x.com/airesearcher/status/1234567890",
      author: "@airesearcher (AI Researcher)",
      date: "2026-07-25T14:00:00.000Z",
      likes: 320,
      retweets: 41,
      media: [],
    });
  });

  it("tolerates non-array input", () => {
    expect(parseTweetItems(null)).toEqual([]);
    expect(parseTweetItems({ error: "boom" })).toEqual([]);
  });
});

describe("xSearch", () => {
  beforeEach(() => {
    vi.stubEnv("APIFY_API_KEY", "test-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("throws when the token is missing (caller treats it as 'X unavailable')", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    await expect(xSearch("anything")).rejects.toThrow("APIFY_API_KEY not configured");
  });

  it("returns parsed tweets on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(RAW_ITEMS), { status: 200 })),
    );
    const out = await xSearch("ai news", { maxItems: 5 });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].url).toContain("x.com");
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("insufficient credits", { status: 402 })),
    );
    await expect(xSearch("ai news")).rejects.toThrow(/Apify X search error 402/);
  });

  it("times out instead of hanging past its budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    await expect(xSearch("ai news", { timeoutMs: 50, budgetMs: 60 })).rejects.toThrow(
      "Apify X search timed out",
    );
  });
});

describe("buildXBlock", () => {
  it("renders tweets with author, date and URL, plus the usage rules", () => {
    const block = buildXBlock({
      results: [
        {
          text: "הדוח החדש של סטנפורד על AI יצא — ממצאים מרתקים",
          url: "https://x.com/techil/status/111",
          author: "@techil (טק ישראל)",
          date: "2026-07-26T08:00:00.000Z",
          likes: 55,
          retweets: 7,
        },
      ],
    });
    expect(block).toContain("@techil (טק ישראל)");
    expect(block).toContain("https://x.com/techil/status/111");
    expect(block).toContain("2026-07-26");
    // The rules: opinions/trends only, links only from the list.
    expect(block).toContain("לא כמקור לעובדות קשות");
  });

  it("renders nothing when there are no results", () => {
    expect(buildXBlock(null)).toBe("");
    expect(buildXBlock({ results: [] })).toBe("");
  });
});

describe("payload caching round-trip", () => {
  it("x_results survive parseResearchPayload", () => {
    const now = Date.now();
    const parsed = parseResearchPayload({
      question: "מה חדש ב-AI השבוע?",
      promised_at: now,
      deadline_at: now + 600_000,
      language: "he",
      person_wa_id: null,
      source_body: "מה חדש ב-AI?",
      promise_text: "אבדוק ואחזור אליך",
      x_results: {
        results: [
          {
            text: "big news",
            url: "https://x.com/a/status/1",
            author: "@a",
            date: null,
            likes: null,
            retweets: null,
          },
        ],
      },
    });
    expect(parsed?.x_results?.results).toHaveLength(1);
    expect(parsed?.x_results?.results[0].url).toBe("https://x.com/a/status/1");
  });
});
