import { describe, expect, it } from "vitest";
import {
  aggregateDailyStats,
  israelDateKey,
  israelWeekStart,
  parseRecommendations,
  recommendationsPromptBlock,
} from "../analytics";

describe("israelDateKey / israelWeekStart", () => {
  it("converts UTC instants to Israel-time dates", () => {
    // 23:30 UTC on the 19th is already the 20th in Israel (UTC+3 in summer).
    expect(israelDateKey(new Date("2026-07-19T23:30:00Z"))).toBe("2026-07-20");
    expect(israelDateKey(new Date("2026-07-20T10:00:00Z"))).toBe("2026-07-20");
  });

  it("finds the Sunday starting the week", () => {
    // 2026-07-20 is a Monday → week starts Sunday 2026-07-19.
    expect(israelWeekStart(new Date("2026-07-20T10:00:00Z"))).toBe("2026-07-19");
    // A Sunday maps to itself.
    expect(israelWeekStart(new Date("2026-07-19T10:00:00Z"))).toBe("2026-07-19");
  });
});

describe("aggregateDailyStats", () => {
  it("splits by Israel day, counts inbound volume, distinct senders and bot posts", () => {
    const rows = [
      { direction: "inbound", sender_id: "a", created_at: "2026-07-20T06:00:00Z" },
      { direction: "inbound", sender_id: "b", created_at: "2026-07-20T07:00:00Z" },
      { direction: "inbound", sender_id: "a", created_at: "2026-07-20T08:00:00Z" },
      { direction: "outbound", sender_id: "bot", created_at: "2026-07-20T09:00:00Z" },
      { direction: "inbound", sender_id: "c", created_at: "2026-07-21T06:00:00Z" },
    ];
    const days = aggregateDailyStats(rows);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({
      date: "2026-07-20",
      messages: 3,
      active_members: 2,
      bot_posts: 1,
    });
    expect(days[1]).toMatchObject({ date: "2026-07-21", messages: 1, active_members: 1 });
  });

  it("returns empty for no rows", () => {
    expect(aggregateDailyStats([])).toEqual([]);
  });
});

describe("parseRecommendations", () => {
  it("normalizes well-formed and garbage inputs", () => {
    expect(
      parseRecommendations({ best_times: ["09:00", "18:00"], pillar_ranking: ["טיפ"], notes: "x" }),
    ).toEqual({ best_times: ["09:00", "18:00"], pillar_ranking: ["טיפ"], notes: "x" });
    expect(parseRecommendations(null)).toEqual({ best_times: [], pillar_ranking: [], notes: "" });
    expect(parseRecommendations("junk")).toEqual({ best_times: [], pillar_ranking: [], notes: "" });
  });
});

describe("recommendationsPromptBlock", () => {
  it("builds a Hebrew block only when there is content", () => {
    expect(recommendationsPromptBlock(null)).toBe("");
    expect(recommendationsPromptBlock({ best_times: [], pillar_ranking: [], notes: "" })).toBe("");
    const block = recommendationsPromptBlock({
      best_times: ["09:00"],
      pillar_ranking: ["טיפ מקצועי", "שאלה"],
      notes: "פחות אימוג'ים",
    });
    expect(block).toContain("טיפ מקצועי > שאלה");
    expect(block).toContain("09:00");
    expect(block).toContain("פחות אימוג'ים");
  });
});
