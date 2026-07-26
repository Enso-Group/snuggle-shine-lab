// Dashboard media endpoints (admin-gated): upload a file for attachment and
// pin/remove an attachment on a pending approval.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { parseMedia, type MediaAttachment } from "./media";

const uploadSchema = z.object({
  filename: z.string().min(1).max(300),
  mime: z.string().min(1).max(120),
  /** Raw base64 (no data: prefix). */
  dataBase64: z.string().min(1),
});

export const uploadMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => uploadSchema.parse(d))
  .handler(async ({ data }): Promise<MediaAttachment> => {
    const { uploadMediaToStorage } = await import("./media.server");
    return uploadMediaToStorage(data);
  });

const setMediaSchema = z.object({
  id: z.string().uuid(),
  /** null clears the attachment. */
  media: z
    .object({
      kind: z.enum(["image", "video", "document"]),
      url: z.string().url(),
      filename: z.string().max(200).nullish(),
      mime: z.string().max(100).nullish(),
    })
    .nullable(),
});

export const setApprovalMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => setMediaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const media = data.media ? parseMedia(data.media) : null;
    if (data.media && !media) throw new Error("Invalid attachment");
    const { error } = await context.supabase
      .from("scheduled_approvals")
      .update({ media } as never)
      .eq("id", data.id)
      .eq("status", "pending");
    if (error) {
      if (/media/.test(error.message) && /column/i.test(error.message)) {
        throw new Error(
          "Attachments need the media migration — apply supabase/migrations/20260726090000_media_attachments.sql in Lovable first.",
        );
      }
      throw new Error(error.message);
    }
    return { ok: true, media };
  });
