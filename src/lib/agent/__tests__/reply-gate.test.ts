import { describe, expect, it } from "vitest";
import { parseWhapiMessage } from "../inbound";
import { detectDirectSignal, nameMentioned, normalizeWaId } from "../reply-gate";

const OWN = "972501111111@s.whatsapp.net";

const base = { body: "", mentions: [] as string[], quotedAuthor: null as string | null };

describe("normalizeWaId", () => {
  it("strips suffixes and non-digits", () => {
    expect(normalizeWaId("972501111111@s.whatsapp.net")).toBe("972501111111");
    expect(normalizeWaId("972-50-1111111")).toBe("972501111111");
    expect(normalizeWaId(null)).toBe("");
  });
});

describe("nameMentioned", () => {
  it("matches the bot name as a standalone word, Hebrew-safe", () => {
    expect(nameMentioned("דני, מה המחיר?", "דני")).toBe(true);
    expect(nameMentioned("שאלה לדני על המחיר", "דני")).toBe(true);
    expect(nameMentioned("מה המצב Danny?", "danny")).toBe(true);
  });

  it("does not match inside other words or with empty names", () => {
    expect(nameMentioned("הדנייה הזאת מעולה", "דני")).toBe(false);
    expect(nameMentioned("whatever", "")).toBe(false);
    expect(nameMentioned("א ב ג", "א")).toBe(false); // single-char names are too noisy
  });
});

describe("detectDirectSignal", () => {
  it("fires on an explicit @-mention of the bot only", () => {
    expect(
      detectDirectSignal({
        message: { ...base, mentions: [OWN] },
        ownWaId: OWN,
        botName: "",
        quotedIsBotMessage: false,
      }),
    ).toBe("mentioned");
    // Mentioning SOMEONE ELSE is not a signal — the old /@\d+/ bug.
    expect(
      detectDirectSignal({
        message: {
          ...base,
          body: "@972529999999 תראה את זה",
          mentions: ["972529999999@s.whatsapp.net"],
        },
        ownWaId: OWN,
        botName: "נועה",
        quotedIsBotMessage: false,
      }),
    ).toBe("none");
  });

  it("fires when replying to the bot's message", () => {
    expect(
      detectDirectSignal({
        message: base,
        ownWaId: OWN,
        botName: "",
        quotedIsBotMessage: true,
      }),
    ).toBe("reply_to_bot");
    expect(
      detectDirectSignal({
        message: { ...base, quotedAuthor: OWN },
        ownWaId: OWN,
        botName: "",
        quotedIsBotMessage: false,
      }),
    ).toBe("reply_to_bot");
  });

  it("fires on the bot's name, and stays silent on chatter", () => {
    expect(
      detectDirectSignal({
        message: { ...base, body: "נועה, אפשר פרטים על הקורס?" },
        ownWaId: OWN,
        botName: "נועה",
        quotedIsBotMessage: false,
      }),
    ).toBe("named");
    expect(
      detectDirectSignal({
        message: { ...base, body: "איזה משחק היה אתמול חברים" },
        ownWaId: OWN,
        botName: "נועה",
        quotedIsBotMessage: false,
      }),
    ).toBe("none");
  });

  it("works without knowing the own id (name path still available)", () => {
    expect(
      detectDirectSignal({
        message: { ...base, mentions: ["972501111111@s.whatsapp.net"] },
        ownWaId: "",
        botName: "",
        quotedIsBotMessage: false,
      }),
    ).toBe("none");
  });
});

describe("parseWhapiMessage context fields", () => {
  it("extracts mentions and quoted info", () => {
    const m = parseWhapiMessage({
      id: "X-1",
      chat_id: "1203@g.us",
      from: "972529999999@s.whatsapp.net",
      text: { body: "@נועה תגיבי" },
      context: {
        mentions: ["972501111111@s.whatsapp.net"],
        quoted_id: "ABCD-99",
        quoted_author: "972501111111@s.whatsapp.net",
      },
      timestamp: 1_800_000_000,
    });
    expect(m!.mentions).toEqual(["972501111111@s.whatsapp.net"]);
    expect(m!.quotedId).toBe("ABCD-99");
    expect(m!.quotedAuthor).toBe("972501111111@s.whatsapp.net");
  });

  it("defaults cleanly when context is absent", () => {
    const m = parseWhapiMessage({ id: "X", chat_id: "1203@g.us", text: { body: "hi" } });
    expect(m!.mentions).toEqual([]);
    expect(m!.quotedId).toBeNull();
    expect(m!.quotedAuthor).toBeNull();
  });
});
