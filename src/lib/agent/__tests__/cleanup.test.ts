import { describe, expect, it } from "vitest";
import { phonePart, planCleanup, type CleanupPerson } from "../cleanup";

describe("phonePart", () => {
  it("strips any @suffix and tolerates bare/empty ids", () => {
    expect(phonePart("972501234567@s.whatsapp.net")).toBe("972501234567");
    expect(phonePart("18803584966843@lid")).toBe("18803584966843");
    expect(phonePart("972501234567")).toBe("972501234567");
    expect(phonePart("")).toBe("");
    expect(phonePart(null)).toBe("");
  });
});

const person = (id: string, wa_id: string, over: Partial<CleanupPerson> = {}): CleanupPerson => ({
  id,
  wa_id,
  factsCount: 0,
  funnelStage: "unknown",
  sentiment: null,
  ...over,
});

describe("planCleanup", () => {
  const conversations = [
    // Bot actually replied here (sender_id 'bot' outbound).
    { id: "c-bot", whapi_chat_id: "972501111111@s.whatsapp.net", is_group: false },
    // Imported history: owner's own from_me messages, bot never wrote.
    { id: "c-imported", whapi_chat_id: "972502222222@s.whatsapp.net", is_group: false },
    // Observed only — no our-side message at all.
    { id: "c-observed", whapi_chat_id: "972504444444@s.whatsapp.net", is_group: false },
    // Reply in flight.
    { id: "c-pending", whapi_chat_id: "972503333333@s.whatsapp.net", is_group: false },
    // Group the bot writes in.
    { id: "c-group", whapi_chat_id: "120363000000000001@g.us", is_group: true },
  ];

  const base = {
    conversations,
    participatedConvIds: new Set(["c-bot", "c-imported", "c-group"]),
    protectedConvIds: new Set(["c-pending"]),
    botConvIds: new Set(["c-bot", "c-group"]),
  };

  it("keeps participated conversations (incl. imported-history ones) and deletes observed-only", () => {
    const plan = planCleanup({ ...base, people: [] });
    expect(plan.convIdsToDelete).toEqual(["c-observed"]);
    expect(plan.keptConvIds.sort()).toEqual(["c-bot", "c-group", "c-imported", "c-pending"]);
  });

  it("keeps profiles only when the bot engaged them", () => {
    const plan = planCleanup({
      ...base,
      people: [
        // Bot replied in their 1:1 → kept.
        person("p-bot", "972501111111@s.whatsapp.net"),
        // Same phone, bare spelling → kept.
        person("p-bot-bare", "972501111111"),
        // Imported-only chat, no bot engagement, no analysis → DELETED.
        person("p-imported", "972502222222@s.whatsapp.net"),
        // Reply in flight → kept.
        person("p-pending", "972503333333@s.whatsapp.net"),
        // Bot-learned analysis keeps a profile even without 1:1 bot messages.
        person("p-lead", "972505555555@s.whatsapp.net", { funnelStage: "lead" }),
        person("p-facts", "972506666666@s.whatsapp.net", { factsCount: 3 }),
        person("p-sentiment", "972507777777@s.whatsapp.net", { sentiment: "positive" }),
        // Group chatter / lid sender with nothing learned → DELETED.
        person("p-lid", "18803584966843@lid"),
        // Connected to nothing → DELETED.
        person("p-orphan", "972508888888@s.whatsapp.net"),
      ],
    });
    expect(plan.personIdsToDelete.sort()).toEqual(["p-imported", "p-lid", "p-orphan"]);
  });

  it("a group conversation the bot writes in does not keep member profiles by itself", () => {
    const plan = planCleanup({
      ...base,
      people: [person("p-member", "972509999999@s.whatsapp.net")],
    });
    expect(plan.personIdsToDelete).toEqual(["p-member"]);
  });

  it("null funnel stage counts as no analysis", () => {
    const plan = planCleanup({
      ...base,
      people: [person("p-null-stage", "972508888877@s.whatsapp.net", { funnelStage: null })],
    });
    expect(plan.personIdsToDelete).toEqual(["p-null-stage"]);
  });

  it("deletes nothing when every profile is engaged", () => {
    const plan = planCleanup({
      ...base,
      people: [
        person("p-bot", "972501111111@s.whatsapp.net"),
        person("p-lead", "972505555555@s.whatsapp.net", { funnelStage: "customer" }),
      ],
    });
    expect(plan.personIdsToDelete).toEqual([]);
  });
});
