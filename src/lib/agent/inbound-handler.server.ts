// Per-message inbound handling, shared verbatim by the production webhook and
// simulation mode.
//
// Persistence is gated on PARTICIPATION: a chat is saved (conversation row +
// its messages) only once the account participates in it — our own outgoing
// message, an already-existing conversation, or a reply/moderation action the
// bot is about to perform. Chats we merely observe (unaddressed group chatter,
// historical replay, stop/blocked contacts, trivial acks in brand-new chats)
// are never persisted.
//
// Timing: DM replies are DURABLE-delayed via the job's run_after (15–120s),
// delivered by the queue sweeper. The webhook never sleeps out the human delay
// inline — a Cloudflare Worker request can't be held open that long, and doing
// so used to strand the claimed job under its lock and push replies to minutes.
import { logDecision } from "./decisions.server";
import { randomReplyDelayMs, REPLY_TARGET_MIN_MS, type InboundMessage } from "./inbound";
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
// Debounce cap for the inline path (groups/simulation only). Kept below the
// inline wait so a runnable group job is claimed by this request rather than
// degrading to the sweeper.
const MAX_REPLY_DELAY_S = Math.floor(MAX_INLINE_WAIT_MS / 1000);
// How long before target_reply_at a DM job becomes runnable, so the LLM stages
// finish right around the target instead of pushing past it. Small enough that
// the pipeline's remaining top-up wait stays Cloudflare-safe.
const PROCESSING_LEAD_MS = 15_000;

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

  // --- Participation gate ---
  // Look the conversation up but DO NOT create it. A chat is persisted only once
  // the account participates (below); everything until then operates on the
  // existing conversation if there is one, or on nothing if we're just watching.
  const { data: convExisting } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", m.chatId)
    .maybeSingle();
  let convId = convExisting?.id as string | undefined;
  let messageStored = false;

  // Create the conversation on first participation (and keep an existing one
  // fresh). Returns the conversation id, or undefined if the insert failed.
  const ensureConversation = async (): Promise<string | undefined> => {
    if (convId) {
      await supabase
        .from("conversations")
        .update({
          last_message_at: new Date(m.ts).toISOString(),
          ...(m.chatName ? { name: m.chatName } : {}),
        })
        .eq("id", convId);
      return convId;
    }
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
    return convId;
  };

  // Persist the chat: ensure the conversation exists, then store this inbound
  // message idempotently (unique index on inbound whapi ids). Safe to call more
  // than once — the message is written at most once.
  const persistChat = async (): Promise<{ id?: string; duplicate: boolean }> => {
    const id = await ensureConversation();
    if (!id || messageStored) return { id, duplicate: false };
    messageStored = true;
    const { error: insErr } = await supabase.from("messages").insert({
      conversation_id: id,
      whapi_message_id: m.messageId || null,
      direction: "inbound",
      sender_name: m.senderName || null,
      sender_id: m.senderId,
      body: m.body,
      raw: raw as Json,
      created_at: new Date(m.ts).toISOString(),
    });
    if (insErr) {
      if (insErr.code === "23505") return { id, duplicate: true };
      console.error("[inbound] message insert failed", insErr);
    }
    return { id, duplicate: false };
  };

  // Already participating — an existing conversation, or our own outgoing
  // message from the linked phone. Persist immediately so history and behavior
  // for known chats are exactly as before.
  const alreadyParticipated = !!convId || m.fromMe;
  if (alreadyParticipated) {
    const { duplicate } = await persistChat();
    if (duplicate) return { action: "duplicate", conversationId: convId };
  }

  // Own-phone messages are stored and counted, never replied to.
  if (m.fromMe) return { action: "stored_own", conversationId: convId };

  // Historical replay must never trigger stale replies. For a chat we've
  // participated in the drop is logged (a silent drop looks like the bot
  // ignoring someone); a brand-new chat we only observed via a stale message is
  // simply not saved.
  const webhookLagMs = Math.abs(Date.now() - m.ts);
  const horizonMs = m.isGroup ? FRESHNESS_WINDOW_MS : DM_REPLY_HORIZON_MS;
  if (webhookLagMs > horizonMs) {
    if (convId) {
      logDecision(supabase, {
        conversation_id: convId,
        chat_id: m.chatId,
        trigger: deps.trigger,
        stage: "skipped",
        status: "skip",
        summary: `Message stored without a reply — it reached the webhook ${Math.round(webhookLagMs / 60_000)}min after being sent (over the ${Math.round(horizonMs / 60_000)}min reply horizon)`,
        data: { webhook_lag_s: Math.round(webhookLagMs / 1000) },
      });
    }
    return { action: "stored_stale", conversationId: convId };
  }

  const { recordInbound, isStopRequest } = await import("@/lib/anti-ban.server");
  if (!settings.enabled) return { action: "bot_disabled", conversationId: convId };
  // Stop request — detected purely from the text so a brand-new chat needn't be
  // created just to refuse it. For a chat we've already participated in, record
  // the block durably (also bumps the inbound counter) so we never message again.
  if (isStopRequest(m.body)) {
    if (convId) {
      await recordInbound(supabase, convId, m.body);
      logDecision(supabase, {
        conversation_id: convId,
        chat_id: m.chatId,
        trigger: deps.trigger,
        stage: "skipped",
        status: "skip",
        summary: "Stop request — contact blocked from any further messages",
      });
    }
    return { action: "blocked", conversationId: convId };
  }

  // Groups: profile-driven management. Moderation first (it owns violations),
  // then the MANDATORY reply-decision gate — the bot never chimes in on
  // member-to-member chatter. Both tolerate a not-yet-created conversation
  // (convId may be undefined for a group we're only observing).
  if (m.isGroup) {
    const { loadGroupProfile } = await import("./groups.server");
    const profile = await loadGroupProfile(supabase, m.chatId);

    if (profile?.enabled) {
      const { moderateGroupMessage } = await import("./moderation.server");
      const mod = await moderateGroupMessage(deps, settings, profile, m, convId ?? null);
      if (mod.handled) {
        // Persist only if the bot actually posted into the group (a public
        // warning) — that's participation. A silent first-strike is tracked in
        // moderation_actions but doesn't turn the group into a saved chat.
        if (mod.acted) await persistChat();
        return { action: "moderated", conversationId: convId };
      }
    }

    const { decideGroupReply } = await import("./reply-gate.server");
    const gate = await decideGroupReply(deps, settings, profile, m, convId ?? null);
    if (!gate.respond) return { action: "group_not_addressed", conversationId: convId };
  }

  // Trivial messages ("תודה", "👍"): acknowledge with a reaction, skip the
  // pipeline. A reaction is not a sent message, so a brand-new chat is not
  // persisted here. In approval mode every message still produces a draft.
  const { isTrivialMessage } = await import("@/lib/ai-brain.server");
  if (!settings.require_approval_all && isTrivialMessage(m.body)) {
    if ((settings.agent_config?.react_to_trivial ?? true) && m.messageId) {
      await deps.whapi.react(m.messageId, "👍").catch(() => {});
    }
    if (convId) {
      logDecision(supabase, {
        conversation_id: convId,
        chat_id: m.chatId,
        trigger: deps.trigger,
        stage: "skipped",
        status: "skip",
        summary: "Trivial message — acknowledged with a reaction instead of a reply",
      });
    }
    return { action: "trivial_ack", conversationId: convId };
  }

  // The bot is going to reply → it participates → persist the chat now (creates
  // the conversation + stores the inbound message if this is a brand-new chat).
  const persisted = await persistChat();
  if (persisted.duplicate) return { action: "duplicate", conversationId: persisted.id };
  convId = persisted.id;
  if (!convId) return { action: "stored_empty" };

  // Bump the inbound counters on the (now-existing) conversation so the
  // pipeline's anti-ban guard sees a real inbound and doesn't refuse the reply
  // as a cold contact. Runs once, here, on the participation path.
  await recordInbound(supabase, convId, m.body);

  // --- Enqueue (supersedes older pending jobs for this chat) ---
  // DMs: the human-timing delay is DURABLE. target_reply_at is a random moment
  // 15-120s after the MESSAGE; the job's run_after is set a short lead before
  // that so the LLM stages finish around the target. The webhook returns without
  // holding the request open — the sweeper delivers it. Groups/simulation keep a
  // small inline debounce and are processed inline for immediacy.
  const isDurableDelay = !m.isGroup && deps.trigger !== "simulation";
  const targetReplyAt = isDurableDelay
    ? Math.max(m.ts + randomReplyDelayMs(), Date.now() + REPLY_TARGET_MIN_MS)
    : undefined;
  const debounceSeconds =
    deps.trigger === "simulation"
      ? 0
      : Math.min(
          settings.agent_config?.reply_delay_seconds ?? DEFAULT_REPLY_DELAY_S,
          MAX_REPLY_DELAY_S,
        );
  const runAfterMs =
    targetReplyAt !== undefined
      ? Math.max(targetReplyAt - PROCESSING_LEAD_MS, Date.now() + 1_000)
      : Date.now() + debounceSeconds * 1000;

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
    runAfterMs,
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
      webhook_lag_s: Math.round(webhookLagMs / 1000),
      run_after_in_s: Math.round((runAfterMs - Date.now()) / 1000),
      ...(targetReplyAt
        ? { reply_target_in_s: Math.round((targetReplyAt - Date.now()) / 1000) }
        : {}),
    },
  });

  // DM replies are delivered by the queue sweeper at run_after — return
  // promptly, never blocking the Worker on the human delay.
  if (isDurableDelay) {
    return { action: "enqueued", conversationId: convId, jobId };
  }

  // Groups/simulation: wait out the short debounce, then drain this chat's
  // queue inline. If a newer message lands meanwhile it supersedes this job;
  // if this request dies, the every-minute sweeper picks the job up.
  if (deps.humanPacing && debounceSeconds > 0) {
    await sleep(Math.min(debounceSeconds * 1000 + 250, MAX_INLINE_WAIT_MS));
  }
  // max > 1: after a crashed-run lock recovery an older freed job for this
  // chat is claimed first — with max 1 it would starve this message's job
  // until the sweeper's next tick.
  const worker = await processQueuedJobs(deps, { chatId: m.chatId, max: 3 });
  return { action: "enqueued", conversationId: convId, jobId, worker };
}
