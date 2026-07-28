// Media-from-search: turn research results (Tavily image results, X/Twitter
// tweet media, direct file links inside web results) into a REAL, validated
// WhatsApp attachment. The contract is honesty: a candidate is only ever sent
// after its bytes were downloaded, sniffed (magic numbers, not just headers)
// and re-hosted in our own storage bucket — a dead link or an HTML error page
// dressed as an image must never reach a chat. When nothing survives
// validation the caller says so instead of sending garbage.
import type { XSearchOutcome } from "@/lib/apify-x.server";
import type { MediaAttachment } from "@/lib/media";
import type { TavilySearchOutcome } from "@/lib/tavily.server";

// WhatsApp/Whapi practical cap and the storage upload cap (12MB) — anything
// larger is skipped, not truncated.
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MIN_MEDIA_BYTES = 2 * 1024; // smaller than 2KB is a tracking pixel/error stub
const FETCH_TIMEOUT_MS = 8_000;

export type ResearchMediaCandidate = {
  url: string;
  /** Where a human can see it in context — the tweet / article, not the file. */
  sourceUrl: string;
  /** Short label for captions/logs (image description, tweet author…). */
  label: string | null;
  expectedKind: "image" | "video" | "document";
};

export type StoredResearchMedia = {
  attachment: MediaAttachment;
  sourceUrl: string;
  label: string | null;
};

// Direct file links that sometimes appear as Tavily RESULT urls (a PDF report,
// a hosted image). Conservative on purpose — only unambiguous extensions.
const DIRECT_FILE_RE = /\.(pdf|png|jpe?g|gif|webp|mp4)(\?|#|$)/i;

/**
 * Rank every sendable-media candidate the research surfaced. Order: X media
 * first when the question came from X-heavy asks? No — Tavily images lead
 * (usually topical stock/article images), then tweet photos/videos, then
 * direct file links found among the web results. Pure — unit-tested.
 */
export function collectMediaCandidates(
  search: TavilySearchOutcome | null,
  x: XSearchOutcome | null,
): ResearchMediaCandidate[] {
  const out: ResearchMediaCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: ResearchMediaCandidate) => {
    if (!/^https?:\/\//.test(c.url) || seen.has(c.url)) return;
    seen.add(c.url);
    out.push(c);
  };

  for (const img of search?.images ?? []) {
    push({
      url: img.url,
      sourceUrl: img.url,
      label: img.description,
      expectedKind: "image",
    });
  }
  for (const tweet of x?.results ?? []) {
    for (const m of tweet.media ?? []) {
      push({
        url: m.url,
        sourceUrl: tweet.url,
        label: `${tweet.author}: ${tweet.text.slice(0, 120)}`,
        expectedKind: m.type === "video" ? "video" : "image",
      });
    }
  }
  for (const r of search?.results ?? []) {
    const m = r.url.match(DIRECT_FILE_RE);
    if (!m) continue;
    const ext = m[1].toLowerCase();
    push({
      url: r.url,
      sourceUrl: r.url,
      label: r.title || null,
      expectedKind: ext === "pdf" ? "document" : ext === "mp4" ? "video" : "image",
    });
  }
  return out;
}

/** Magic-number sniff → {kind, mime}; null when the bytes are none of ours. */
export function sniffMediaBytes(
  bytes: Uint8Array,
): { kind: "image" | "video" | "document"; mime: string } | null {
  if (bytes.length < 12) return null;
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (startsWith([0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png" };
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { kind: "image", mime: "image/gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return { kind: "image", mime: "image/webp" };
  if (ascii(4, 8) === "ftyp") return { kind: "video", mime: "video/mp4" };
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return { kind: "document", mime: "application/pdf" };
  return null;
}

function filenameFor(url: string, mime: string): string {
  const base = (() => {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
      return last.replace(/[^\w.-]+/g, "_").slice(-60);
    } catch {
      return "";
    }
  })();
  if (base && /\.\w{2,4}$/.test(base)) return base;
  const ext = mime.includes("jpeg")
    ? "jpg"
    : mime.includes("png")
      ? "png"
      : mime.includes("gif")
        ? "gif"
        : mime.includes("webp")
          ? "webp"
          : mime.includes("mp4")
            ? "mp4"
            : "pdf";
  return `${base || "research-media"}.${ext}`;
}

/**
 * Download one candidate, validate it is a real image/video/PDF, and re-host
 * it in the private media bucket. Returns null (with a console note) instead
 * of throwing — the caller iterates candidates.
 */
async function fetchAndStoreOne(
  c: ResearchMediaCandidate,
  timeoutMs: number,
): Promise<StoredResearchMedia | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(c.url, {
      signal: ctrl.signal,
      headers: {
        // Some CDNs refuse bare fetches; a browsery UA keeps real files coming.
        "User-Agent": "Mozilla/5.0 (compatible; research-media-fetch)",
        Accept: "image/*,video/*,application/pdf,*/*",
      },
    });
    if (!res.ok) return null;
    const lenHeader = Number(res.headers.get("content-length") ?? 0);
    if (lenHeader > MAX_MEDIA_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < MIN_MEDIA_BYTES || buf.length > MAX_MEDIA_BYTES) return null;
    const sniffed = sniffMediaBytes(buf);
    // The bytes decide the kind — a "photo" URL serving HTML dies here.
    if (!sniffed) return null;
    const { uploadMediaToStorage } = await import("@/lib/media.server");
    const attachment = await uploadMediaToStorage({
      filename: filenameFor(c.url, sniffed.mime),
      mime: sniffed.mime,
      dataBase64: Buffer.from(buf).toString("base64"),
    });
    return { attachment, sourceUrl: c.sourceUrl, label: c.label };
  } catch (e) {
    console.warn("[research-media] candidate fetch failed:", c.url.slice(0, 120), e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try candidates in order until one downloads AND validates, within budgetMs.
 * `preferKind` bubbles matching candidates to the front (someone who asked for
 * a video should get the tweet video before a stock image).
 */
export async function fetchFirstUsableMedia(
  candidates: ResearchMediaCandidate[],
  opts: { budgetMs?: number; preferKind?: "image" | "video" | "document" | null } = {},
): Promise<StoredResearchMedia | null> {
  const deadline = Date.now() + (opts.budgetMs ?? 15_000);
  const ordered = opts.preferKind
    ? [
        ...candidates.filter((c) => c.expectedKind === opts.preferKind),
        ...candidates.filter((c) => c.expectedKind !== opts.preferKind),
      ]
    : candidates;
  for (const c of ordered.slice(0, 5)) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) break;
    const stored = await fetchAndStoreOne(c, Math.min(FETCH_TIMEOUT_MS, remaining));
    if (stored) return stored;
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Did they ask for actual media?" — deterministic detector used to decide
// whether a research answer should carry a found file. Distinct from
// image_request (CREATE an image) and detectsResourceRequest (any resource):
// this is specifically photos/videos/files that exist out there.
// ---------------------------------------------------------------------------
const HB = "(^|[^\\u05d0-\\u05ea])"; // Hebrew-safe left boundary (see research.ts)
const MEDIA_REQUEST_PATTERNS: RegExp[] = [
  new RegExp(`${HB}(תמונה|תמונות|צילום|וידאו|וידיאו|סרטון|קובץ|מסמך|מצגת|PDF)`, "i"),
  /\b(photo|picture|image|video|clip|file|pdf|screenshot)\b/i,
];

export function detectsMediaRequest(text: string): boolean {
  if (!text) return false;
  return MEDIA_REQUEST_PATTERNS.some((re) => re.test(text));
}
