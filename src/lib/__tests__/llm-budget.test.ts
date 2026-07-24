import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep callLLM's dynamic imports from touching Supabase/pricing tables.
vi.mock("../usage-log.server", () => ({ logUsage: vi.fn() }));
vi.mock("../ai-pricing.server", () => ({
  estimateCostUSD: () => 0,
  providerFromModel: () => "test",
}));

import { callLLM, type LLMCallInput } from "../llm.server";

const FAST_CANDIDATES = 2; // google/gemini-3-flash-preview, google/gemini-2.5-flash
const ATTEMPTS_PER_MODEL = 3; // initial + RETRY_DELAYS_MS [800, 2500]

const fetchMock = vi.fn();

function input(extra: Partial<LLMCallInput> = {}): LLMCallInput {
  return {
    role: "fast",
    source: "test",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

/**
 * Drives the fake clock until callLLM settles. Fetch always rejects
 * immediately, so all elapsed (fake) time comes from the retry sleeps —
 * making the wall-clock budget math exact: 0ms at attempt 0, 800ms at
 * attempt 1, 3300ms at attempt 2 of each model.
 */
async function runToError(i: LLMCallInput): Promise<Error> {
  const settled = callLLM(i).then(
    () => new Error("unexpected success"),
    (e: Error) => e,
  );
  await vi.runAllTimersAsync();
  return settled;
}

function modelOfCall(n: number): string {
  return JSON.parse(String(fetchMock.mock.calls[n][1].body)).model;
}

describe("callLLM budgetMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    vi.stubEnv("LLM_FAST_MODEL", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("without budgetMs, walks every attempt of every candidate (default unchanged)", async () => {
    const err = await runToError(input());
    expect(err.message).toBe("connection refused");
    expect(fetchMock).toHaveBeenCalledTimes(FAST_CANDIDATES * ATTEMPTS_PER_MODEL);
  });

  it("a generous budget changes nothing", async () => {
    const err = await runToError(input({ budgetMs: 60_000 }));
    expect(err.message).toBe("connection refused");
    expect(fetchMock).toHaveBeenCalledTimes(FAST_CANDIDATES * ATTEMPTS_PER_MODEL);
  });

  it("stops the retry ladder once the budget is spent, rethrowing the last error", async () => {
    // Attempt checks land at 0ms, 800ms, 3300ms — a 3000ms budget affords
    // exactly two attempts and must never reach the second candidate model.
    const err = await runToError(input({ budgetMs: 3000 }));
    expect(err.message).toBe("connection refused");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(modelOfCall(0)).toBe("google/gemini-3-flash-preview");
    expect(modelOfCall(1)).toBe("google/gemini-3-flash-preview");
  });

  it("never starts an attempt when the budget is already exhausted", async () => {
    const err = await runToError(input({ budgetMs: 0 }));
    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
