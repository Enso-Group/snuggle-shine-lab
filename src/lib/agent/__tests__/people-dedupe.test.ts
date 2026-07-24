import { describe, expect, it } from "vitest";
import { planPeopleDedupe, type DedupePersonRow } from "../people-dedupe";

const row = (
  id: string,
  wa_id: string,
  created_at: string,
  over: Partial<DedupePersonRow> = {},
): DedupePersonRow => ({
  id,
  wa_id,
  created_at,
  display_name: null,
  language: null,
  sentiment: null,
  funnel_stage: "unknown",
  facts: [],
  tags: [],
  first_seen_at: created_at,
  last_seen_at: created_at,
  ...over,
});

describe("planPeopleDedupe", () => {
  it("deletes rows that are not person identities (groups, junk)", () => {
    const plan = planPeopleDedupe([
      row("p-group", "120363000000000001@g.us", "2026-07-01T10:00:00+00:00"),
      row("p-junk", "123@s.whatsapp.net", "2026-07-01T10:00:00+00:00"),
      row("p-ok", "972501234567", "2026-07-01T10:00:00+00:00"),
    ]);
    expect(plan.deletes.sort()).toEqual(["p-group", "p-junk"]);
    expect(plan.merges).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it("renames a singleton with a legacy spelling; leaves canonical and @lid rows alone", () => {
    const plan = planPeopleDedupe([
      row("p-legacy", "972501234567@s.whatsapp.net", "2026-07-01T10:00:00+00:00"),
      row("p-canon", "972509999999", "2026-07-01T10:00:00+00:00"),
      row("p-lid", "18803584966843@lid", "2026-07-01T10:00:00+00:00"),
    ]);
    expect(plan.renames).toEqual([{ id: "p-legacy", wa_id: "972501234567" }]);
    expect(plan.merges).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it("merges duplicate spellings into the earliest row and lists every variant", () => {
    const plan = planPeopleDedupe([
      row("p-late", "972501234567", "2026-07-03T10:00:00+00:00"),
      row("p-early", "972501234567@s.whatsapp.net", "2026-07-01T10:00:00+00:00"),
      row("p-mid", "972501234567:5@s.whatsapp.net", "2026-07-02T10:00:00+00:00"),
    ]);
    expect(plan.merges).toHaveLength(1);
    const m = plan.merges[0];
    expect(m.survivorId).toBe("p-early");
    expect(m.loserIds).toEqual(["p-mid", "p-late"]);
    expect(m.canon).toBe("972501234567");
    expect(m.allVariantWaIds.sort()).toEqual([
      "972501234567",
      "972501234567:5@s.whatsapp.net",
      "972501234567@s.whatsapp.net",
    ]);
  });

  it("fills scalar fields from the survivor first, then earliest loser", () => {
    const plan = planPeopleDedupe([
      row("p-1", "972501234567@s.whatsapp.net", "2026-07-01T10:00:00+00:00", {
        display_name: null,
        language: null,
        sentiment: "positive",
      }),
      row("p-2", "972501234567", "2026-07-02T10:00:00+00:00", {
        display_name: "דני",
        language: "he",
        sentiment: "negative",
      }),
      row("p-3", "972501234567@c.us", "2026-07-03T10:00:00+00:00", {
        display_name: "Danny",
        language: "en",
      }),
    ]);
    const patch = plan.merges[0].survivorPatch;
    expect(patch.display_name).toBe("דני");
    expect(patch.language).toBe("he");
    expect(patch.sentiment).toBe("positive");
  });

  it("keeps the survivor's funnel stage unless it is unknown", () => {
    const survivorHasStage = planPeopleDedupe([
      row("p-1", "972501234567", "2026-07-01T10:00:00+00:00", { funnel_stage: "customer" }),
      row("p-2", "972501234567@c.us", "2026-07-02T10:00:00+00:00", { funnel_stage: "lead" }),
    ]);
    expect(survivorHasStage.merges[0].survivorPatch.funnel_stage).toBe("customer");

    const survivorUnknown = planPeopleDedupe([
      row("p-1", "972501234567", "2026-07-01T10:00:00+00:00", { funnel_stage: "unknown" }),
      row("p-2", "972501234567@c.us", "2026-07-02T10:00:00+00:00", { funnel_stage: "lead" }),
    ]);
    expect(survivorUnknown.merges[0].survivorPatch.funnel_stage).toBe("lead");

    const allUnknown = planPeopleDedupe([
      row("p-1", "972501234567", "2026-07-01T10:00:00+00:00"),
      row("p-2", "972501234567@c.us", "2026-07-02T10:00:00+00:00", { funnel_stage: null }),
    ]);
    expect(allUnknown.merges[0].survivorPatch.funnel_stage).toBe("unknown");
  });

  it("unions facts deduped on normalized text, sorted by at, and unions tags", () => {
    const plan = planPeopleDedupe([
      row("p-1", "972501234567", "2026-07-01T10:00:00+00:00", {
        facts: [{ text: "גר בחיפה", at: "2026-07-02T00:00:00Z" }],
        tags: ["vip"],
      }),
      row("p-2", "972501234567@c.us", "2026-07-02T10:00:00+00:00", {
        facts: [
          { text: "גר  בחיפה", at: "2026-07-03T00:00:00Z" }, // dupe (whitespace)
          { text: "מעוניין בפרימיום", at: "2026-07-01T00:00:00Z" },
        ],
        tags: ["vip", "lead"],
      }),
    ]);
    const patch = plan.merges[0].survivorPatch;
    expect(patch.facts.map((f) => f.text)).toEqual(["מעוניין בפרימיום", "גר בחיפה"]);
    expect(patch.tags).toEqual(["vip", "lead"]);
  });

  it("caps merged facts at 40, dropping the oldest", () => {
    const many = (prefix: string, day: number) =>
      Array.from({ length: 25 }, (_, i) => ({
        text: `${prefix} ${i}`,
        at: `2026-07-${String(day).padStart(2, "0")}T00:00:${String(i).padStart(2, "0")}Z`,
      }));
    const plan = planPeopleDedupe([
      row("p-1", "972501234567", "2026-07-01T10:00:00+00:00", { facts: many("old", 1) }),
      row("p-2", "972501234567@c.us", "2026-07-02T10:00:00+00:00", { facts: many("new", 5) }),
    ]);
    const facts = plan.merges[0].survivorPatch.facts;
    expect(facts).toHaveLength(40);
    expect(facts[facts.length - 1].text).toBe("new 24");
    expect(facts.some((f) => f.text === "old 0")).toBe(false);
  });

  it("takes min first_seen_at and max last_seen_at across the group", () => {
    const plan = planPeopleDedupe([
      row("p-1", "972501234567", "2026-07-02T10:00:00+00:00", {
        first_seen_at: "2026-07-02T10:00:00+00:00",
        last_seen_at: "2026-07-10T10:00:00+00:00",
      }),
      row("p-2", "972501234567@c.us", "2026-07-01T10:00:00+00:00", {
        first_seen_at: "2026-07-01T10:00:00+00:00",
        last_seen_at: "2026-07-05T10:00:00+00:00",
      }),
    ]);
    const patch = plan.merges[0].survivorPatch;
    expect(patch.first_seen_at).toBe("2026-07-01T10:00:00+00:00");
    expect(patch.last_seen_at).toBe("2026-07-10T10:00:00+00:00");
  });
});
