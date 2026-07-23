// Pipeline orchestrator — runs one inbound_reply job through every stage and
// logs each decision. Called by the worker (never directly by routes).
import type { Supa } from "./types";
import { stripStructuredOutput, type InboundMessage } from "./inbound";
import { loadAgentSettings, gatherContext } from "./context.server";
import { gapDescription, isSignificantGap } from "./conversation-gap";
import { logDecision } from "./decisions.server";
import { deliverReply } from "./deliver.server";
import { analyzeIntent, critiqueAndRevise, draftReply, sanitizeParts } from "./stages.server";
import type { AgentDeps, BotJob, PipelineOutcome } from "./types";

/** Thrown when retrying can only make things worse (e.g. WhatsApp restriction). */
export class PermanentJobError extends Error {}

// Upper bound on the inline "land exactly on target" top-up wait. The bulk of
// the 15–120s DM delay is served durably by the job's run_after; this only
// fine-tunes the landing, so it stays small enough to be safe inside a
// Cloudflare Worker request (a long inline sleep gets the request killed).
const MAX_TARGET_TOPUP_MS = 20_000;

async function findApprovalOwner(supabase: Supa): Promise<string | null> {
  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  if (adminRole?.user_id) return adminRole.user_id;
  const {
    data: { users },
  } = await supabase.auth.admin.listUsers({ perPage: 1 });
  return users?.[0]?.id ?? null;
}

