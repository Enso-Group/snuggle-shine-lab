import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";
import type { Supa } from "./agent/types";
import type { Json } from "@/integrations/supabase/types";

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
    const { data, error } = await context.supabase
      .from("scheduled_approvals")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

type ApprovalRowShape = {
  id: string;
  target_chat_id: string;
  target_name: string | null;
  body: string;
  source: string;
  conversation_id: string | null;
  planned_post_id?: string | null;
};

/**
 * The planned_posts row a group-post approval controls. Prefer the explicit
 * planned_post_id link; legacy rows created before the link column exist fall
 * back to the queued post in the same group — unambiguous when only one is
 * queued, else matched by body containment.
 */
async function resolvePlannedPostId(admin: Supa, row: ApprovalRowShape): Promise<string | null> {
  if (row.planned_post_id) return row.planned_post_id;
  if (row.source !== "group_post") return null;
  const { data: queued } = await admin
    .from("planned_posts")
    .select("id, body")
    .eq("group_chat_id", row.target_chat_id)
    .eq("status", "queued_approval");
  if (!queued?.length) return null;
  if (queued.length === 1) return queued[0].id;
  return queued.find((p) => (p.body ?? "").includes(row.body))?.id ?? null;
}

export const approvePending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: { id: string; body?: string }) =>
    z.object({ id: z.string().uuid(), body: z.string().min(1).max(4000).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const log = (msg: string) => console.log(`[approve ${data.id.slice(0, 8)}] ${msg}`);
    const warnings: string[] = [];

    const { data: row, error } = await context.supabase
      .from("scheduled_approvals")
      .select("*")
      .eq("id", data.id)
      .eq("status", "pending")
      .maybeSingle();
    if (error) {
      log(`FAILED loading approval row: ${error.message}`);
      throw new Error(error.message);
    }
    if (!row) {
      log("no pending row found (already decided?)");
      throw new Error("Not found");
    }
    const body = data.body ?? row.body;
    const { sendTextMessage, sendPoll } = await import("./whapi.server");
    const { normalizePoll, pollCount, pollAsHistoryText } = await import("./agent/poll");
    const poll = normalizePoll((row as { poll?: unknown }).poll);
    log(
      `row loaded: source=${row.source} chat=${row.target_chat_id} poll=${
        poll
          ? `${poll.options.length} options (raw present)`
          : (row as { poll?: unknown }).poll
            ? "RAW PRESENT BUT INVALID"
            : "none"
      } planned_post_id=${(row as ApprovalRowShape).planned_post_id ?? "null"}`,
    );

    // Poll-only approvals store the poll question as their body; send just the
    // native poll then, so the question doesn't go out twice.
    const textBody = poll && body.trim() === poll.question.trim() ? "" : body;
    type SendResult = { message?: { id?: string } } | null;
    let textRes: SendResult = null;
    if (textBody) {
      textRes = (await sendTextMessage(row.target_chat_id, textBody)) as SendResult;
      log(`text sent, whapi id=${textRes?.message?.id ?? "?"}`);
    }
    // A poll failure must never strand the approval: the text is already in
    // the group, so record the state transition regardless and surface the
    // poll error to the UI instead of aborting half-way.
    let pollRes: SendResult = null;
    if (poll) {
      try {
        pollRes = (await sendPoll(
          row.target_chat_id,
          poll.question,
          poll.options,
          pollCount(poll),
        )) as SendResult;
        log(`poll sent, whapi id=${pollRes?.message?.id ?? "?"}`);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        log(`POLL SEND FAILED: ${msg}`);
        warnings.push(`Text sent, but the poll failed: ${msg}`);
      }
    }

    const { error: decideErr } = await context.supabase
      .from("scheduled_approvals")
      .update({ status: "approved", decided_at: new Date().toISOString(), body })
      .eq("id", row.id);
    if (decideErr) {
      log(`FAILED marking approval approved: ${decideErr.message}`);
      throw new Error(`Message sent, but recording the approval failed: ${decideErr.message}`);
    }
    log("approval marked approved");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Move the linked planned post out of the approval queue so the dashboard
    // shows it under Recent posts instead of Upcoming.
    const plannedPostId = await resolvePlannedPostId(supabaseAdmin, row as ApprovalRowShape);
    log(`planned post resolved: ${plannedPostId ?? "none"}`);
    if (plannedPostId) {
      const plannedBody = [textBody, poll && pollRes ? pollAsHistoryText(poll) : ""]
        .filter(Boolean)
        .join("\n\n");
      const { error: postErr } = await supabaseAdmin
        .from("planned_posts")
        .update({
          body: plannedBody || body,
          status: "sent",
          sent_at: new Date().toISOString(),
          whapi_message_id: textRes?.message?.id ?? pollRes?.message?.id ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", plannedPostId)
        .eq("status", "queued_approval");
      if (postErr) {
        log(`FAILED planned post update: ${postErr.message}`);
        warnings.push(`Post sent but the dashboard row didn't update: ${postErr.message}`);
      } else {
        log("planned post -> sent");
      }
    }

    // Mirror the outbound into the conversation history. AI replies carry
    // their conversation_id; group posts are looked up by chat id.
    let conversationId = row.conversation_id;
    if (!conversationId && plannedPostId) {
      const { data: conv } = await supabaseAdmin
        .from("conversations")
        .select("id")
        .eq("whapi_chat_id", row.target_chat_id)
        .maybeSingle();
      conversationId = conv?.id ?? null;
    }
    if (conversationId) {
      if (textBody) {
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          whapi_message_id: textRes?.message?.id ?? null,
          direction: "outbound",
          sender_name: "Bot",
          sender_id: "bot",
          body: textBody,
          raw: textRes as Json,
        });
      }
      if (poll && pollRes) {
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          whapi_message_id: pollRes?.message?.id ?? null,
          direction: "outbound",
          sender_name: "Bot",
          sender_id: "bot",
          body: pollAsHistoryText(poll),
          raw: pollRes as Json,
        });
      }
      log("mirrored to conversation");
      // Anti-ban pacing only tracks the DM reply pipeline.
      if (row.conversation_id) {
        const { recordOutbound } = await import("./anti-ban.server");
        await recordOutbound(supabaseAdmin, row.conversation_id, body);
      }
    }

    const { logDecision } = await import("./agent/decisions.server");
    if (plannedPostId) {
      logDecision(supabaseAdmin, {
        chat_id: row.target_chat_id,
        trigger: "scheduled",
        stage: "post",
        status: warnings.length ? "error" : "ok",
        summary: warnings.length
          ? `Approved post published in ${row.target_name ?? row.target_chat_id}, with problems: ${warnings.join("; ")}`
          : `Approved post published in ${row.target_name ?? row.target_chat_id}`,
        data: { planned_post_id: plannedPostId, post: textBody || body },
      });
    } else if (warnings.length) {
      logDecision(supabaseAdmin, {
        chat_id: row.target_chat_id,
        trigger: "scheduled",
        stage: "error",
        status: "error",
        summary: `Approval ${data.id.slice(0, 8)} sent with problems: ${warnings.join("; ")}`,
      });
    }
    log(warnings.length ? `done with warnings: ${warnings.join("; ")}` : "done");
    return { ok: true, warnings };
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
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("scheduled_approvals")
      .update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Cancel the linked queued post so it leaves the Upcoming panel too.
    if (row) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const plannedPostId = await resolvePlannedPostId(supabaseAdmin, row as ApprovalRowShape);
      if (plannedPostId) {
        await supabaseAdmin
          .from("planned_posts")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", plannedPostId)
          .eq("status", "queued_approval");
      }
    }
    return { ok: true };
  });
