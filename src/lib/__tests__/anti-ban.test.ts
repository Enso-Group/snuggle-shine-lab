import { describe, expect, it } from "vitest";
import { isWhapiRestrictionError } from "../anti-ban.server";

// A positive here auto-disables the entire bot (bot_settings.enabled=false),
// so the classifier must only fire on a genuine WhatsApp-side restriction.
describe("isWhapiRestrictionError", () => {
  it("matches real WhatsApp/Whapi restrictions", () => {
    expect(isWhapiRestrictionError(new Error("Your account was banned by WhatsApp"))).toBe(true);
    expect(isWhapiRestrictionError(new Error("blocked by whatsapp"))).toBe(true);
    expect(isWhapiRestrictionError(new Error("Whapi: account restricted"))).toBe(true);
    expect(isWhapiRestrictionError(new Error("WHATSAPP: BANNED"))).toBe(true);
    // Non-Error values are stringified before matching.
    expect(isWhapiRestrictionError("whatsapp account restricted")).toBe(true);
  });

  it("ignores a bare forbidden/403 — a bad Whapi token is not a ban", () => {
    expect(isWhapiRestrictionError(new Error("Forbidden"))).toBe(false);
    expect(isWhapiRestrictionError(new Error("403 Forbidden"))).toBe(false);
    expect(isWhapiRestrictionError(new Error("whapi request failed: 403 forbidden"))).toBe(false);
  });

  it("ignores restriction words without WhatsApp/Whapi context", () => {
    expect(isWhapiRestrictionError(new Error("access restricted for this API key"))).toBe(false);
    expect(isWhapiRestrictionError(new Error("user banned from forum"))).toBe(false);
    expect(isWhapiRestrictionError(new Error("request blocked by firewall"))).toBe(false);
  });

  it("ignores WhatsApp context without a restriction word", () => {
    expect(isWhapiRestrictionError(new Error("whapi request timed out"))).toBe(false);
    expect(isWhapiRestrictionError(new Error("whatsapp media download failed"))).toBe(false);
  });

  it("handles non-error inputs safely", () => {
    expect(isWhapiRestrictionError(null)).toBe(false);
    expect(isWhapiRestrictionError(undefined)).toBe(false);
    expect(isWhapiRestrictionError("")).toBe(false);
  });
});
