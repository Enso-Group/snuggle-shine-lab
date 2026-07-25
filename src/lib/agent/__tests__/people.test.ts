import { describe, expect, it } from "vitest";
import { loadOrCreatePerson, mergeFacts, type PersonFact } from "../people.server";
import type { Supa } from "../types";

const at = "2026-07-20T10:00:00.000Z";
const now = new Date("2026-07-20T12:00:00.000Z");

describe("mergeFacts", () => {
  it("appends new facts with a timestamp", () => {
    const merged = mergeFacts([], ["מעוניין בחבילת פרימיום"], now);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("מעוניין בחבילת פרימיום");
    expect(merged[0].at).toBe(now.toISOString());
  });

  it("dedupes case- and whitespace-insensitively", () => {
    const existing: PersonFact[] = [{ text: "שמו דני", at }];
    const merged = mergeFacts(existing, ["שמו  דני", "גר בחיפה"], now);
    expect(merged.map((f) => f.text)).toEqual(["שמו דני", "גר בחיפה"]);
  });

  it("drops junk facts (too short or too long)", () => {
    const merged = mergeFacts([], ["אב", "x".repeat(301), "עובדה תקינה"], now);
    expect(merged.map((f) => f.text)).toEqual(["עובדה תקינה"]);
  });

  it("caps the list, dropping the oldest first", () => {
    const existing: PersonFact[] = Array.from({ length: 40 }, (_, i) => ({
      text: `עובדה ישנה ${i}`,
      at,
    }));
    const merged = mergeFacts(existing, ["עובדה חדשה לגמרי"], now);
    expect(merged).toHaveLength(40);
    expect(merged[merged.length - 1].text).toBe("עובדה חדשה לגמרי");
    expect(merged.some((f) => f.text === "עובדה ישנה 0")).toBe(false);
  });
});

// Chainable thenable stub standing in for the PostgREST query builder — just
// enough to capture which wa_id key the lookup filters on, which is the whole
// point of the dmChatId option.
function fakeSupa(capture: { orFilters: string[] }): Supa {
  const result = {
    data: [
      {
        id: "p1",
        wa_id: "972501234567",
        display_name: "Gigi Levy Weiss",
        language: null,
        sentiment: null,
        funnel_stage: "unknown",
        facts: [],
        tags: [],
        last_seen_at: at,
      },
    ],
    error: null,
  };
  // 'any' is deliberate: typing a full PostgREST builder buys nothing here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select: () => builder,
    or: (f: string) => {
      capture.orFilters.push(f);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    update: () => builder,
    eq: () => builder,
    insert: () => builder,
    single: () => builder,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return { from: () => builder } as unknown as Supa;
}

describe("loadOrCreatePerson DM keying", () => {
  it("keys on the chat id when dmChatId is given — an '@lid' sender maps to the phone profile", async () => {
    const capture = { orFilters: [] as string[] };
    const person = await loadOrCreatePerson(fakeSupa(capture), "18803584966843@lid", "Gigi", {
      dmChatId: "972501234567@s.whatsapp.net",
    });
    expect(capture.orFilters[0]).toBe("wa_id.eq.972501234567,wa_id.like.972501234567@%");
    expect(person?.wa_id).toBe("972501234567");
  });

  it("keys on the sender id when dmChatId is absent (group messages, old call sites)", async () => {
    const capture = { orFilters: [] as string[] };
    await loadOrCreatePerson(fakeSupa(capture), "18803584966843@lid", "Gigi");
    expect(capture.orFilters[0]).toBe(
      "wa_id.eq.18803584966843@lid,wa_id.like.18803584966843@lid@%",
    );
  });

  it("returns null (no fallback to the '@lid' sender) when dmChatId does not normalize", async () => {
    const capture = { orFilters: [] as string[] };
    const person = await loadOrCreatePerson(fakeSupa(capture), "18803584966843@lid", "Gigi", {
      dmChatId: "status@broadcast",
    });
    expect(person).toBeNull();
    expect(capture.orFilters).toEqual([]);
  });
});
