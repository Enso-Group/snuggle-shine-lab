import { describe, expect, it } from "vitest";
import { prettyUrl } from "../url-display";

describe("prettyUrl", () => {
  it("decodes percent-encoded Hebrew slugs to readable Hebrew", () => {
    const encoded =
      "https://blog.glidaiproperties.com/blog/%D7%94%D7%A9%D7%A7%D7%A2%D7%95%D7%AA-%D7%A0%D7%93%D7%9C%D7%9F";
    expect(prettyUrl(encoded)).toBe("https://blog.glidaiproperties.com/blog/השקעות-נדלן");
  });

  it("returns plain ASCII URLs untouched", () => {
    const url = "https://example.com/blog/some-post?utm=x";
    expect(prettyUrl(url)).toBe(url);
  });

  it("keeps reserved separators encoded-safe (query/hash survive)", () => {
    const url = "https://example.com/a%20b/%D7%90?x=1#top";
    const out = prettyUrl(url);
    expect(out).toContain("?x=1#top");
    // A decoded space would cut WhatsApp's linkification short — must stay %20.
    expect(out).not.toContain(" ");
    expect(out).toContain("%20");
    expect(out).toContain("א");
  });

  it("returns malformed escape sequences as-is instead of throwing", () => {
    const bad = "https://example.com/%E0%A4%A";
    expect(prettyUrl(bad)).toBe(bad);
  });

  it("handles empty/null-ish input", () => {
    expect(prettyUrl("")).toBe("");
    expect(prettyUrl(undefined as unknown as string)).toBe("");
  });
});
