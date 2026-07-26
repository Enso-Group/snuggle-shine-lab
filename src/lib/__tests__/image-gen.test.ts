// Pure parts of the gateway image generation: response parsing across the
// provider shapes, and data-URL splitting.
import { describe, expect, it } from "vitest";

import { extractImageDataUrl, splitDataUrl } from "../image-gen.server";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg".repeat(10);

describe("extractImageDataUrl", () => {
  it("reads the documented Lovable shape (message.images[0].image_url.url)", () => {
    const url = extractImageDataUrl({
      choices: [
        { message: { images: [{ image_url: { url: `data:image/png;base64,${PNG_B64}` } }] } },
      ],
    });
    expect(url).toContain("data:image/png;base64,");
  });

  it("reads image parts inside a content array", () => {
    const url = extractImageDataUrl({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "here you go" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG_B64}` } },
            ],
          },
        },
      ],
    });
    expect(url).toContain("data:image/jpeg;base64,");
  });

  it("reads images-API style data[0].b64_json", () => {
    const url = extractImageDataUrl({ data: [{ b64_json: PNG_B64 }] });
    expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it("returns null for text-only responses", () => {
    expect(
      extractImageDataUrl({ choices: [{ message: { content: "I cannot generate that." } }] }),
    ).toBeNull();
    expect(extractImageDataUrl(null)).toBeNull();
    expect(extractImageDataUrl({})).toBeNull();
  });
});

describe("splitDataUrl", () => {
  it("splits mime and base64", () => {
    const s = splitDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(s?.mime).toBe("image/png");
    expect(s?.base64).toBe(PNG_B64);
  });
  it("rejects non-data URLs", () => {
    expect(splitDataUrl("https://example.com/x.png")).toBeNull();
  });
});
