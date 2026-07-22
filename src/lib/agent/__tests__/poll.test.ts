import { describe, expect, it } from "vitest";
import { normalizePoll, pollAsHistoryText, pollCount } from "../poll";

describe("normalizePoll", () => {
  it("accepts a valid poll and preserves option order", () => {
    const poll = normalizePoll({
      question: "מתי ניתן ל-AI לדחוף קוד לפרודקשן?",
      options: ["ממש בקרוב", "עוד כמה שנים", "בחיים לא בלי Code Review"],
      multi: false,
    });
    expect(poll).not.toBeNull();
    expect(poll!.options).toHaveLength(3);
    expect(poll!.options[0]).toBe("ממש בקרוב");
    expect(pollCount(poll!)).toBe(1);
  });

  it("strips emoji-number and bullet decorations from options", () => {
    const poll = normalizePoll({
      question: "Q",
      options: ["1️⃣ Soon", "2. Later", "- Never"],
    });
    expect(poll!.options).toEqual(["Soon", "Later", "Never"]);
  });

  it("dedupes options and caps at 12", () => {
    const poll = normalizePoll({
      question: "Q",
      options: ["A", "a ", ...Array.from({ length: 15 }, (_, i) => `opt ${i}`)],
    });
    expect(poll!.options[0]).toBe("A");
    expect(poll!.options).toHaveLength(12);
    expect(new Set(poll!.options.map((o) => o.toLowerCase())).size).toBe(12);
  });

  it("rejects polls without a question or with fewer than 2 options", () => {
    expect(normalizePoll({ question: "", options: ["A", "B"] })).toBeNull();
    expect(normalizePoll({ question: "Q", options: ["only one"] })).toBeNull();
    expect(normalizePoll(null)).toBeNull();
    expect(normalizePoll("text")).toBeNull();
  });

  it("multi=true allows selecting all options", () => {
    const poll = normalizePoll({ question: "Q", options: ["A", "B", "C"], multi: true });
    expect(pollCount(poll!)).toBe(3);
  });
});

describe("pollAsHistoryText", () => {
  it("renders a readable history line", () => {
    const poll = normalizePoll({ question: "שאלה", options: ["כן", "לא"] })!;
    const text = pollAsHistoryText(poll);
    expect(text).toContain("📊 שאלה");
    expect(text).toContain("▫️ כן");
    expect(text).toContain("▫️ לא");
  });
});
