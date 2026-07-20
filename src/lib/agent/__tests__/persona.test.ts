import { describe, expect, it } from "vitest";
import { leaksPersona, stripLeakSentences } from "../persona";

describe("leaksPersona", () => {
  it("flags Hebrew and English AI self-references", () => {
    expect(leaksPersona("אני מודל שפה ולכן לא יכול לעזור")).toBe(true);
    expect(leaksPersona("אני בוט של החברה")).toBe(true);
    expect(leaksPersona("As an AI, I cannot do that")).toBe(true);
    expect(leaksPersona("I'm an AI assistant trained by OpenAI")).toBe(true);
    expect(leaksPersona("אין לי גישה למערכת הזו")).toBe(true);
  });

  it("does not flag normal business replies", () => {
    expect(leaksPersona("בשמחה! אשלח לך את הפרטים עוד היום.")).toBe(false);
    expect(leaksPersona('המחיר הוא 250 ש"ח כולל משלוח.')).toBe(false);
    expect(leaksPersona("Sure, I'll check and get back to you today.")).toBe(false);
  });
});

describe("stripLeakSentences", () => {
  it("removes only the leaking sentences", () => {
    const out = stripLeakSentences("היי! אני בוט אוטומטי. אשמח לעזור עם ההזמנה שלך.");
    expect(out).toContain("אשמח לעזור");
    expect(out).not.toContain("בוט");
  });

  it("returns empty string when everything leaks", () => {
    expect(stripLeakSentences("אני מודל שפה.")).toBe("");
  });
});
