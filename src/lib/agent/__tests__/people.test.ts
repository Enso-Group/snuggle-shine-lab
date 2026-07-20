import { describe, expect, it } from "vitest";
import { mergeFacts, type PersonFact } from "../people.server";

const at = "2026-07-20T10:00:00.000Z";
const now = new Date("2026-07-20T12:00:00.000Z");

describe("mergeFacts", () => {
  it("appends new facts with a timestamp", () => {
    const merged = mergeFacts([], ["מעוניין בחבילת פרימיום"], now);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("מעוניין בחבילת פרימיום");
    expect(merged[0].at).toBe(now.toISOString());
  });

  it("dedupes case- and whitespace-insensitively", () => {
    const existing: PersonFact[] = [{ text: "שמו דני", at }];
    const merged = mergeFacts(existing, ["שמו  דני", "גר בחיפה"], now);
    expect(merged.map((f) => f.text)).toEqual(["שמו דני", "גר בחיפה"]);
  });

  it("drops junk facts (too short or too long)", () => {
    const merged = mergeFacts([], ["אב", "x".repeat(301), "עובדה תקינה"], now);
    expect(merged.map((f) => f.text)).toEqual(["עובדה תקינה"]);
  });

  it("caps the list, dropping the oldest first", () => {
    const existing: PersonFact[] = Array.from({ length: 40 }, (_, i) => ({
      text: `עובדה ישנה ${i}`,
      at,
    }));
    const merged = mergeFacts(existing, ["עובדה חדשה לגמרי"], now);
    expect(merged).toHaveLength(40);
    expect(merged[merged.length - 1].text).toBe("עובדה חדשה לגמרי");
    expect(merged.some((f) => f.text === "עובדה ישנה 0")).toBe(false);
  });
});
