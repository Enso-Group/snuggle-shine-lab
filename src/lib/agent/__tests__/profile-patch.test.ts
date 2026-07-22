import { describe, expect, it } from "vitest";
import { sanitizeProfilePatch } from "../profile-patch";

describe("sanitizeProfilePatch", () => {
  it("accepts whitelisted fields with valid values", () => {
    const { patch, applied, rejected } = sanitizeProfilePatch({
      enabled: true,
      tone: "warm and direct",
      content_pillars: ["daily tip", "Q&A"],
      moderation: { enabled: true, warn_limit: 1, remove_limit: 3 },
      posting_schedule: [{ day: 1, time: "09:00", pillar: "daily tip" }],
    });
    expect(applied.sort()).toEqual(
      ["content_pillars", "enabled", "moderation", "posting_schedule", "tone"].sort(),
    );
    expect(rejected).toEqual([]);
    expect(patch.moderation).toEqual({ enabled: true, warn_limit: 1, remove_limit: 3 });
    expect(patch.posting_schedule).toEqual([
      { day: 1, time: "09:00", pillar: "daily tip", prompt: undefined },
    ]);
  });

  it("rejects unknown fields and invalid values", () => {
    const { patch, applied, rejected } = sanitizeProfilePatch({
      owner_dm: "970000000",
      chat_id: "123@g.us",
      enabled: "yes",
      language: "not-a-code",
      moderation: { warn_limit: 99 },
    });
    expect(applied).toEqual([]);
    expect(rejected.sort()).toEqual(
      ["chat_id", "enabled", "language", "moderation", "owner_dm"].sort(),
    );
    expect(patch).toEqual({});
  });

  it("drops malformed schedule slots but keeps valid ones", () => {
    const { patch } = sanitizeProfilePatch({
      posting_schedule: [
        { day: null, time: "18:30" },
        { day: 9, time: "10:00" },
        { day: 2, time: "25:99" },
        "garbage",
      ],
    });
    expect(patch.posting_schedule).toHaveLength(1);
    expect(patch.posting_schedule![0]).toMatchObject({ day: null, time: "18:30" });
  });

  it("clamps welcome hints and keeps booleans", () => {
    const { patch } = sanitizeProfilePatch({
      welcome: { enabled: false, hint: "x".repeat(600) },
    });
    expect(patch.welcome?.enabled).toBe(false);
    expect(patch.welcome?.hint?.length).toBe(500);
  });

  it("handles garbage input safely", () => {
    expect(sanitizeProfilePatch(null)).toEqual({ patch: {}, applied: [], rejected: [] });
    expect(sanitizeProfilePatch("junk")).toEqual({ patch: {}, applied: [], rejected: [] });
  });
});
