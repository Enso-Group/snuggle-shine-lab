// Server-side media plumbing: one dispatcher for sending an attachment via
// the right Whapi endpoint, and storage upload for dashboard attachments.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mediaKindForMime, type MediaAttachment } from "./media";

const MEDIA_BUCKET = "media";
// WhatsApp's own practical caps are higher, but the upload travels as base64
// inside a server-fn payload — keep it comfortably under the request limit.
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
// The environment forces storage buckets PRIVATE (Lovable blocks public
// buckets), so bucket files are reachable only via signed URLs. Previews get
// a week; sends mint a FRESH short-lived URL at send time, because days can
// pass between attaching and approving.
const PREVIEW_SIGNED_TTL_S = 7 * 24 * 3600;
const SEND_SIGNED_TTL_S = 3600;

/**
 * The URL Whapi should fetch: site-served assets (e.g. /demo samples) pass
 * through as-is; bucket uploads get a freshly signed URL so expiry of the
 * stored preview link can never break a send.
 */
async function resolveSendableUrl(media: MediaAttachment): Promise<string> {
  if (!media.storage_path) return media.url;
  const { data, error } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(media.storage_path, SEND_SIGNED_TTL_S);
  if (error || !data?.signedUrl) {
    throw new Error(`Could not sign the attachment URL: ${error?.message ?? "no URL returned"}`);
  }
  return data.signedUrl;
}

/** Send an attachment (with the message text as its caption) to any chat. */
export async function sendMediaMessage(
  chatId: string,
  media: MediaAttachment,
  caption?: string,
): Promise<{ message?: { id?: string } } | Record<string, unknown>> {
  const { sendImageMessage, sendVideoMessage, sendDocumentMessage } =
    await import("./whapi.server");
  // Demo fence first — never sign/spend anything for a demo target.
  const { isDemoTarget } = await import("./whapi.server");
  if (isDemoTarget(chatId)) {
    throw new Error("Demo row — WhatsApp sends are disabled for demo- targets.");
  }
  const url = await resolveSendableUrl(media);
  if (media.kind === "image") return sendImageMessage(chatId, url, caption);
  if (media.kind === "video") return sendVideoMessage(chatId, url, caption);
  return sendDocumentMessage(chatId, url, {
    caption,
    filename: media.filename ?? "file",
  });
}

function safeStorageName(filename: string): string {
  const cleaned = filename.replace(/[^\w.-]+/g, "_").slice(-80);
  return `${Date.now()}-${cleaned || "file"}`;
}

/**
 * Upload a dashboard attachment into the (private) `media` bucket and return
 * the attachment record the send paths consume. The bucket is created lazily
 * with the service role; url is a week-long signed URL for previews, and
 * storage_path lets every send mint a fresh one.
 */
export async function uploadMediaToStorage(args: {
  filename: string;
  mime: string;
  dataBase64: string;
}): Promise<MediaAttachment> {
  const bytes = Buffer.from(args.dataBase64, "base64");
  if (!bytes.length) throw new Error("Empty file");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File is too large (${Math.round(bytes.length / 1024 / 1024)}MB) — the limit is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`,
    );
  }

  const path = `uploads/${safeStorageName(args.filename)}`;
  const doUpload = () =>
    supabaseAdmin.storage.from(MEDIA_BUCKET).upload(path, bytes, {
      contentType: args.mime || "application/octet-stream",
      upsert: false,
    });

  let { error } = await doUpload();
  if (error && /bucket/i.test(error.message)) {
    // First ever upload — create the bucket, then retry once. Private is
    // fine (and all this environment allows): access goes via signed URLs.
    const { error: bucketErr } = await supabaseAdmin.storage.createBucket(MEDIA_BUCKET, {
      public: false,
    });
    if (bucketErr && !/already exists/i.test(bucketErr.message)) {
      throw new Error(`Could not create the media bucket: ${bucketErr.message}`);
    }
    ({ error } = await doUpload());
  }
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, PREVIEW_SIGNED_TTL_S);
  if (signErr || !signed?.signedUrl) {
    throw new Error(
      `Upload succeeded but signing the URL failed: ${signErr?.message ?? "no URL returned"}`,
    );
  }

  return {
    kind: mediaKindForMime(args.mime),
    url: signed.signedUrl,
    storage_path: path,
    filename: args.filename.slice(0, 200),
    mime: args.mime.slice(0, 100),
  };
}
