// Media attachment model — pure, shared by the send paths, the dashboard and
// tests. An attachment is stored as jsonb ({kind, url, filename, mime}) on
// scheduled_approvals.media / planned_posts.media and sent through Whapi's
// media endpoints with the message text as its caption.

export type MediaKind = "image" | "video" | "document";

export type MediaAttachment = {
  kind: MediaKind;
  /**
   * Fetchable URL for previews (a time-limited signed URL for bucket
   * uploads, or a plain URL for site-served assets). Send paths NEVER trust
   * this directly when storage_path is set — they mint a fresh signed URL at
   * send time, because the stored one may have expired.
   */
  url: string;
  /** Storage object path when the file lives in the (private) media bucket. */
  storage_path?: string | null;
  filename?: string | null;
  mime?: string | null;
};

/** Parse a media jsonb value (object or JSON string) — null when unusable. */
export function parseMedia(raw: unknown): MediaAttachment | null {
  try {
    const m = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<MediaAttachment> | null;
    if (!m || typeof m !== "object") return null;
    const url = String(m.url ?? "").trim();
    if (!/^https?:\/\//.test(url)) return null;
    const kind = m.kind === "image" || m.kind === "video" || m.kind === "document" ? m.kind : null;
    if (!kind) return null;
    return {
      kind,
      url,
      storage_path: m.storage_path ? String(m.storage_path).slice(0, 300) : null,
      filename: m.filename ? String(m.filename).slice(0, 200) : null,
      mime: m.mime ? String(m.mime).slice(0, 100) : null,
    };
  } catch {
    return null;
  }
}

/** Classify an uploaded file into the WhatsApp media kind it sends as. */
export function mediaKindForMime(mime: string): MediaKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return "document";
}

/** Compact human label for logs and history mirrors, e.g. "[image: chart.png]". */
export function mediaLabel(media: MediaAttachment): string {
  return `[${media.kind}${media.filename ? `: ${media.filename}` : ""}]`;
}
