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

  it("round-trips storage_path (private bucket uploads need it for send-time signing)", () => {
    const m = parseMedia({
      kind: "image",
      url: "https://x.test/signed?token=abc",
      storage_path: "uploads/123-a.png",
    });
    expect(m?.storage_path).toBe("uploads/123-a.png");
    // Site-served assets carry no storage_path — parse keeps it null.
    expect(
      parseMedia({ kind: "image", url: "https://x.test/demo/a.png" })?.storage_path,
    ).toBeNull();
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

  it("HARD-refuses demo- targets on every send path — the sanitizer would launder them into real numbers", async () => {
    // demo-972555000101 digit-strips to a routable Israeli 055 number; the
    // send layer must refuse the RAW id before sanitization ever runs.
    const { sendTextMessage, sendPoll } = await import("@/lib/whapi.server");
    const { sendMediaMessage } = await import("@/lib/media.server");
    await expect(sendTextMessage("demo-972555000101@s.whatsapp.net", "hi")).rejects.toThrow(
      "Demo row",
    );
    await expect(
      sendMediaMessage(
        "demo-972555000101@s.whatsapp.net",
        { kind: "image", url: "https://x.test/a.png" },
        "hi",
      ),
    ).rejects.toThrow("Demo row");
    await expect(sendPoll("demo-120363000000000001@g.us", "q", ["a", "b"], 1)).rejects.toThrow(
      "Demo row",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("demo presentation mode (demo_view flag)", () => {
  it("seed-view flag round-trips through agent_config without clobbering other knobs", async () => {
    const { isDemoViewOn, setDemoView } = await import("@/lib/demo-seed");
    const fake = makeFakeSupa({
      bot_settings: [
        {
          id: "settings-1",
          agent_config: { follow_ups_enabled: true },
          created_at: new Date().toISOString(),
        },
      ],
    });

    expect(await isDemoViewOn(fake.client as never)).toBe(false);
    await setDemoView(fake.client as never, true);
    expect(await isDemoViewOn(fake.client as never)).toBe(true);
    // Other knobs survive the merge.
    const cfg = fake.state.bot_settings[0].agent_config as Record<string, unknown>;
    expect(cfg.follow_ups_enabled).toBe(true);
    await setDemoView(fake.client as never, false);
    expect(await isDemoViewOn(fake.client as never)).toBe(false);
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

    const { removed, failed } = await wipeAll(fake.client as never);

    expect(failed).toEqual({});
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
