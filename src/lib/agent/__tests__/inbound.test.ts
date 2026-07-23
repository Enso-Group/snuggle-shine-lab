import { describe, expect, it } from "vitest";
import {
  looksLikeStructuredOutput,
  normalizeReplyParts,
  randomReplyDelayMs,
  REPLY_TARGET_MIN_MS,
  REPLY_TARGET_MAX_MS,
  normalizeTimestampMs,
  parseWhapiMessage,
  retryBackoffMs,
  secretsEqual,
  stripStructuredOutput,
  typingSecondsFor,
} from "../inbound";

describe("parseWhapiMessage", () => {
  it("parses a standard Whapi text message", () => {
    const m = parseWhapiMessage({
      id: "ABCD-1234",
      chat_id: "972501234567@s.whatsapp.net",
      from: "972501234567@s.whatsapp.net",
      from_name: "דנה",
      text: { body: "שלום, אפשר פרטים?" },
      timestamp: 1_800_000_000,
    });
    expect(m).not.toBeNull();
    expect(m!.chatId).toBe("972501234567@s.whatsapp.net");
    expect(m!.senderName).toBe("דנה");
    expect(m!.body).toBe("שלום, אפשר פרטים?");
    expect(m!.isGroup).toBe(false);
    expect(m!.fromMe).toBe(false);
    expect(m!.ts).toBe(1_800_000_000_000); // seconds → ms
  });

  it("detects groups, own messages, and caption bodies", () => {
    const m = parseWhapiMessage({
      id: "X-1",
      chat_id: "12036302@g.us",
      author: "972501234567@s.whatsapp.net",
      from_me: true,
      caption: "תמונה מצורפת",
      timestamp: Date.now(), // already ms
    });
    expect(m!.isGroup).toBe(true);
    expect(m!.fromMe).toBe(true);
    expect(m!.body).toBe("תמונה מצורפת");
  });

  it("returns null without a chat id and tolerates junk timestamps", () => {
    expect(parseWhapiMessage({ text: { body: "hi" } })).toBeNull();
    expect(parseWhapiMessage(null)).toBeNull();
    const before = Date.now();
    expect(normalizeTimestampMs("garbage")).toBeGreaterThanOrEqual(before);
  });
});

describe("typingSecondsFor", () => {
  it("clamps between 2 and 7 seconds", () => {
    expect(typingSecondsFor("קצר")).toBe(2);
    expect(typingSecondsFor("א".repeat(100))).toBe(4);
    expect(typingSecondsFor("א".repeat(1000))).toBe(7);
  });
});

describe("normalizeReplyParts", () => {
  it("drops empties and keeps short parts as-is", () => {
    expect(normalizeReplyParts(["  ", "היי", ""])).toEqual(["היי"]);
  });

  it("merges overflow beyond maxParts instead of dropping content", () => {
    const parts = normalizeReplyParts(["א", "ב", "ג", "ד"], 3);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toContain("ג");
    expect(parts[2]).toContain("ד");
  });

  it("splits a single wall of text on paragraph boundaries", () => {
    const wall = `${"פסקה ראשונה עם תוכן. ".repeat(15)}\n\n${"פסקה שנייה עם עוד תוכן. ".repeat(15)}`;
    const parts = normalizeReplyParts([wall], 3);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("returns empty array for no content", () => {
    expect(normalizeReplyParts([])).toEqual([]);
  });
});

describe("retryBackoffMs", () => {
  it("escalates 30s → 2m → 10m and saturates", () => {
    expect(retryBackoffMs(1)).toBe(30_000);
    expect(retryBackoffMs(2)).toBe(120_000);
    expect(retryBackoffMs(3)).toBe(600_000);
    expect(retryBackoffMs(9)).toBe(600_000);
    expect(retryBackoffMs(0)).toBe(30_000);
  });
});

describe("secretsEqual", () => {
  it("accepts equal strings and rejects everything else", () => {
    expect(secretsEqual("s3cret", "s3cret")).toBe(true);
    expect(secretsEqual("s3cret", "s3creT")).toBe(false);
    expect(secretsEqual("s3cret", "s3cret ")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
    expect(secretsEqual(null, "x")).toBe(false);
    expect(secretsEqual("x", undefined)).toBe(false);
  });
});

describe("randomReplyDelayMs", () => {
  it("uses the required 15s-2min window", () => {
    expect(REPLY_TARGET_MIN_MS).toBe(15_000);
    expect(REPLY_TARGET_MAX_MS).toBe(120_000);
  });

  it("always lands in the 15s-120s window and varies between draws", () => {
    const draws = Array.from({ length: 500 }, () => randomReplyDelayMs());
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(15_000);
      expect(d).toBeLessThanOrEqual(120_000);
    }
    // Varied draws, and the spread actually reaches the upper half of the range.
    expect(new Set(draws).size).toBeGreaterThan(10);
    expect(Math.max(...draws)).toBeGreaterThan(90_000);
  });
});

describe("looksLikeStructuredOutput", () => {
  it("flags the raw JSON envelope the model returns", () => {
    const leak =
      '{ "messages": ["היי אלעד, הכל בסדר גמור, מה שלומך?"], "reasoning": "Responded naturally to the user\'s greeting." }';
    expect(looksLikeStructuredOutput(leak)).toBe(true);
  });

  it("flags a truncated / unclosed envelope", () => {
    expect(looksLikeStructuredOutput('{"messages": ["היי אלעד, הכל בסדר גמור')).toBe(true);
  });

  it("flags fenced json and bare json objects/arrays", () => {
    expect(looksLikeStructuredOutput('```json\n{"messages":["hi"]}\n```')).toBe(true);
    expect(looksLikeStructuredOutput('{"foo": "bar"}')).toBe(true);
    expect(looksLikeStructuredOutput('["a","b"]')).toBe(true);
  });

  it("passes genuine natural-language replies", () => {
    expect(looksLikeStructuredOutput("היי אלעד, הכל בסדר גמור, מה שלומך?")).toBe(false);
    expect(looksLikeStructuredOutput("Sure, I can help with that.")).toBe(false);
    expect(looksLikeStructuredOutput("שלחתי לך שתי הודעות אתמול")).toBe(false);
    expect(looksLikeStructuredOutput("")).toBe(false);
  });
});

describe("stripStructuredOutput", () => {
  it("drops parts that look like raw JSON and flags the leak", () => {
    const { parts, leaked } = stripStructuredOutput(["היי אלעד", '{"reasoning":"internal note"}']);
    expect(parts).toEqual(["היי אלעד"]);
    expect(leaked).toBe(true);
  });

  it("leaves clean parts untouched", () => {
    const { parts, leaked } = stripStructuredOutput(["שלום", "מה שלומך?"]);
    expect(parts).toEqual(["שלום", "מה שלומך?"]);
    expect(leaked).toBe(false);
  });

  it("returns nothing when every part is a JSON blob (caller must send nothing)", () => {
    const { parts, leaked } = stripStructuredOutput(['{"messages":["hi"],"reasoning":"y"}']);
    expect(parts).toEqual([]);
    expect(leaked).toBe(true);
  });
});
