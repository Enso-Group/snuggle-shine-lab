// Pure-helper coverage for media-from-search: candidate collection order,
// byte sniffing (the honesty gate), media request detection, and the new
// source parsers (Tavily images, tweet media, Apollo people).
import { describe, expect, it } from "vitest";
import { parseTweetMedia, type XTweet } from "@/lib/apify-x.server";
import { parseApolloPeople } from "@/lib/apollo.server";
import { parseTavilyImages, type TavilySearchOutcome } from "@/lib/tavily.server";
import {
  collectMediaCandidates,
  detectsMediaRequest,
  sniffMediaBytes,
} from "../research-media.server";

const emptySearch: TavilySearchOutcome = { answer: null, results: [], images: [] };

describe("parseTavilyImages", () => {
  it("accepts plain strings and {url, description} objects, drops junk", () => {
    expect(
      parseTavilyImages([
        "https://cdn.example.com/a.jpg",
        { url: "https://cdn.example.com/b.png", description: "a chart" },
        { url: "not-a-url" },
        42,
      ]),
    ).toEqual([
      { url: "https://cdn.example.com/a.jpg", description: null },
      { url: "https://cdn.example.com/b.png", description: "a chart" },
    ]);
    expect(parseTavilyImages(undefined)).toEqual([]);
  });
});

describe("parseTweetMedia", () => {
  it("reads extendedEntities photos and picks the best mp4 variant for videos", () => {
    const media = parseTweetMedia({
      extendedEntities: {
        media: [
          { type: "photo", media_url_https: "https://pbs.twimg.com/p.jpg" },
          {
            type: "video",
            video_info: {
              variants: [
                { content_type: "video/mp4", bitrate: 320_000, url: "https://v.twimg.com/lo.mp4" },
                {
                  content_type: "video/mp4",
                  bitrate: 2_176_000,
                  url: "https://v.twimg.com/hi.mp4",
                },
                { content_type: "application/x-mpegURL", url: "https://v.twimg.com/pl.m3u8" },
              ],
            },
          },
        ],
      },
    });
    expect(media).toEqual([
      { type: "photo", url: "https://pbs.twimg.com/p.jpg" },
      { type: "video", url: "https://v.twimg.com/hi.mp4" },
    ]);
  });

  it("reads plain photos[] and dedups", () => {
    expect(
      parseTweetMedia({
        photos: ["https://pbs.twimg.com/a.jpg", { url: "https://pbs.twimg.com/a.jpg" }],
      }),
    ).toEqual([{ type: "photo", url: "https://pbs.twimg.com/a.jpg" }]);
  });
});

describe("parseApolloPeople", () => {
  it("maps people and drops nameless rows", () => {
    const people = parseApolloPeople({
      people: [
        {
          name: "Dana Cohen",
          title: "VP Marketing",
          organization: { name: "Acme" },
          linkedin_url: "https://linkedin.com/in/dana",
          email: "dana@acme.com",
          city: "Tel Aviv",
          country: "Israel",
        },
        { title: "no name" },
      ],
    });
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      name: "Dana Cohen",
      title: "VP Marketing",
      company: "Acme",
      location: "Tel Aviv, Israel",
    });
    expect(parseApolloPeople(null)).toEqual([]);
  });
});

describe("sniffMediaBytes", () => {
  const pad = (sig: number[]) => new Uint8Array([...sig, ...new Array(16).fill(0)]);
  it("recognizes real file signatures", () => {
    expect(sniffMediaBytes(pad([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      kind: "image",
      mime: "image/jpeg",
    });
    expect(sniffMediaBytes(pad([0x89, 0x50, 0x4e, 0x47]))).toEqual({
      kind: "image",
      mime: "image/png",
    });
    expect(sniffMediaBytes(pad([0x25, 0x50, 0x44, 0x46]))).toEqual({
      kind: "document",
      mime: "application/pdf",
    });
    const mp4 = new Uint8Array(16);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp" at offset 4
    expect(sniffMediaBytes(mp4)).toEqual({ kind: "video", mime: "video/mp4" });
  });
  it("rejects HTML pretending to be an image", () => {
    const html = new TextEncoder().encode("<!doctype html><html><body>404</body></html>");
    expect(sniffMediaBytes(html)).toBeNull();
  });
});

describe("collectMediaCandidates", () => {
  it("orders tavily images, then tweet media, then direct file links — deduped", () => {
    const search: TavilySearchOutcome = {
      answer: null,
      results: [
        {
          title: "Annual report",
          url: "https://example.com/report.pdf",
          content: "x",
          score: 0.9,
        },
        { title: "Article", url: "https://example.com/post", content: "x", score: 0.5 },
      ],
      images: [{ url: "https://cdn.example.com/a.jpg", description: "skyline" }],
    };
    const tweet: XTweet = {
      text: "look",
      url: "https://x.com/u/status/1",
      author: "@u",
      date: null,
      likes: null,
      retweets: null,
      media: [{ type: "photo", url: "https://pbs.twimg.com/b.jpg" }],
    };
    const candidates = collectMediaCandidates(search, { results: [tweet] });
    expect(candidates.map((c) => c.url)).toEqual([
      "https://cdn.example.com/a.jpg",
      "https://pbs.twimg.com/b.jpg",
      "https://example.com/report.pdf",
    ]);
    expect(candidates[1].sourceUrl).toBe("https://x.com/u/status/1");
    expect(candidates[2].expectedKind).toBe("document");
  });
  it("handles empty inputs", () => {
    expect(collectMediaCandidates(emptySearch, null)).toEqual([]);
    expect(collectMediaCandidates(null, null)).toEqual([]);
  });
});

describe("detectsMediaRequest", () => {
  it("matches real-media asks in Hebrew and English", () => {
    expect(detectsMediaRequest("תשלח לי תמונה של המלון")).toBe(true);
    expect(detectsMediaRequest("יש לך סרטון של האירוע?")).toBe(true);
    expect(detectsMediaRequest("can you send the PDF report?")).toBe(true);
    expect(detectsMediaRequest("מה המחיר של החבילה?")).toBe(false);
    expect(detectsMediaRequest("")).toBe(false);
  });
});
