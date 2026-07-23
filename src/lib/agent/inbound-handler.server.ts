// Per-message inbound handling, shared verbatim by the production webhook and
// simulation mode: persist idempotently → gates → enqueue → (optionally) wait
// out the debounce and process the queue for this chat.
import { logDecision } from "./decisions.server";
import { randomReplyDelayMs, type InboundMessage } from "./inbound";
import { enqueueInboundReply } from "./queue.server";
import { processQueuedJobs, type WorkerRunResult } from "./worker.server";
import type { Json } from "@/integrations/supabase/types";
import type { AgentDeps, AgentSettings } from "./types";

const FRESHNESS_WINDOW_MS = 2 * 60 * 1000;
// DMs are still worth answering when the webhook itself arrived late (Whapi
// delivery lag) — only genuinely old messages (historical replay after a
// reconnect) must never trigger a reply. Groups keep the strict window.
const DM_REPLY_HORIZON_MS = 15 * 60 * 1000;
const DEFAULT_REPLY_DELAY_S = 4;
const MAX_INLINE_WAIT_MS = 8_000;
// The debounce only consolidates message bursts. It must stay below the
// inline wait, or the job's run_after lands beyond this request's claim
// window and the reply silently degrades to the every-minute sweeper —
// that's the difference between a ~30s reply and a 2-4 minute one. The
// human-feel timing lives in target_reply_at, not here.
const MAX_REPLY_DELAY_S = Math.floor(MAX_INLINE_WAIT_MS / 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type InboundOutcome = {
  action:
    | "duplicate"
    | "stored_own"
    | "stored_stale"
    | "stored_empty"
    | "blocked"
    | "bot_disabled"
    | "group_not_addressed"
    | "moderated"
    | "trivial_ack"
    | "enqueued";
  conversationId?: string;
  jobId?: string | null;
  worker?: WorkerRunResult;
};

export async function handleInboundMessage(
  deps: AgentDeps,
  settings: AgentSettings,
  m: InboundMessage,
  raw: unknown,
): Promise<InboundOutcome> {
  const { supabase } = deps;

  if (!m.body || !m.body.trim()) return { action: "stored_empty" };

  // --- Upsert conversation ---
  const { data: convExisting } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", m.chatId)
    .maybeSingle();

  let convId = convExisting?.id as string | undefined;
  if (!convId) {
    const { data: ins } = await supabase
      .from("conversations")
      .insert({
        whapi_chat_id: m.chatId,
        name: m.chatName || m.senderName || m.chatId,
        is_group: m.isGroup,
        last_message_at: new Date(m.ts).toISOString(),
      })
      .select("id")
      .single();
    convId = ins?.id;
  } else {
    await supabase
      .from("conversations")
      .update({
        last_message_at: new Date(m.ts).toISOString(),
        ...(m.chatName ? { name: m.chatName } : {}),
      })
      .eq("id", convId);
  }
  if (!convId) return { action: "stored_empty" };

  // --- Persist inbound, idempotently (unique index on inbound whapi ids) ---
  const { error: insErr } = await supabase.from("messages").insert({
    conversation_id: convId,
    whapi_message_id: m.messageId || null,
    direction: "inbound",
    sender_name: m.senderName || null,
    sender_id: m.senderId,
    body: m.body,
    raw: raw as Json,
    created_at: new Date(m.ts).toISOString(),
  });
  if (insErr) {
    if (insErr.code === "23505") return { action: "duplicate", conversationId: convId };
    console.error("[inbound] message insert failed", insErr);
  }

  // Own-phone messages are stored and counted, never replied to.
  if (m.fromMe) return { action: "stored_own", conversationId: convId };
  // Historical replay is stored, but must never trigger stale replies.
  // Dropping a message MUST leave a decision row — a silent drop looks like
  // the bot ignoring someone.
  const webhookLagMs = Math.abs(Date.now() - m.ts);
  const horizonMs = m.isGroup ? FRESHNESS_WINDOW_MS : DM_REPLY_HORIZON_MS;
  if (webhookLagMs > horizonMs) {
    logDecision(supabase, {
      conversation_id: convId,
      chat_id: m.chatId,
      trigger: deps.trigger,
      stage: "skipped",
      status: "skip",
      summary: `Message stored without a reply — it reached the webhook ${Math.round(webhookLagMs / 60_000)}min after being sent (over the ${Math.round(horizonMs / 60_000)}min reply horizon)`,
      data: { webhook_lag_s: Math.round(webhookLagMs / 1000) },
    });
    return { action: "stored_stale", conversationId: convId };
  }

  const { recordInbound, isStopRequest } = await import("@/lib/anti-ban.server");
  const { blockedNow } = await recordInbound(supabase, convId, m.body);
  if (!settings.enabled) return { action: "bot_disabled", conversationId: convId };
  if (blockedNow || isStopRequest(m.body)) {
    logDecision(supabase, {
      conversation_id: convId,
      chat_id: m.chatId,
      trigger: deps.trigger,
      stage: "skipped",
      status: "skip",
      summary: "Stop request — contact blocked from any further messages",
    });
    return { action: "blocked", conversationId: convId };
  }

  // Groups: profile-driven management. Moderation first (it owns violations),
  // then the MANDATORY reply-decision gate — the bot never chimes in on
  // member-to-member chatter, and every respond/skip is logged with reasoning.
  if (m.isGroup) {
    const { loadGroupProfile } = await import("./groups.server");
    const profile = await loadGroupProfile(supabase, m.chatId);

    if (profile?.enabled) {
      const { moderateGroupMessage } = await import("./moderation.server");
      const handled = await moderateGroupMessage(deps, settings, profile, m, convId);
      if (handled) return { action: "moderated", conversationId: convId };
    }

    const { decideGroupReply } = await import("./reply-gate.server");
    const gate = await decideGroupReply(deps, settings, profile, m, convId);
    if (!gate.respond) return { action: "group_not_addressed", conversationId: convId };
  }

  // Trivial messages ("תודה", "👍"): acknowledge with a reaction, skip the
  // pipeline. In approval mode every message still produces a draft.
  const { isTrivialMessage } = await import("@/lib/ai-brain.server");
  if (!settings.require_approval_all && isTrivialMessage(m.body)) {
    if ((settings.agent_config?.react_to_trivial ?? true) && m.messageId) {
      await deps.whapi.react(m.messageId, "👍").catch(() => {});
    }
    logDecision(supabase, {
      conversation_id: convId,
      chat_id: m.chatId,
      trigger: deps.trigger,
      stage: "skipped",
      status: "skip",
      summary: "Trivial message — acknowledged with a reaction instead of a reply",
    });
    return { action: "trivial_ack", conversationId: convId };
  }

  // --- Enqueue (supersedes older pending jobs for this chat) ---
  const delaySeconds =
    deps.trigger === "simulation"
      ? 0
      : Math.min(
          settings.agent_config?.reply_delay_seconds ?? DEFAULT_REPLY_DELAY_S,
          MAX_REPLY_DELAY_S,
        );
  // DM replies land at a random human moment 15-90s after the MESSAGE was
  // sent (that's the window the user experiences). If webhook delivery lag
  // already ate the window, land as soon as possible instead — a small floor
  // keeps it from feeling instant.
  const targetReplyAt =
    !m.isGroup && deps.trigger !== "simulation"
      ? Math.max(m.ts + randomReplyDelayMs(), Date.now() + 5_000)
      : undefined;
  const jobId = await enqueueInboundReply(supabase, {
    chatId: m.chatId,
    conversationId: convId,
    payload: {
      whapi_message_id: m.messageId,
      body: m.body,
      sender_id: m.senderId,
      sender_name: m.senderName,
      chat_name: m.chatName,
      is_group: m.isGroup,
      ts: m.ts,
      received_at: Date.now(),
      target_reply_at: targetReplyAt,
    },
    delaySeconds,
  });
  logDecision(supabase, {
    job_id: jobId,
    conversation_id: convId,
    chat_id: m.chatId,
    trigger: deps.trigger,
    stage: "received",
    summary: `Message from ${m.senderName || m.chatId} accepted for handling`,
    data: {
      body_preview: m.body.slice(0, 120),
      reply_delay_s: delaySeconds,
      webhook_lag_s: Math.round(webhookLagMs / 1000),
      ...(targetReplyAt
        ? { reply_target_in_s: Math.round((targetReplyAt - Date.now()) / 1000) }
        : {}),
    },
  });

  // Wait out the debounce, then drain this chat's queue. If a newer message
  // lands meanwhile it supersedes this job and its own request handles it;
  // if this request dies, the every-minute sweeper picks the job up.
  if (deps.humanPacing && delaySeconds > 0) {
    await sleep(Math.min(delaySeconds * 1000 + 250, MAX_INLINE_WAIT_MS));
  }
  // max > 1: after a crashed-run lock recovery an older freed job for this
  // chat is claimed first — with max 1 it would starve this message's job
  // until the sweeper's next tick.
  const worker = await processQueuedJobs(deps, { chatId: m.chatId, max: 3 });
  return { action: "enqueued", conversationId: convId, jobId, worker };
}
