// Pure research helpers: promise detection, payload math, interim lines.
import { describe, expect, it } from "vitest";
import { looksLikeStructuredOutput } from "../inbound";
import { leaksPersona } from "../persona";
import {
  buildResearchBlock,
  buildResearchPayload,
  detectsCheckBackPromise,
  interimLineFor,
  parseResearchPayload,
  researchNeedsInterim,
  RESEARCH_DEADLINE_MS,
  RESEARCH_INTERIM_AFTER_MS,
} from "../research";

describe("detectsCheckBackPromise", () => {
  it.each([
    "אבדוק ואחזור אליך עם תשובה מסודרת",
    "אני צריך לבדוק משהו לפני שאענה — אחזור אליך בהקדם.",
    "נבדוק את זה מול הצוות",
    "אברר לגבי המחיר ואחזור עם תשובה",
    "אעדכן אותך בהמשך היום",
    "בודק את זה עכשיו",
    "I'll check with the team and get back to you",
    "Let me check on that for you",
    "I will look into it and circle back",
  ])("detects a promise in %s", (text) => {
    expect(detectsCheckBackPromise(text)).toBe(true);
  });

  it.each([
    "המחיר הוא 100 שקל לחודש",
    "תודה רבה, שמחתי לעזור!",
    "שחזור הנתונים הסתיים בהצלחה", // שחזור must not read as אחזור
    "נבדוקק", // Hebrew right-boundary: extra letter breaks the word
    "The check cleared yesterday",
    "",
  ])("stays quiet on %s", (text) => {
    expect(detectsCheckBackPromise(text)).toBe(false);
  });
});

describe("buildResearchPayload / parseResearchPayload", () => {
  const now = 1_800_000_000_000;

  it("computes the 10-minute deadline and falls back to the source message", () => {
    const p = buildResearchPayload({
      question: null,
      promisedAtMs: now,
      language: "he",
      personWaId: "972500000777",
      sourceBody: "כמה עולה חבילת פרימיום?",
      promiseText: "אבדוק ואחזור אליך",
    });
    expect(p.question).toBe("כמה עולה חבילת פרימיום?");
    expect(p.deadline_at).toBe(now + RESEARCH_DEADLINE_MS);
    expect(p.deadline_at - p.promised_at).toBe(10 * 60_000);
  });

  it("round-trips through jsonb as object and as string", () => {
    const p = buildResearchPayload({
      question: "premium plan pricing",
      promisedAtMs: now,
      language: "en",
      personWaId: null,
      sourceBody: "how much?",
      promiseText: "I'll check",
    });
    expect(parseResearchPayload(p)?.question).toBe("premium plan pricing");
    expect(parseResearchPayload(JSON.stringify(p))?.deadline_at).toBe(p.deadline_at);
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(parseResearchPayload(null)).toBeNull();
    expect(parseResearchPayload("not json")).toBeNull();
    expect(parseResearchPayload({ question: "" })).toBeNull();
    expect(parseResearchPayload({ question: "x", promised_at: "soon" })).toBeNull();
  });
});

describe("interim update", () => {
  it("fires only after the threshold and only once", () => {
    const p = buildResearchPayload({
      question: "q",
      promisedAtMs: 0,
      language: "he",
      personWaId: null,
      sourceBody: "b",
      promiseText: "t",
    });
    expect(researchNeedsInterim(p, RESEARCH_INTERIM_AFTER_MS - 1)).toBe(false);
    expect(researchNeedsInterim(p, RESEARCH_INTERIM_AFTER_MS)).toBe(true);
    expect(researchNeedsInterim({ ...p, interim_sent: true }, RESEARCH_INTERIM_AFTER_MS + 1)).toBe(
      false,
    );
  });

  it("keeps the interim threshold inside the 10-minute cap", () => {
    expect(RESEARCH_INTERIM_AFTER_MS).toBeLessThan(RESEARCH_DEADLINE_MS - 60_000);
  });

  it("interim lines are persona-safe and never JSON-shaped", () => {
    for (const lang of ["he", "en", "ru", null]) {
      const line = interimLineFor(lang);
      expect(line.length).toBeGreaterThan(10);
      expect(leaksPersona(line)).toBe(false);
      expect(looksLikeStructuredOutput(line)).toBe(false);
    }
    expect(interimLineFor("he")).not.toBe(interimLineFor("en"));
  });
});

describe("stripCitationMarkers", () => {
  it("removes [n] source markers a model copies from numbered results", async () => {
    const { stripCitationMarkers } = await import("../research");
    expect(stripCitationMarkers("המחיר הוא 100₪ [1] לחודש [2]")).toBe("המחיר הוא 100₪ לחודש");
    expect(stripCitationMarkers("Plain answer, no markers")).toBe("Plain answer, no markers");
    expect(stripCitationMarkers("")).toBe("");
  });
});

describe("buildResearchBlock", () => {
  it("returns empty for no material", () => {
    expect(buildResearchBlock(null)).toBe("");
    expect(buildResearchBlock({ answer: null, results: [] })).toBe("");
  });

  it("includes the answer and numbered results", () => {
    const block = buildResearchBlock({
      answer: "The premium plan costs $20/month.",
      results: [
        {
          title: "Pricing page",
          url: "https://example.com/pricing",
          content: "Premium is $20",
          score: 0.9,
        },
      ],
    });
    expect(block).toContain("The premium plan costs $20/month.");
    expect(block).toContain("[1] Pricing page");
    expect(block).toContain("https://example.com/pricing");
  });
});
