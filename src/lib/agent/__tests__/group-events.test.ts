import { describe, expect, it } from "vitest";
import { parseGroupEvents } from "../group-events.server";
import { heuristicSpam } from "../moderation.server";

describe("parseGroupEvents", () => {
  it("parses a groups_participants add event", () => {
    const events = parseGroupEvents({
      groups_participants: [
        {
          id: "12036302@g.us",
          action: "add",
          participants: [{ id: "972501234567@s.whatsapp.net", name: "דנה" }],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("add");
    expect(events[0].participants[0].name).toBe("דנה");
  });

  it("accepts string participants and ignores non-group ids", () => {
    const events = parseGroupEvents({
      groups: [
        { id: "12036302@g.us", action: "remove", participants: ["972501234567@s.whatsapp.net"] },
        { id: "972501234567@s.whatsapp.net", action: "add", participants: ["x"] },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("remove");
  });

  it("returns empty for message-only payloads", () => {
    expect(parseGroupEvents({ messages: [{ id: "x" }] })).toEqual([]);
  });
});

describe("heuristicSpam", () => {
  it("flags obvious link-spam and crypto bait", () => {
    expect(heuristicSpam("https://a.co https://b.co https://c.co הצטרפו!")).not.toBeNull();
    expect(heuristicSpam("guaranteed crypto profit 100% join now")).not.toBeNull();
  });

  it("does not flag normal messages with one link", () => {
    expect(heuristicSpam("תראו את הכתבה https://news.example.com")).toBeNull();
  });
});
