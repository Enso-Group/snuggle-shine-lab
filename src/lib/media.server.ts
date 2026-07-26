// Server-side media plumbing: one dispatcher for sending an attachment via
// the right Whapi endpoint, and storage upload for dashboard attachments.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mediaKindForMime, type MediaAttachment } from "./media";

const MEDIA_BUCKET = "media";
// WhatsApp's own practical caps are higher, but the upload travels as base64
// inside a server-fn payload — keep it comfortably under the request limit.
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Send an attachment (with the message text as its caption) to any chat. */
export async function sendMediaMessage(
  chatId: string,
  media: MediaAttachment,
  caption?: string,
): Promise<{ message?: { id?: string } } | Record<string, unknown>> {
  const { sendImageMessage, sendVideoMessage, sendDocumentMessage } =
    await import("./whapi.server");
  if (media.kind === "image") return sendImageMessage(chatId, media.url, caption);
  if (media.kind === "video") return sendVideoMessage(chatId, media.url, caption);
  return sendDocumentMessage(chatId, media.url, {
    caption,
    filename: media.filename ?? "file",
  });
}

function safeStorageName(filename: string): string {
  const cleaned = filename.replace(/[^\w.-]+/g, "_").slice(-80);
  return `${Date.now()}-${cleaned || "file"}`;
}

/**
 * Upload a dashboard attachment into the public `media` bucket and return the
 * attachment record the send paths consume. The bucket is created lazily with
 * the service role, so no migration is needed for storage.
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
    // First ever upload — create the public bucket, then retry once.
    const { error: bucketErr } = await supabaseAdmin.storage.createBucket(MEDIA_BUCKET, {
      public: true,
    });
    if (bucketErr && !/already exists/i.test(bucketErr.message)) {
      throw new Error(`Could not create the media bucket: ${bucketErr.message}`);
    }
    ({ error } = await doUpload());
  }
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data: pub } = supabaseAdmin.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  if (!pub?.publicUrl) throw new Error("Upload succeeded but no public URL was returned");

  return {
    kind: mediaKindForMime(args.mime),
    url: pub.publicUrl,
    filename: args.filename.slice(0, 200),
    mime: args.mime.slice(0, 100),
  };
}
