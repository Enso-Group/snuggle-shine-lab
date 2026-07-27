// Recognition rules for WhatsApp admins — the security matrix lives here:
// phone-digit matching only, DMs only, fail-closed on every odd id shape.
import { describe, expect, it } from "vitest";
import {
  adminChatId,
  findWaAdmin,
  normalizeAdminPhone,
  parseWaAdmins,
  type WaAdmin,
} from "../wa-admins";

const ADMINS: WaAdmin[] = [
  { phone: "972501111111", label: "Itamar" },
  { phone: "972529999999", label: "Backup" },
];

describe("normalizeAdminPhone", () => {
  it("converts local Israeli numbers to international digits", () => {
    expect(normalizeAdminPhone("0501111111")).toBe("972501111111");
    expect(normalizeAdminPhone("050-111-1111")).toBe("972501111111");
  });

  it("accepts international forms as digits", () => {
    expect(normalizeAdminPhone("+972 50 111 1111")).toBe("972501111111");
    expect(normalizeAdminPhone("972501111111")).toBe("972501111111");
  });

  it("rejects junk, group ids and demo markers", () => {
    expect(normalizeAdminPhone("")).toBeNull();
    expect(normalizeAdminPhone("abc")).toBeNull();
    expect(normalizeAdminPhone("123")).toBeNull();
    expect(normalizeAdminPhone("120363222944584134@g.us")).toBeNull();
    expect(normalizeAdminPhone("demo-9725550011")).toBeNull();
    expect(normalizeAdminPhone("1".repeat(20))).toBeNull();
  });
});

describe("parseWaAdmins", () => {
  it("parses a stored list and normalizes phones", () => {
    const parsed = parseWaAdmins([
      { phone: "0501111111", label: "Itamar", added_at: "2026-07-27T00:00:00Z" },
    ]);
    expect(parsed).toEqual([
      { phone: "972501111111", label: "Itamar", added_at: "2026-07-27T00:00:00Z" },
    ]);
  });

  it("drops malformed entries and tolerates non-array input", () => {
    expect(parseWaAdmins(null)).toEqual([]);
    expect(parseWaAdmins("nope")).toEqual([]);
    expect(parseWaAdmins([{ phone: "junk", label: "x" }, null, 42])).toEqual([]);
  });

  it("falls back to the phone when the label is empty", () => {
    expect(parseWaAdmins([{ phone: "972501111111", label: "" }])[0].label).toBe("972501111111");
  });
});

describe("findWaAdmin — the security matrix", () => {
  it("matches an admin DM chat id by canonical digits", () => {
    expect(findWaAdmin(ADMINS, "972501111111@s.whatsapp.net")?.label).toBe("Itamar");
    expect(findWaAdmin(ADMINS, "972501111111@c.us")?.label).toBe("Itamar");
  });

  it("never matches groups, channels or simulation ids", () => {
    expect(findWaAdmin(ADMINS, "972501111111@g.us")).toBeNull();
    expect(findWaAdmin(ADMINS, "972501111111@newsletter")).toBeNull();
    expect(findWaAdmin(ADMINS, "972501111111@broadcast")).toBeNull();
    expect(findWaAdmin(ADMINS, "972501111111@simulation")).toBeNull();
  });

  it("never matches '@lid' ids even when the digits collide with an admin phone", () => {
    // LinkedDevice ids are numeric but NOT phone numbers — a collision here
    // would hand management mode to a stranger.
    expect(findWaAdmin(ADMINS, "972501111111@lid")).toBeNull();
  });

  it("never matches near-miss digits or non-admin phones", () => {
    expect(findWaAdmin(ADMINS, "9725011111112@s.whatsapp.net")).toBeNull();
    expect(findWaAdmin(ADMINS, "972501111112@s.whatsapp.net")).toBeNull();
    expect(findWaAdmin(ADMINS, "15551234567@s.whatsapp.net")).toBeNull();
  });

  it("handles empty lists and empty ids", () => {
    expect(findWaAdmin([], "972501111111@s.whatsapp.net")).toBeNull();
    expect(findWaAdmin(undefined, "972501111111@s.whatsapp.net")).toBeNull();
    expect(findWaAdmin(ADMINS, "")).toBeNull();
    expect(findWaAdmin(ADMINS, null)).toBeNull();
  });
});

describe("adminChatId", () => {
  it("builds the DM chat id for notifications", () => {
    expect(adminChatId(ADMINS[0])).toBe("972501111111@s.whatsapp.net");
  });
});
