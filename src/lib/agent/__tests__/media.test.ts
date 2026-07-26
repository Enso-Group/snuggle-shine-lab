// Media attachments: pure model, Whapi payloads, and demo-wipe marker safety.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mediaKindForMime, mediaLabel, parseMedia } from "@/lib/media";
import { wipeAll } from "@/lib/demo-seed";
import { makeFakeSupa, type Row } from "./fake-supa";

describe("parseMedia", () => {
  it("accepts a valid attachment (object or JSON string)", () => {
    const m = { kind: "image", url: "https://x.test/a.png", filename: "a.png", mime: "image/png" };
    expect(parseMedia(m)?.kind).toBe("image");
    expect(parseMedia(JSON.stringify(m))?.url).toBe("https://x.test/a.png");
  });

  it("rejects junk: bad kind, non-http url, null", () => {
    expect(parseMedia(null)).toBeNull();
    expect(parseMedia({ kind: "gif", url: "https://x.test/a" })).toBeNull();
    expect(parseMedia({ kind: "image", url: "ftp://x.test/a" })).toBeNull();
    expect(parseMedia({ kind: "image" })).toBeNull();
  });

  it("classifies mimes and labels attachments", () => {
    expect(mediaKindForMime("image/jpeg")).toBe("image");
    expect(mediaKindForMime("video/mp4")).toBe("video");
    expect(mediaKindForMime("application/pdf")).toBe("document");
    expect(mediaLabel({ kind: "document", url: "https://x", filename: "r.pdf" })).toBe(
      "[document: r.pdf]",
    );
  });
});

describe("whapi media senders", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("WHAPI_TOKEN", "test-token");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: { id: "wamid-media-1" } }), { status: 200 }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ["image", "/messages/image"],
    ["video", "/messages/video"],
    ["document", "/messages/document"],
  ] as const)("sends %s via %s with the caption riding along", async (kind, path) => {
    const { sendMediaMessage } = await import("@/lib/media.server");
    const res = (await sendMediaMessage(
      "972555000101@s.whatsapp.net",
      { kind, url: "https://site.test/demo/file.bin", filename: "file.bin", mime: null },
      "הודעה עם קובץ",
    )) as { message?: { id?: string } };

    expect(res.message?.id).toBe("wamid-media-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://gate.whapi.cloud${path}`);
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe("972555000101@s.whatsapp.net");
    expect(body.media).toBe("https://site.test/demo/file.bin");
    expect(body.caption).toBe("הודעה עם קובץ");
    if (kind === "document") expect(body.filename).toBe("file.bin");
  });

  it("refuses an invalid recipient before any network call", async () => {
    const { sendMediaMessage } = await import("@/lib/media.server");
    await expect(
      sendMediaMessage("not-a-chat", { kind: "image", url: "https://x.test/a.png" }, "hi"),
    ).rejects.toThrow("Invalid recipient");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("demo wipe marker safety", () => {
  it("removes ONLY demo-marked rows across every planned table", async () => {
    const fake = makeFakeSupa({
      conversations: [
        { id: "c-real", whapi_chat_id: "972500000777@s.whatsapp.net" },
        { id: "c-demo", whapi_chat_id: "demo-972555000101@s.whatsapp.net" },
      ],
      people: [
        { id: "p-real", wa_id: "972500000777" },
        { id: "p-demo", wa_id: "demo-972555000101" },
      ],
      planned_posts: [
        { id: "post-real", group_chat_id: "120363000000009999@g.us" },
        { id: "post-demo", group_chat_id: "demo-120363000000000001@g.us" },
      ],
      scheduled_approvals: [
        { id: "a-real", target_chat_id: "972500000777@s.whatsapp.net" },
        { id: "a-demo", target_chat_id: "demo-972555000101@s.whatsapp.net" },
      ],
    });

    const removed = await wipeAll(fake.client as never);

    expect(removed.conversations).toBe(1);
    expect(removed.people).toBe(1);
    expect(removed.planned_posts).toBe(1);
    expect(removed.scheduled_approvals).toBe(1);
    const ids = (t: string) => (fake.state[t] ?? []).map((r: Row) => r.id);
    expect(ids("conversations")).toEqual(["c-real"]);
    expect(ids("people")).toEqual(["p-real"]);
    expect(ids("planned_posts")).toEqual(["post-real"]);
    expect(ids("scheduled_approvals")).toEqual(["a-real"]);
  });
});
