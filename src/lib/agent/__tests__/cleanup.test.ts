import { describe, expect, it } from "vitest";
import { phonePart, planCleanup } from "../cleanup";

describe("phonePart", () => {
  it("strips any @suffix and tolerates bare/empty ids", () => {
    expect(phonePart("972501234567@s.whatsapp.net")).toBe("972501234567");
    expect(phonePart("18803584966843@lid")).toBe("18803584966843");
    expect(phonePart("972501234567")).toBe("972501234567");
    expect(phonePart("")).toBe("");
    expect(phonePart(null)).toBe("");
  });
});

describe("planCleanup", () => {
  const conversations = [
    { id: "c-participated", whapi_chat_id: "972501111111@s.whatsapp.net" },
    { id: "c-observed", whapi_chat_id: "972502222222@s.whatsapp.net" },
    { id: "c-pending-reply", whapi_chat_id: "972503333333@s.whatsapp.net" },
    { id: "c-group", whapi_chat_id: "120363000000000001@g.us" },
    { id: "c-observed-group", whapi_chat_id: "120363000000000002@g.us" },
  ];

  const input = {
    conversations,
    participatedConvIds: new Set(["c-participated", "c-group"]),
    protectedConvIds: new Set(["c-pending-reply"]),
    people: [
      { id: "p-dm", wa_id: "972501111111@s.whatsapp.net" }, // 1:1 counterpart of kept conv
      { id: "p-dm-bare", wa_id: "972501111111" }, // same phone, bare spelling
      { id: "p-observed", wa_id: "972502222222@s.whatsapp.net" }, // counterpart of deleted conv
      { id: "p-group-member", wa_id: "972509999999@s.whatsapp.net" }, // sender in kept group
      { id: "p-lid-member", wa_id: "18803584966843@lid" }, // lid sender in kept group
      { id: "p-orphan", wa_id: "972508888888@s.whatsapp.net" }, // connected to nothing
      { id: "p-pending", wa_id: "972503333333@s.whatsapp.net" }, // counterpart of protected conv
    ],
    senderIdsInKeptConvs: ["972509999999@s.whatsapp.net", "18803584966843@lid"],
  };

  it("deletes only conversations without participation or pending work", () => {
    const plan = planCleanup(input);
    expect(plan.convIdsToDelete.sort()).toEqual(["c-observed", "c-observed-group"]);
    expect(plan.keptConvIds.sort()).toEqual(["c-group", "c-participated", "c-pending-reply"]);
  });

  it("keeps people connected to kept conversations (counterpart, bare spelling, senders, lids) and deletes the rest", () => {
    const plan = planCleanup(input);
    expect(plan.personIdsToDelete.sort()).toEqual(["p-observed", "p-orphan"]);
  });

  it("deletes nothing when everything is participated", () => {
    const plan = planCleanup({
      conversations: [conversations[0]],
      participatedConvIds: new Set(["c-participated"]),
      protectedConvIds: new Set(),
      people: [{ id: "p-dm", wa_id: "972501111111@s.whatsapp.net" }],
      senderIdsInKeptConvs: [],
    });
    expect(plan.convIdsToDelete).toEqual([]);
    expect(plan.personIdsToDelete).toEqual([]);
  });

  it("with no participation data, deletes all conversations and unconnected people", () => {
    const plan = planCleanup({
      conversations: [conversations[1]],
      participatedConvIds: new Set(),
      protectedConvIds: new Set(),
      people: [{ id: "p-observed", wa_id: "972502222222@s.whatsapp.net" }],
      senderIdsInKeptConvs: [],
    });
    expect(plan.convIdsToDelete).toEqual(["c-observed"]);
    expect(plan.personIdsToDelete).toEqual(["p-observed"]);
  });
});
