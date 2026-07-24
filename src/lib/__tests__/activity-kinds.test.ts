import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTIVITY_KINDS } from "../activity.functions";

// ACTIVITY_KINDS is the single source of truth: the server's zod filter enum
// and the Activity page's chips are both derived from it. These tests pin the
// wire-level strings (they are persisted in query keys and produced from DB
// rows) so a rename or removal is a deliberate, visible change.
describe("ACTIVITY_KINDS", () => {
  it("contains the exact wire-level kind strings", () => {
    expect([...ACTIVITY_KINDS]).toEqual([
      "reply",
      "approval",
      "handled",
      "gate",
      "post",
      "moderation",
      "welcome",
      "follow_up",
      "insight",
      "config",
      "new_contact",
      "alert",
      "error",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(ACTIVITY_KINDS).size).toBe(ACTIVITY_KINDS.length);
  });

  it("builds a filter enum that accepts 'all' and every kind, rejects unknowns", () => {
    const filter = z.enum(["all", ...ACTIVITY_KINDS] as const);
    expect(filter.parse("all")).toBe("all");
    for (const k of ACTIVITY_KINDS) expect(filter.parse(k)).toBe(k);
    expect(() => filter.parse("nope")).toThrow();
  });
});
