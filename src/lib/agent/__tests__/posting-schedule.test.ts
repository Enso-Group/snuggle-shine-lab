import { describe, expect, it } from "vitest";
import { computeDueSlots, israelNowParts, looksLikeQuestion } from "../posting-schedule";

// 2026-07-20 is a Monday. 09:00 Israel summer time = 06:00 UTC.
const mondayNineIsrael = new Date("2026-07-20T06:02:00Z");

describe("israelNowParts", () => {
  it("maps an instant to Israel-time day/minutes/date", () => {
    const p = israelNowParts(mondayNineIsrael);
    expect(p.dow).toBe(1); // Monday
    expect(p.minutes).toBe(9 * 60 + 2);
    expect(p.dateKey).toBe("2026-07-20");
  });
});

describe("computeDueSlots", () => {
  it("fires a daily slot within the grace window, once per day", () => {
    const due = computeDueSlots([{ day: null, time: "09:00" }], mondayNineIsrael);
    expect(due).toHaveLength(1);
    expect(due[0].slotKey).toBe("daily-09:00-2026-07-20");
  });

  it("fires a weekly slot only on the right day", () => {
    expect(computeDueSlots([{ day: 1, time: "09:00" }], mondayNineIsrael)).toHaveLength(1);
    expect(computeDueSlots([{ day: 2, time: "09:00" }], mondayNineIsrael)).toHaveLength(0);
  });

  it("does not fire before the slot or after the grace window", () => {
    expect(computeDueSlots([{ day: null, time: "09:05" }], mondayNineIsrael)).toHaveLength(0); // future
    expect(computeDueSlots([{ day: null, time: "08:45" }], mondayNineIsrael)).toHaveLength(0); // >10 min ago
  });

  it("ignores malformed times", () => {
    expect(computeDueSlots([{ day: null, time: "9am" }], mondayNineIsrael)).toHaveLength(0);
    expect(computeDueSlots([{ day: null, time: "25:00" }], mondayNineIsrael)).toHaveLength(0);
  });
});

describe("looksLikeQuestion", () => {
  it("detects Hebrew question openers and question marks", () => {
    expect(looksLikeQuestion("מישהו יודע איפה קונים את זה?")).toBe(true);
    expect(looksLikeQuestion("כמה עולה המנוי החודשי")).toBe(true);
    expect(looksLikeQuestion("Anyone knows a good place?")).toBe(true);
  });

  it("ignores statements and tiny messages", () => {
    expect(looksLikeQuestion("בוקר טוב לכולם")).toBe(false);
    expect(looksLikeQuestion("מה?")).toBe(false);
  });
});
