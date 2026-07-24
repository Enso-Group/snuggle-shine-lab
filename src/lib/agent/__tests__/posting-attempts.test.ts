import { describe, expect, it } from "vitest";
import {
  GEN_LEASE_MS,
  MAX_GEN_ATTEMPTS,
  draftModelForAttempt,
  isTransientGenError,
  leaseActive,
  nextGenAttempt,
  readStoredDraft,
  releaseLease,
} from "../posting.server";

describe("nextGenAttempt", () => {
  it("counts the first attempt from an empty engagement", () => {
    const a = nextGenAttempt(null, null);
    expect(a.attempts).toBe(1);
    expect(a.exceeded).toBe(false);
    expect(a.engagement).toEqual({ gen_attempts: 1 });
    expect(a.prior).toEqual({});
  });

  it("preserves existing engagement keys (post-send reply stats share the column)", () => {
    const a = nextGenAttempt({ replies_24h: 5, checked_at: "2026-07-24", gen_attempts: 1 }, null);
    expect(a.attempts).toBe(2);
    expect(a.exceeded).toBe(false);
    expect(a.engagement).toEqual({ replies_24h: 5, checked_at: "2026-07-24", gen_attempts: 2 });
  });

  it("exposes the un-bumped prior for the cap-bypass claim", () => {
    const a = nextGenAttempt({ gen_attempts: 2, draft: { post: "x" } }, null);
    expect(a.prior).toEqual({ gen_attempts: 2, draft: { post: "x" } });
    expect(a.engagement.gen_attempts).toBe(3);
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

  it("falls back to a generic reason when there is no reasoning and no lease trace", () => {
    const a = nextGenAttempt({ gen_attempts: MAX_GEN_ATTEMPTS }, null);
    expect(a.failReasoning).toContain("unknown error");
  });

  it("composes the cap message from the lease fields when no reasoning was stored", () => {
    // The killed-request signature: gen_attempts bumped by the claim, but the
    // isolate died mid-LLM-call so no reasoning was ever persisted. The claim
    // fields still say what ran and when — the operator must see that, not
    // 'unknown error'.
    const a = nextGenAttempt(
      {
        gen_attempts: MAX_GEN_ATTEMPTS,
        gen_last_model: "google/gemini-2.5-pro",
        gen_started_at: "2026-07-24T19:46:09.000Z",
      },
      null,
    );
    expect(a.failReasoning).not.toContain("unknown error");
    expect(a.failReasoning).toBe(
      `Generation failed after ${MAX_GEN_ATTEMPTS} attempts: attempt ${MAX_GEN_ATTEMPTS} ` +
        "(model google/gemini-2.5-pro) started at 2026-07-24T19:46:09.000Z and never completed" +
        " — the request was likely killed",
    );
  });

  it("prefers stored reasoning over the lease trace", () => {
    const a = nextGenAttempt(
      { gen_attempts: MAX_GEN_ATTEMPTS, gen_last_model: "m", gen_started_at: "t" },
      "AI error 500: internal",
    );
    expect(a.failReasoning).toContain("AI error 500: internal");
    expect(a.failReasoning).not.toContain("never completed");
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

describe("draftModelForAttempt", () => {
  const chain = ["pinned", "b", "c", "flash"];

  it("keeps the configured order on the first attempt", () => {
    expect(draftModelForAttempt(1, chain)).toBeNull();
  });

  it(`the final allowed attempt (${MAX_GEN_ATTEMPTS}) jumps to the known-good tail`, () => {
    // Live 2026-07-24: a post only drafted once rotation reached flash, the
    // LAST candidate — the final attempt must not gamble on another preview.
    expect(draftModelForAttempt(MAX_GEN_ATTEMPTS, chain)).toBe("flash");
  });

  it("attempts past the cap still resolve to the tail (cap-bypass bookkeeping)", () => {
    expect(draftModelForAttempt(MAX_GEN_ATTEMPTS + 1, chain)).toBe("flash");
    expect(draftModelForAttempt(MAX_GEN_ATTEMPTS + 3, chain)).toBe("flash");
  });

  it("cannot rotate a single-candidate chain", () => {
    expect(draftModelForAttempt(3, ["only"])).toBeNull();
    expect(draftModelForAttempt(2, [])).toBeNull();
  });
});

describe("leaseActive", () => {
  const now = Date.parse("2026-07-24T20:00:00.000Z");

  it("is live while gen_lease_until is in the future", () => {
    const until = new Date(now + GEN_LEASE_MS).toISOString();
    expect(leaseActive({ gen_lease_until: until }, now)).toBe(true);
    expect(leaseActive({ gen_lease_until: until, gen_attempts: 1 }, now)).toBe(true);
  });

  it("expires exactly at the boundary and beyond", () => {
    const until = new Date(now).toISOString();
    expect(leaseActive({ gen_lease_until: until }, now)).toBe(false);
    expect(leaseActive({ gen_lease_until: until }, now + 1)).toBe(false);
  });

  it("treats missing, malformed, and non-object engagement as unleased", () => {
    expect(leaseActive(null, now)).toBe(false);
    expect(leaseActive(undefined, now)).toBe(false);
    expect(leaseActive({}, now)).toBe(false);
    expect(leaseActive({ gen_lease_until: 12345 }, now)).toBe(false);
    expect(leaseActive({ gen_lease_until: "not a date" }, now)).toBe(false);
    expect(leaseActive([1], now)).toBe(false);
    expect(leaseActive("junk", now)).toBe(false);
  });
});

describe("releaseLease", () => {
  it("strips the lease fields but keeps the attempt record and stats", () => {
    expect(
      releaseLease({
        gen_attempts: 2,
        gen_last_model: "google/gemini-2.5-flash",
        gen_lease_until: "2026-07-24T20:01:30.000Z",
        gen_started_at: "2026-07-24T20:00:00.000Z",
        draft: { post: "x" },
        replies_24h: 3,
      }),
    ).toEqual({
      gen_attempts: 2,
      gen_last_model: "google/gemini-2.5-flash",
      draft: { post: "x" },
      replies_24h: 3,
    });
  });

  it("is a no-op on lease-free engagement", () => {
    expect(releaseLease({ gen_attempts: 1 })).toEqual({ gen_attempts: 1 });
    expect(releaseLease({})).toEqual({});
  });
});

describe("readStoredDraft", () => {
  it("returns a persisted draft with its poll", () => {
    const d = readStoredDraft({
      gen_attempts: 2,
      draft: { post: "שלום", poll: { question: "q", options: ["a", "b"] } },
    });
    expect(d).toEqual({ post: "שלום", poll: { question: "q", options: ["a", "b"] } });
  });

  it("ignores missing, malformed, and empty drafts", () => {
    expect(readStoredDraft({})).toBeNull();
    expect(readStoredDraft({ draft: "text" })).toBeNull();
    expect(readStoredDraft({ draft: [1] })).toBeNull();
    expect(readStoredDraft({ draft: { post: "  ", poll: null } })).toBeNull();
  });

  it("keeps a poll-only draft", () => {
    expect(readStoredDraft({ draft: { post: "", poll: { question: "q" } } })).toEqual({
      post: "",
      poll: { question: "q" },
    });
  });
});
