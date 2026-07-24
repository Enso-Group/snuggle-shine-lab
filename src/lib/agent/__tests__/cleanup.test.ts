import { describe, expect, it } from "vitest";
import { planCleanup } from "../cleanup";

const person = (id: string, wa_id: string) => ({ id, wa_id });

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

  it("keeps profiles only when the bot/dashboard wrote (or is about to write) in their 1:1 chat", () => {
    const plan = planCleanup({
      ...base,
      people: [
        // Bot replied in their 1:1 → kept, in every spelling of the same phone.
        person("p-bot", "972501111111@s.whatsapp.net"),
        person("p-bot-bare", "972501111111"),
        person("p-bot-device", "972501111111:5@s.whatsapp.net"),
        // Imported-only chat: owner's from_me history, bot never wrote → DELETED.
        person("p-imported", "972502222222@s.whatsapp.net"),
        // Reply in flight (pending job / approval) protects the profile.
        person("p-pending", "972503333333@s.whatsapp.net"),
        // Connected to nothing → DELETED.
        person("p-orphan", "972508888888@s.whatsapp.net"),
      ],
    });
    expect(plan.personIdsToDelete.sort()).toEqual(["p-imported", "p-orphan"]);
  });

  it("bot-learned analysis no longer keeps a profile by itself", () => {
    // v2 kept profiles with facts/funnel/sentiment; the analyzer also runs on
    // merely-observed contacts, so v3 keys keep/delete on engagement only
    // (the CleanupPerson shape no longer carries analysis fields at all).
    const plan = planCleanup({
      ...base,
      people: [person("p-analyzed", "972505555555@s.whatsapp.net")],
    });
    expect(plan.personIdsToDelete).toEqual(["p-analyzed"]);
  });

  it("always deletes @simulation profiles and non-person ids", () => {
    const plan = planCleanup({
      ...base,
      people: [
        person("p-sim", "sim-abc123@simulation"),
        person("p-group-id", "120363000000000001@g.us"),
        person("p-junk", "123"),
      ],
    });
    expect(plan.personIdsToDelete.sort()).toEqual(["p-group-id", "p-junk", "p-sim"]);
  });

  it("a group conversation the bot writes in does not keep member profiles by itself", () => {
    const plan = planCleanup({
      ...base,
      people: [person("p-member", "972509999999@s.whatsapp.net")],
    });
    expect(plan.personIdsToDelete).toEqual(["p-member"]);
  });

  it("@lid identities are kept only via their own engaged 1:1 chat", () => {
    const withLidConv = {
      ...base,
      conversations: [
        ...conversations,
        { id: "c-lid", whapi_chat_id: "18803584966843@lid", is_group: false },
      ],
      participatedConvIds: new Set([...base.participatedConvIds, "c-lid"]),
      botConvIds: new Set([...base.botConvIds, "c-lid"]),
    };
    const plan = planCleanup({
      ...withLidConv,
      people: [
        person("p-lid-engaged", "18803584966843@lid"),
        person("p-lid-orphan", "18803584966899@lid"),
      ],
    });
    expect(plan.personIdsToDelete).toEqual(["p-lid-orphan"]);
  });

  it("deletes nothing when every profile is engaged", () => {
    const plan = planCleanup({
      ...base,
      people: [
        person("p-bot", "972501111111@s.whatsapp.net"),
        person("p-pending", "972503333333"),
      ],
    });
    expect(plan.personIdsToDelete).toEqual([]);
  });
});
