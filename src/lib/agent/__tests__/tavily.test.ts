// Tavily client: real module logic with fetch stubbed at the network edge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usage-log.server", () => ({ logUsage: vi.fn() }));

import { isTavilyConfigured, tavilySearch } from "@/lib/tavily.server";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function httpResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("tavilySearch", () => {
  it("is unconfigured without the env var and throws before any network call", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    expect(isTavilyConfigured()).toBe(false);
    await expect(tavilySearch("q")).rejects.toThrow("TAVILY_API_KEY not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /search with the bearer key and parses answer + results", async () => {
    fetchMock.mockResolvedValueOnce(
      httpResponse(200, {
        answer: "It costs $20.",
        results: [
          { title: "Pricing", url: "https://x.test/p", content: "Premium $20", score: 0.91 },
          { title: "No url", url: "", content: "dropped" },
        ],
      }),
    );
    const out = await tavilySearch("premium pricing");
    expect(out.answer).toBe("It costs $20.");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ title: "Pricing", url: "https://x.test/p" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test-key");
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe("premium pricing");
    expect(body.include_answer).toBe(true);
  });

  it("retries once on a transient 429, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(httpResponse(429, "rate limited"))
      .mockResolvedValueOnce(httpResponse(200, { answer: null, results: [] }));
    const out = await tavilySearch("q");
    expect(out.results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 — bad keys fail fast", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(401, "invalid api key"));
    await expect(tavilySearch("q")).rejects.toThrow("Tavily error 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a malformed 200 body once, with a descriptive error when both fail", async () => {
    fetchMock
      .mockResolvedValueOnce(httpResponse(200, "<html>proxy error</html>"))
      .mockResolvedValueOnce(httpResponse(200, "<html>proxy error</html>"));
    await expect(tavilySearch("q")).rejects.toThrow("unparseable body (HTTP 200)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry after a malformed body succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(httpResponse(200, "not json"))
      .mockResolvedValueOnce(httpResponse(200, { answer: "ok", results: [] }));
    const out = await tavilySearch("q");
    expect(out.answer).toBe("ok");
  });
});
