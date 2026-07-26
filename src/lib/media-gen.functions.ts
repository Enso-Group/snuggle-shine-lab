// AI image generation for the dashboard (admin-gated): generate an image for
// a pending approval from its own text, attach it, and return it for preview.
// The heavy lifting lives in image-gen.server.ts (Lovable AI gateway).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import type { MediaAttachment } from "./media";

export type GenerateApprovalImageResult = {
  media: MediaAttachment;
  model: string;
  prompt: string;
};

export const generateApprovalImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        /** Optional manager guidance, e.g. "something with a rocket". */
        instruction: z.string().max(400).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<GenerateApprovalImageResult> => {
    const { data: row, error } = await context.supabase
      .from("scheduled_approvals")
      .select("id, body, status")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Approval not found");
    if (row.status !== "pending") throw new Error("This approval is no longer pending.");
    const body = String(row.body ?? "").trim();
    if (!body) throw new Error("This approval has no text to base an image on.");

    const { writeImagePrompt, generateImage } = await import("./image-gen.server");
    const prompt = await writeImagePrompt({ postText: body, instruction: data.instruction });
    const generated = await generateImage(prompt, { source: "approval_image_gen" });

    // Attach — only while still pending (same guard as setApprovalMedia).
    const { data: updated, error: attachErr } = await context.supabase
      .from("scheduled_approvals")
      .update({ media: generated.attachment } as never)
      .eq("id", data.id)
      .eq("status", "pending")
      .select("id");
    if (attachErr) throw new Error(attachErr.message);
    if (!updated?.length) {
      throw new Error("The approval was decided while generating — the image was not attached.");
    }

    const { logDecision } = await import("./agent/decisions.server");
    logDecision(context.supabase, {
      trigger: "scheduled",
      stage: "config",
      summary: `AI image generated and attached to a pending approval (${generated.model})`,
      data: {
        approval_id: data.id,
        model: generated.model,
        prompt: generated.prompt.slice(0, 400),
        storage_path: generated.attachment.storage_path,
      },
    });
    return { media: generated.attachment, model: generated.model, prompt: generated.prompt };
  });
