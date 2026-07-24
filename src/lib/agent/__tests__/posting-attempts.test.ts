import { describe, expect, it } from "vitest";
import { MAX_GEN_ATTEMPTS, isTransientGenError, nextGenAttempt } from "../posting.server";

describe("nextGenAttempt", () => {
  it("counts the first attempt from an empty engagement", () => {
    const a = nextGenAttempt(null, null);
    expect(a.attempts).toBe(1);
    expect(a.exceeded).toBe(false);
    expect(a.engagement).toEqual({ gen_attempts: 1 });
  });

  it("preserves existing engagement keys (post-send reply stats share the column)", () => {
    const a = nextGenAttempt({ replies_24h: 5, checked_at: "2026-07-24", gen_attempts: 2 }, null);
    expect(a.attempts).toBe(3);
    expect(a.exceeded).toBe(false);
    expect(a.engagement).toEqual({ replies_24h: 5, checked_at: "2026-07-24", gen_attempts: 3 });
  });

  it("treats non-object engagement values as empty", () => {
    expect(nextGenAttempt([1, 2], null).attempts).toBe(1);
    expect(nextGenAttempt("junk", null).attempts).toBe(1);
    expect(nextGenAttempt(7, null).attempts).toBe(1);
  });

  it(`allows attempt ${MAX_GEN_ATTEMPTS} but flags attempt ${MAX_GEN_ATTEMPTS + 1} as exceeded`, () => {
    expect(nextGenAttempt({ gen_attempts: MAX_GEN_ATTEMPTS - 1 }, null).exceeded).toBe(false);
    const over = nextGenAttempt({ gen_attempts: MAX_GEN_ATTEMPTS }, "LLM request timed out");
    expect(over.exceeded).toBe(true);
    expect(over.attempts).toBe(MAX_GEN_ATTEMPTS + 1);
    expect(over.failReasoning).toBe(
      `Generation failed after ${MAX_GEN_ATTEMPTS} attempts: LLM request timed out`,
    );
  });

  it("falls back to a generic reason when the post has no prior reasoning", () => {
    const a = nextGenAttempt({ gen_attempts: MAX_GEN_ATTEMPTS }, null);
    expect(a.failReasoning).toContain("unknown error");
  });
});

describe("isTransientGenError", () => {
  it("classifies retryable gateway failures", () => {
    expect(isTransientGenError("LLM request timed out")).toBe(true);
    expect(isTransientGenError("AI error 503: upstream unavailable")).toBe(true);
    expect(isTransientGenError("AI error 500: internal")).toBe(true);
    expect(isTransientGenError("AI error 429: rate limited")).toBe(true);
  });

  it("classifies permanent failures", () => {
    expect(isTransientGenError("AI error 400: bad request")).toBe(false);
    expect(isTransientGenError("Out of AI credits — add credits in Lovable settings.")).toBe(false);
    expect(isTransientGenError("post generation returned neither text nor poll")).toBe(false);
    expect(isTransientGenError("no approval owner")).toBe(false);
    expect(isTransientGenError("Model x not available: unknown model")).toBe(false);
  });
});
