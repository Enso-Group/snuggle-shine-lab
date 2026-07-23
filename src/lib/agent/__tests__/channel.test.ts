import { describe, expect, it } from "vitest";
import { channelOrFilter, normalizeChannelPhone } from "../channel";

describe("normalizeChannelPhone", () => {
  it("reduces any WA id spelling to a bare phone", () => {
    expect(normalizeChannelPhone("972505685888@s.whatsapp.net")).toBe("972505685888");
    expect(normalizeChannelPhone("972505685888:5@s.whatsapp.net")).toBe("972505685888");
    expect(normalizeChannelPhone("972505685888")).toBe("972505685888");
    expect(normalizeChannelPhone("+972 50-568-5888")).toBe("972505685888");
  });

  it("is empty for missing / non-numeric ids", () => {
    expect(normalizeChannelPhone("")).toBe("");
    expect(normalizeChannelPhone(null)).toBe("");
    expect(normalizeChannelPhone(undefined)).toBe("");
    expect(normalizeChannelPhone("@g.us")).toBe("");
  });
});

describe("channelOrFilter", () => {
  it("matches the account's rows plus not-yet-classified (NULL) rows", () => {
    expect(channelOrFilter("972505685888")).toBe(
      "channel_phone.is.null,channel_phone.eq.972505685888",
    );
  });

  it("only ever interpolates digits (no injection surface)", () => {
    const f = channelOrFilter(normalizeChannelPhone("972505685888:5@x"));
    expect(f).toBe("channel_phone.is.null,channel_phone.eq.972505685888");
    expect(f).not.toMatch(/[^\d,.a-z_=]/);
  });
});
