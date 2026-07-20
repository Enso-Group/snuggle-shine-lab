// Per-message inbound handling, shared verbatim by the production webhook and
// simulation mode: persist idempotently → gates → enqueue → (optionally) wait
// out the debounce and process the queue for this chat.
import { logDecision } from "./decisions.server";
import type { InboundMessage } from "./inbound";
import { enqueueInboundReply } from "./queue.server";
import { processQueuedJobs, type WorkerRunResult } from "./worker.server";
import type { Json } from "@/integrations/supabase/types";
import type { AgentDeps, AgentSettings } from "./types";

const FRESHNESS_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_REPLY_DELAY_S = 4;
const MAX_INLINE_WAIT_MS = 8_000;

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
  if (Math.abs(Date.now() - m.ts) > FRESHNESS_WINDOW_MS) {
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
      summary: "בקשת הפסקה — איש הקשר נחסם ולא יקבל עוד הודעות",
    });
    return { action: "blocked", conversationId: convId };
  }

  // Groups: reply only when addressed (Phase 3 will make this profile-driven).
  if (m.isGroup) {
    const botName = settings.bot_name ?? "";
    const lower = m.body.toLowerCase();
    const mentioned =
      (botName && lower.includes(botName.toLowerCase())) ||
      lower.includes("@" + botName.toLowerCase()) ||
      /@\d+/.test(m.body);
    if (!mentioned) return { action: "group_not_addressed", conversationId: convId };
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
      summary: "הודעה טריוויאלית — סומנה בריאקציה במקום תשובה",
    });
    return { action: "trivial_ack", conversationId: convId };
  }

  // --- Enqueue (supersedes older pending jobs for this chat) ---
  const delaySeconds =
    deps.trigger === "simulation"
      ? 0
      : (settings.agent_config?.reply_delay_seconds ?? DEFAULT_REPLY_DELAY_S);
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
    },
    delaySeconds,
  });
  logDecision(supabase, {
    job_id: jobId,
    conversation_id: convId,
    chat_id: m.chatId,
    trigger: deps.trigger,
    stage: "received",
    summary: `הודעה מ${m.senderName || m.chatId} התקבלה לטיפול`,
    data: { body_preview: m.body.slice(0, 120), reply_delay_s: delaySeconds },
  });

  // Wait out the debounce, then drain this chat's queue. If a newer message
  // lands meanwhile it supersedes this job and its own request handles it;
  // if this request dies, the every-minute sweeper picks the job up.
  if (deps.humanPacing && delaySeconds > 0) {
    await sleep(Math.min(delaySeconds * 1000 + 250, MAX_INLINE_WAIT_MS));
  }
  const worker = await processQueuedJobs(deps, { chatId: m.chatId, max: 1 });
  return { action: "enqueued", conversationId: convId, jobId, worker };
}