export async function processInboundJob(deps: AgentDeps, job: BotJob): Promise<PipelineOutcome> {
  const { supabase } = deps;
  const p = job.payload;
  const processStartAt = Date.now();
  const base = {
    job_id: job.id,
    conversation_id: job.conversation_id,
    chat_id: job.chat_id,
    trigger: deps.trigger,
  };

  const settings = await loadAgentSettings(supabase);
  if (!settings || !settings.enabled) {
    logDecision(supabase, {
      ...base,
      stage: "skipped",
      status: "skip",
      summary: "Bot is disabled",
    });
    return { action: "skipped", reason: "bot disabled" };
  }
  if (!job.conversation_id) return { action: "skipped", reason: "no conversation" };

  const message: InboundMessage = {
    chatId: job.chat_id,
    chatName: p.chat_name,
    senderId: p.sender_id,
    senderName: p.sender_name,
    body: p.body,
    isGroup: p.is_group,
    fromMe: false,
    messageId: p.whapi_message_id,
    ts: p.ts,
    mentions: [],
    quotedId: null,
    quotedAuthor: null,
  };

  // --- Stage: context (history + persistent person memory) ---
  let t = Date.now();
  const ctx = await gatherContext(supabase, settings, job.conversation_id, message);
  if (!ctx) return { action: "skipped", reason: "conversation not found" };
  const { loadOrCreatePerson } = await import("./people.server");
  ctx.person = await loadOrCreatePerson(supabase, message.senderId, message.senderName);
  if (message.isGroup) {
    const { loadGroupProfile } = await import("./groups.server");
    ctx.groupProfile = await loadGroupProfile(supabase, job.chat_id);
  }
  logDecision(supabase, {
    ...base,
    stage: "context",
    summary: `Loaded ${ctx.history.length} history messages${ctx.person ? ` + profile with ${ctx.person.facts.length} stored facts` : ""}`,
    data: {
      history_count: ctx.history.length,
      is_group: message.isGroup,
      person_facts: ctx.person?.facts.length ?? 0,
      funnel_stage: ctx.person?.funnel_stage,
    },
    duration_ms: Date.now() - t,
  });

  // A newer inbound already arrived → that message's job owns the reply.
  const { data: newer } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", job.conversation_id)
    .eq("direction", "inbound")
    .gt("created_at", new Date(p.ts).toISOString())
    .limit(1);
  if (newer?.length) {
    logDecision(supabase, {
      ...base,
      stage: "skipped",
      status: "skip",
      summary: "A newer message arrived — the reply will be written in its context",
    });
    return { action: "skipped", reason: "superseded" };
  }

  // --- Stage: intent ---
  t = Date.now();
  const intent = await analyzeIntent(ctx);

  // Fresh topic after a gap: retire the old thread before drafting so the
  // reply doesn't drag the earlier conversation in. Person memory and the
  // knowledge base still apply — only the transcript is cleared.
  if (intent.context_relation === "fresh" && !message.isGroup) {
    ctx.freshStart = {
      gap: gapDescription(ctx.gapSinceLastMs ?? 0),
      reason: intent.context_reason ?? "new topic",
    };
    ctx.history = [];
  }

  logDecision(supabase, {
    ...base,
    stage: "intent",
    summary: `Intent: ${intent.intent} | Language: ${intent.language} | Urgency: ${intent.urgency}${intent.escalate ? " | needs escalation" : ""}${
      ctx.freshStart
        ? ` | New topic after ${Math.round((ctx.gapSinceLastMs ?? 0) / 60_000)}min gap — old thread retired (${ctx.freshStart.reason})`
        : intent.context_relation === "continuation" && isSignificantGap(ctx.gapSinceLastMs)
          ? ` | Continues the earlier thread despite a ${Math.round((ctx.gapSinceLastMs ?? 0) / 60_000)}min gap`
          : ""
    }`,
    data: {
      ...(intent as unknown as Record<string, unknown>),
      gap_since_last_min:
        ctx.gapSinceLastMs != null ? Math.round(ctx.gapSinceLastMs / 60_000) : null,
    },
    duration_ms: Date.now() - t,
  });

  // --- Knowledge retrieval (query enriched by the intent analysis) ---
  const { loadKnowledge } = await import("./kb.server");
  ctx.kb = await loadKnowledge(supabase, `${message.body} ${intent.intent}`);

  // --- Stage: draft ---
  t = Date.now();
  const draft = await draftReply(ctx, intent);
  logDecision(supabase, {
    ...base,
    stage: "draft",
    summary: draft.reasoning || `Drafted ${draft.messages.length} message(s)`,
    data: { messages: draft.messages },
    duration_ms: Date.now() - t,
  });

  // --- Stage: critique ---
  t = Date.now();
  const critique = await critiqueAndRevise(ctx, intent, draft);
  const { parts: personaSafe, leaked } = sanitizeParts(critique.messages);
  // Final hard gate before anything can be sent: strip any part that still
  // looks like the model's raw JSON envelope. Defense in depth — draftReply
  // already refuses to return raw JSON, but a garbled/truncated draft must
  // never reach a user as a `{"messages":...,"reasoning":...}` blob.
  const { parts, leaked: jsonLeaked } = stripStructuredOutput(personaSafe);
  logDecision(supabase, {
    ...base,
    stage: "critique",
    summary:
      critique.verdict === "revise"
        ? `Revised: ${critique.issues.join("; ") || critique.reasoning}`
        : "Draft passed the quality review",
    data: {
      verdict: critique.verdict,
      issues: critique.issues,
      messages: parts,
      persona_leak_stripped: leaked,
      json_envelope_stripped: jsonLeaked,
    },
    duration_ms: Date.now() - t,
  });

  // Nothing safe left to send (e.g. the whole reply was a raw JSON blob that we
  // just stripped) → send NOTHING rather than deliver garbage. The queue has
  // already logged the leak; a silent skip is the correct fallback here.
  if (!parts.length) {
    logDecision(supabase, {
      ...base,
      stage: "error",
      status: "error",
      summary: jsonLeaked
        ? "Reply was raw JSON only — stripped the envelope and sent nothing"
        : "Reply was empty after safety filtering — sent nothing",
    });
    return { action: "skipped", reason: "empty after safety filter" };
  }

  const joined = parts.join("\n\n");

  // --- Approval gate (global toggle, or the agent itself asked to escalate) ---
  if (settings.require_approval_all || intent.escalate) {
    const ownerUserId = await findApprovalOwner(supabase);
    if (!ownerUserId) {
      logDecision(supabase, {
        ...base,
        stage: "error",
        status: "error",
        summary: "No user found to own the approval row",
      });
      return { action: "failed", error: "no approval owner" };
    }
    await supabase.from("scheduled_approvals").insert({
      user_id: ownerUserId,
      conversation_id: job.conversation_id,
      target_chat_id: job.chat_id,
      target_name: p.chat_name || p.sender_name || job.chat_id,
      body: joined,
      source: "ai_reply",
      status: "pending",
    });
    logDecision(supabase, {
      ...base,
      stage: "queued_approval",
      summary: intent.escalate
        ? `Escalated to human approval — ${intent.escalate_reason ?? "escalation"}`
        : "Approval-all mode is on — awaiting human approval",
      data: { draft: joined, escalated: intent.escalate },
    });
    if (intent.escalate && ctx.groupProfile?.owner_dm) {
      const { notifyOwner } = await import("./moderation.server");
      await notifyOwner(
        deps,
        ctx.groupProfile,
        `🔔 הסלמה בקבוצה "${ctx.groupProfile.name ?? job.chat_id}": ${intent.escalate_reason ?? intent.intent}\nמאת: ${p.sender_name || p.sender_id}\nהודעה: ${p.body.slice(0, 200)}\nטיוטת תשובה ממתינה באישורים.`,
      );
    }
    return { action: "queued_approval", draft: joined };
  }

  // --- Human-timing top-up: land the reply at the random target chosen at
  // receipt (15-120s after the DM). The bulk of that delay was already served
  // durably by the job's run_after — the sweeper only claims the job near its
  // target — so this is a SHORT, bounded wait to fine-tune the landing (and to
  // enforce the 15s floor if the job ran a touch early), never the long inline
  // sleep that used to exceed the Cloudflare Worker request limit and strand
  // the job for minutes. On sweeper retries the target is in the past → no-op.
  const llmDoneAt = Date.now();
  let waitedForTargetMs = 0;
  if (deps.humanPacing && p.target_reply_at) {
    waitedForTargetMs = Math.min(Math.max(p.target_reply_at - Date.now(), 0), MAX_TARGET_TOPUP_MS);
    if (waitedForTargetMs > 0) {
      await new Promise((r) => setTimeout(r, waitedForTargetMs));
      // The conversation may have moved on while we waited.
      const { data: newerNow } = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", job.conversation_id)
        .eq("direction", "inbound")
        .gt("created_at", new Date(p.ts).toISOString())
        .limit(1);
      if (newerNow?.length) {
        logDecision(supabase, {
          ...base,
          stage: "skipped",
          status: "skip",
          summary: "A newer message arrived during the reply-timing wait — its job owns the reply",
        });
        return { action: "skipped", reason: "superseded during delay" };
      }
    }
  }

  // --- Anti-ban + duplicate-reply guards, immediately before sending ---
  const {
    checkOutboundAllowed,
    isWhapiRestrictionError,
    raiseAdminAlert,
    loadConversationByChatId,
  } = await import("@/lib/anti-ban.server");
  const conv = await loadConversationByChatId(supabase, job.chat_id);
  if (conv) {
    const guard = await checkOutboundAllowed(supabase, conv, joined);
    if (!guard.ok) {
      logDecision(supabase, {
        ...base,
        stage: "skipped",
        status: "skip",
        summary: `Blocked by the anti-ban guard: ${guard.reason}`,
        data: { code: guard.code },
      });
      return { action: "skipped", reason: guard.code };
    }
  }
  const { data: alreadyReplied } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", job.conversation_id)
    .eq("direction", "outbound")
    .gt("created_at", new Date(p.ts).toISOString())
    .limit(1);
  if (alreadyReplied?.length) {
    logDecision(supabase, {
      ...base,
      stage: "skipped",
      status: "skip",
      summary: "Already replied to this message",
    });
    return { action: "skipped", reason: "already replied" };
  }

  // --- Stage: deliver ---
  t = Date.now();
  try {
    const delivery = await deliverReply(supabase, deps.whapi, ctx, parts, {
      humanPacing: deps.humanPacing,
      botName: settings.bot_name,
    });
    logDecision(supabase, {
      ...base,
      stage: "deliver",
      summary: `Sent ${delivery.parts.length} message(s)`,
      data: {
        parts: delivery.parts,
        whapi_ids: delivery.sentMessageIds,
        // Where the time went, message → reply. queue_wait covers debounce
        // plus any sweeper/lock-recovery delay — the number that exposes a
        // stuck job; llm covers the reasoning stages; waited_for_target is
        // the intentional human-timing sleep.
        latency_breakdown: {
          total_from_message_s: Math.round((Date.now() - p.ts) / 1000),
          webhook_delivery_s: p.received_at ? Math.round((p.received_at - p.ts) / 1000) : null,
          queue_wait_s: p.received_at ? Math.round((processStartAt - p.received_at) / 1000) : null,
          llm_s: Math.round((llmDoneAt - processStartAt) / 1000),
          waited_for_target_s: Math.round(waitedForTargetMs / 1000),
          attempt: job.attempts,
        },
      },
      duration_ms: Date.now() - t,
    });

    // --- Stage: memory (after the send — failures here never cost a reply) ---
    if (ctx.person) {
      t = Date.now();
      const { extractAndStoreMemory, scheduleFollowUp } = await import("./memory.server");
      const extraction = await extractAndStoreMemory(supabase, ctx, ctx.person, delivery.parts);
      if (extraction) {
        logDecision(supabase, {
          ...base,
          stage: "memory",
          summary: extraction.facts.length
            ? `Stored ${extraction.facts.length} new fact(s) about ${ctx.person.display_name ?? message.senderName ?? "the contact"}`
            : "No new facts worth storing",
          data: extraction as unknown as Record<string, unknown>,
          duration_ms: Date.now() - t,
        });
        if (
          extraction.follow_up &&
          (settings.agent_config?.follow_ups_enabled ?? true) &&
          !message.isGroup
        ) {
          await scheduleFollowUp(supabase, {
            conversationId: job.conversation_id,
            chatId: job.chat_id,
            personWaId: ctx.person.wa_id,
            hours: extraction.follow_up.hours,
            reason: extraction.follow_up.reason,
          });
          logDecision(supabase, {
            ...base,
            stage: "follow_up",
            summary: `Follow-up scheduled in ${extraction.follow_up.hours}h — ${extraction.follow_up.reason}`,
            data: { ...extraction.follow_up },
          });
        }
      }
    }
    return { action: "replied", parts: delivery.parts };
  } catch (e: unknown) {
    const err = e as Error;
    if (isWhapiRestrictionError(err)) {
      if (settings.id) {
        await supabase.from("bot_settings").update({ enabled: false }).eq("id", settings.id);
      }
      await raiseAdminAlert(
        supabase,
        `WhatsApp restricted the account — bot disabled. Error: ${String(err?.message ?? err)}`,
      );
      logDecision(supabase, {
        ...base,
        stage: "error",
        status: "error",
        summary: "WhatsApp restricted the account — bot disabled and the admin was alerted",
      });
      throw new PermanentJobError(String(err?.message ?? err));
    }
    logDecision(supabase, {
      ...base,
      stage: "error",
      status: "error",
      summary: `Send failed: ${String(err?.message ?? err).slice(0, 200)}`,
    });
    throw err;
  }
}
