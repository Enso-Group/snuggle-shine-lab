import { describe, expect, it } from "vitest";
import { gapDescription, isSignificantGap, SIGNIFICANT_GAP_MS } from "../conversation-gap";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("isSignificantGap", () => {
  it("only trips at or above the threshold", () => {
    expect(isSignificantGap(SIGNIFICANT_GAP_MS - 1)).toBe(false);
    expect(isSignificantGap(SIGNIFICANT_GAP_MS)).toBe(true);
    expect(isSignificantGap(6 * HOUR)).toBe(true);
  });

  it("is false for missing gaps (first message in a conversation)", () => {
    expect(isSignificantGap(null)).toBe(false);
    expect(isSignificantGap(undefined)).toBe(false);
  });
});

describe("gapDescription", () => {
  it("renders minutes, hours and days in natural Hebrew", () => {
    expect(gapDescription(3 * MIN)).toBe("3 דקות");
    expect(gapDescription(0)).toBe("1 דקות");
    expect(gapDescription(HOUR)).toBe("כשעה");
    expect(gapDescription(6 * HOUR)).toBe("כ-6 שעות");
    expect(gapDescription(24 * HOUR)).toBe("כיממה");
    expect(gapDescription(3 * 24 * HOUR)).toBe("כ-3 ימים");
  });
});
