import { describe, expect, it } from "vitest";
import { normalizeWaId } from "../wa-id";

describe("normalizeWaId", () => {
  it("collapses every phone spelling to bare digits", () => {
    expect(normalizeWaId("972501234567")).toBe("972501234567");
    expect(normalizeWaId("972501234567@s.whatsapp.net")).toBe("972501234567");
    expect(normalizeWaId("972501234567@c.us")).toBe("972501234567");
    expect(normalizeWaId("972501234567:5@s.whatsapp.net")).toBe("972501234567");
    expect(normalizeWaId("972501234567:12")).toBe("972501234567");
    expect(normalizeWaId("+972-50-123-4567")).toBe("972501234567");
  });

  it("keeps non-phone identities raw (@lid, @simulation)", () => {
    expect(normalizeWaId("18803584966843@lid")).toBe("18803584966843@lid");
    expect(normalizeWaId("sim-abc123@simulation")).toBe("sim-abc123@simulation");
  });

  it("rejects groups — they are never people", () => {
    expect(normalizeWaId("120363000000000001@g.us")).toBe(null);
  });

  it("rejects empties and our own sender sentinels", () => {
    expect(normalizeWaId(null)).toBe(null);
    expect(normalizeWaId(undefined)).toBe(null);
    expect(normalizeWaId("")).toBe(null);
    expect(normalizeWaId("bot")).toBe(null);
    expect(normalizeWaId("manual")).toBe(null);
  });

  it("rejects ids with fewer than 5 digits", () => {
    expect(normalizeWaId("123@s.whatsapp.net")).toBe(null);
    expect(normalizeWaId("abcd")).toBe(null);
    expect(normalizeWaId("1234")).toBe(null);
    expect(normalizeWaId("12345")).toBe("12345");
  });
});
