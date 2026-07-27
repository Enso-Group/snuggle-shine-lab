import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";

const scheduleSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  send_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  target_chat_id: z.string().min(1),
  target_name: z.string().nullable().optional(),
  // In "direct" mode body is the message text; in "ai" mode body is the prompt.
  body: z.string().min(1).max(4000),
  mode: z.enum(["direct", "ai"]).optional(),
  enabled: z.boolean().optional(),
  require_approval: z.boolean().optional(),
});

export const listScheduledMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("scheduled_messages")
      .select("*")
      .order("day_of_week", { ascending: true })
      .order("send_time", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => scheduleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("scheduled_messages")
      .insert({ ...data, user_id: context.userId } as any)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid() }).merge(scheduleSchema.partial()).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const { data: row, error } = await context.supabase
      .from("scheduled_messages")
      .update(patch as any)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("scheduled_messages").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listPendingApprovals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async ({ context }) => {
    let q = context.supabase
      .from("scheduled_approvals")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    // Presentation mode: only demo approvals while demo data is seeded.
    const { isDemoViewOn } = await import("./demo-seed");
    if (await isDemoViewOn(context.supabase as never)) {
      q = q.like("target_chat_id", "demo-%");
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/**
 * Approve/reject share one implementation with the WhatsApp admin agent —
 * src/lib/agent/approvals.server.ts. These fns stay the dashboard's admin-gated
 * entry points; the cores run on the service-role client.
 */
export const approvePending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: { id: string; body?: string }) =>
    z.object({ id: z.string().uuid(), body: z.string().min(1).max(4000).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { approvePendingCore } = await import("./agent/approvals.server");
    return approvePendingCore(supabaseAdmin, { id: data.id, body: data.body });
  });

export const updatePendingBody = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: { id: string; body: string }) =>
    z.object({ id: z.string().uuid(), body: z.string().min(1).max(4000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("scheduled_approvals")
      .update({ body: data.body })
      .eq("id", data.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Keep the linked planned post's body in sync so the dashboard's
    // Upcoming panel shows the edited text.
    const plannedPostId = (row as { planned_post_id?: string | null } | null)?.planned_post_id;
    if (plannedPostId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { normalizePoll, pollAsHistoryText } = await import("./agent/poll");
      const poll = normalizePoll((row as { poll?: unknown }).poll);
      const textPart = poll && data.body.trim() === poll.question.trim() ? "" : data.body;
      const plannedBody = [textPart, poll ? pollAsHistoryText(poll) : ""]
        .filter(Boolean)
        .join("\n\n");
      await supabaseAdmin
        .from("planned_posts")
        .update({ body: plannedBody, updated_at: new Date().toISOString() })
        .eq("id", plannedPostId)
        .eq("status", "queued_approval");
    }
    return { ok: true };
  });

export const rejectPending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rejectPendingCore } = await import("./agent/approvals.server");
    await rejectPendingCore(supabaseAdmin, { id: data.id });
    return { ok: true };
  });
