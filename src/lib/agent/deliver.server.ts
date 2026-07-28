// Human-like delivery: mark the inbound as read, type for a believable
// duration, send the reply as 1–3 WhatsApp-natural messages with short pauses,
// and record every outbound row. Pacing is skipped in simulation.
import type { Json } from "@/integrations/supabase/types";
import type { Supa } from "./types";
import {
  interPartDelayMs,
  isDmChatId,
  MAX_DM_PACING_MS,
  planPacing,
  typingSecondsFor,
} from "./inbound";
import { logDecision } from "./decisions.server";
import type { AgentContext, WhapiPort } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Upper bound on total pacing (typing + pauses) so a delivery can never push
// the serverless request toward its timeout. Groups only — DMs answer under a
// 90s SLA and get the tighter, proportionally-scaled MAX_DM_PACING_MS plan.
const MAX_TOTAL_PACING_MS = 12_000;

export type DeliveryResult = {
  sentMessageIds: Array<string | null>;
  parts: string[];
  /** Set when the send-layer approval guard queued the message instead. */
  queuedApprovalId?: string | null;
};

/**
 * Queue a bot-initiated 1-on-1 message for human approval instead of sending
 * it. THE enforcement primitive behind the global approval toggle (which
 * covers private chats only — rule 2026-07-28): every DM send path funnels
 * through it when the toggle is on, including the canned lines that used to
 * bypass approval by design. Dedupes against an identical pending approval so
 * retries never stack duplicates. Returns the approval row id (or null when
 * queuing itself failed — the caller's error handling owns that).
 */
export async function queueDmForApproval(
  supabase: Supa,
  args: {
    conversationId: string | null;
    chatId: string;
    targetName: string | null;
    body: string;
    /** For the immediate WhatsApp-admin ping; omit in tests. */
    whapi?: WhapiPort;
  },
): Promise<string | null> {
  // Identical pending approval already queued (crash-retry, watchdog re-run)
  // → that row is the decision; never stack a duplicate.
  const { data: existing } = await supabase
    .from("scheduled_approvals")
    .select("id")
    .eq("target_chat_id", args.chatId)
    .eq("status", "pending")
    .eq("body", args.body)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return String(existing.id);

  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  let ownerUserId: string | null = adminRole?.user_id ?? null;
  if (!ownerUserId) {
    const {
      data: { users },
    } = await supabase.auth.admin.listUsers({ perPage: 1 });
    ownerUserId = users?.[0]?.id ?? null;
  }
  if (!ownerUserId) return null;

  const { data: row, error } = await supabase
    .from("scheduled_approvals")
    .insert({
      user_id: ownerUserId,
      conversation_id: args.conversationId,
      target_chat_id: args.chatId,
      target_name: args.targetName ?? args.chatId,
      body: args.body,
      source: "ai_reply",
      status: "pending",
    })
    .select("id")
    .maybeSingle();
  if (error || !row?.id) {
    console.error("[deliver] approval queue insert failed:", error?.message);
    return null;
  }
  logDecision(supabase, {
    conversation_id: args.conversationId,
    chat_id: args.chatId,
    trigger: "inbound",
    stage: "queued_approval",
    summary:
      "Send-layer guard: private-chat approval mode is on — the message was queued for approval instead of sent",
    data: { draft: args.body, approval_id: String(row.id), guard: "send_layer" },
  });
  if (args.whapi) {
    try {
      const { notifyWaAdmins } = await import("./admin-notify.server");
      await notifyWaAdmins(
        supabase,
        [
          `🕓 הודעה פרטית ממתינה לאישור`,
          `אל: ${args.targetName ?? args.chatId}`,
          `טיוטה: ${args.body.slice(0, 250)}`,
          `אפשר לאשר או לדחות כאן — למשל "אשר ${String(row.id).slice(0, 8)}".`,
        ].join("\n"),
        { whapi: args.whapi },
      );
    } catch (e) {
      console.warn("[deliver] admin approval notify failed:", e);
    }
  }
  return String(row.id);
}

export async function deliverReply(
  supabase: Supa,
  whapi: WhapiPort,
  ctx: AgentContext,
  parts: string[],
  opts: { humanPacing: boolean; botName: string },
): Promise<DeliveryResult> {
  // SERVER-SIDE APPROVAL GUARD, at the send layer itself: with the global
  // (private-chats) approval toggle on, NO bot-initiated 1-on-1 message
  // leaves without a human decision — including the canned lines that used
  // to bypass the gate by design (escalation holding line, never-silent
  // fallbacks, research interims; live 2026-07-28: "קיבלתי — אני בודק את
  // זה" went straight out). Groups never hit this guard — they are governed
  // exclusively by their own per-group toggle, upstream.
  if (!ctx.message.isGroup && isDmChatId(ctx.message.chatId) && ctx.settings.require_approval_all) {
    const approvalId = await queueDmForApproval(supabase, {
      conversationId: ctx.conversation.id || null,
      chatId: ctx.message.chatId,
      targetName: ctx.conversation.name ?? ctx.message.senderName ?? null,
      body: parts.join("\n\n"),
      whapi,
    });
    return { sentMessageIds: [], parts, queuedApprovalId: approvalId };
  }
  let pacingBudgetMs = MAX_TOTAL_PACING_MS;
  // DMs: plan ALL pacing up front against the MAX_DM_PACING_MS cap, scaling
  // every delay down proportionally when the natural formula exceeds it — the
  // reply keeps its rhythm without the last parts eating the SLA. Groups keep
  // the larger sequential budget (no reply-time SLA there).
  const dmPlan =
    opts.humanPacing && !ctx.message.isGroup ? planPacing(parts, MAX_DM_PACING_MS) : null;

  // Read receipt on the message we're answering — best-effort.
  if (ctx.message.messageId) {
    await whapi.markRead(ctx.message.messageId).catch(() => {});
  }

  const sentMessageIds: Array<string | null> = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (opts.humanPacing) {
      const typingMs = dmPlan
        ? dmPlan.typingMs[i]
        : Math.min(typingSecondsFor(part) * 1000, pacingBudgetMs);
      if (typingMs > 500) {
        await whapi
          .presence(ctx.message.chatId, "typing", Math.ceil(typingMs / 1000))
          .catch(() => {});
        await sleep(typingMs);
        pacingBudgetMs -= typingMs;
      }
    }

    const sendRes = await whapi.sendText(ctx.message.chatId, part);
    const whapiId = (sendRes as { message?: { id?: string } })?.message?.id ?? null;
    sentMessageIds.push(whapiId);

    await supabase.from("messages").insert({
      conversation_id: ctx.conversation.id,
      whapi_message_id: whapiId,
      direction: "outbound",
      sender_name: opts.botName || "Bot",
      sender_id: "bot",
      body: part,
      raw: sendRes as Json,
    });

    if (opts.humanPacing && i < parts.length - 1) {
      const pauseMs = dmPlan
        ? dmPlan.pauseMs[i]
        : Math.min(interPartDelayMs(), Math.max(pacingBudgetMs, 0));
      if (pauseMs > 0) {
        await sleep(pauseMs);
        pacingBudgetMs -= pauseMs;
      }
    }
  }

  // One logical reply = one anti-ban outbound unit, whatever the part count.
  const { recordOutbound } = await import("@/lib/anti-ban.server");
  await recordOutbound(supabase, ctx.conversation.id, parts.join("\n\n"));

  return { sentMessageIds, parts };
}
