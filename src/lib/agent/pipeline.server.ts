// Pipeline orchestrator — runs one inbound_reply job through every stage and
// logs each decision. Called by the worker (never directly by routes).
import type { Supa } from "./types";
import { stripStructuredOutput, type InboundMessage } from "./inbound";
import { loadAgentSettings, gatherContext } from "./context.server";
import { gapDescription, isSignificantGap } from "./conversation-gap";
import { logDecision } from "./decisions.server";
import { deliverReply } from "./deliver.server";
import {
  analyzeIntent,
  CANT_HELP_FALLBACK_LINE,
  consolidateReply,
  draftCantHelpLine,
  draftReply,
  sanitizeParts,
} from "./stages.server";
import { hasOwningReplyJob, supersedeJobsByIds } from "./queue.server";
import type { AgentDeps, BotJob, PipelineOutcome } from "./types";

/** Thrown when retrying can only make things worse (e.g. WhatsApp restriction). */
export class PermanentJobError extends Error {}

// Upper bound on the inline "land exactly on target" top-up wait. The DM reply
// target is only 3–10s after the message now, so this covers the whole
// remaining wait while staying small enough to be safe inside a Cloudflare
// Worker request (a long inline sleep gets the request killed).
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
  // DMs key the person by CHAT id: chat ids stay phone-shaped even when the
  // sender id arrives as a LinkedDevice '@lid' spelling, so keying on the
  // sender would mint a second profile for the same human (see people.server).
  ctx.person = await loadOrCreatePerson(
    supabase,
    message.senderId,
    message.senderName,
    message.isGroup ? undefined : { dmChatId: job.chat_id },
  );
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
  // Cheap pre-LLM escape hatch only — nothing has been spent yet at this
  // point. Newer messages that arrive AFTER the LLM stages started are folded
  // into the drafted reply by the pre-send consolidation below, never by
  // restarting the cycle.
  const { data: newer } = await supabase
    .from("messages")
    .select("created_at")
    .eq("conversation_id", job.conversation_id)
    .eq("direction", "inbound")
    .gt("created_at", new Date(p.ts).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (newer?.length) {
    // "Superseded" is only safe when SOME other live job will actually write
    // the reply. Trivial messages ("תודה", "👍") never enqueue a job — bowing
    // out on their account would leave the original message answered by
    // nobody. No owner → keep going: the trivial newcomer needs no reply of
    // its own, and the history this cycle drafts from already includes it.
    const owned = await hasOwningReplyJob(supabase, {
      chatId: job.chat_id,
      excludeJobId: job.id,
      newestInboundTs: new Date(String(newer[0].created_at)).getTime(),
    });
    if (owned) {
      logDecision(supabase, {
        ...base,
        stage: "skipped",
        status: "skip",
        summary: "A newer message arrived — the reply will be written in its context",
      });
      return { action: "skipped", reason: "superseded" };
    }
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

  // --- Stage: draft (the ONE strong call — quality rules live in its prompt;
  // the old separate critique call cost a second strong pass per cycle and is
  // gone from the DM path) ---
  t = Date.now();
  const draft = await draftReply(ctx, intent);
  // Deterministic safety nets, no LLM: persona-leak scrub, then a final hard
  // gate that strips any part still looking like the model's raw JSON
  // envelope. Defense in depth — draftReply already refuses to return raw
  // JSON, but a garbled/truncated draft must never reach a user as a
  // `{"messages":...,"reasoning":...}` blob.
  const { parts: personaSafe, leaked } = sanitizeParts(draft.messages);
  const { parts: safeParts, leaked: jsonLeaked } = stripStructuredOutput(personaSafe);
  // Mutable: the consolidation stage below may replace the parts when newer
  // messages arrived mid-draft.
  let parts = safeParts;
  // The final envelope's "I promised to check" flag — replaced along with the
  // parts when consolidation rewrites the reply.
  let openQuestion = draft.openQuestion;
  logDecision(supabase, {
    ...base,
    stage: "draft",
    summary: draft.reasoning || `Drafted ${draft.messages.length} message(s)`,
    data: {
      messages: parts,
      persona_leak_stripped: leaked,
      json_envelope_stripped: jsonLeaked,
    },
    duration_ms: Date.now() - t,
  });

  // Nothing safe left to send (e.g. the whole reply was a raw JSON blob that
  // we just stripped). Groups/simulation keep the old behavior — silence beats
  // garbage. A DM must NEVER end in silence (hard product rule): send a short
  // "can't help with that" line instead — one budget-clamped fast-model shot,
  // then a fixed persona-safe Hebrew line if even that fails.
  if (!parts.length) {
    const dmNeverSilent =
      !message.isGroup &&
      !job.chat_id.endsWith("@g.us") &&
      !job.chat_id.endsWith("@simulation") &&
      deps.trigger !== "simulation";
    logDecision(supabase, {
      ...base,
      stage: "error",
      status: "error",
      summary:
        (jsonLeaked
          ? "Reply was raw JSON only — stripped the envelope"
          : "Reply was empty after safety filtering") +
        (dmNeverSilent ? " — sending a fallback line instead" : " — sent nothing"),
    });
    if (dmNeverSilent) {
      // Guards OUTRANK never-silent — guard-blocked is an allowed-silent case.
      // The fallback is still an outbound send, so it obeys the same gates as
      // a normal reply: crash-retry dedup (attempts>1 + an outbound newer than
      // the message = a previous attempt died after its send) and the
      // anti-ban/blocked guard (a fallback to a blocked contact is exactly
      // the traffic the guard exists to stop).
      if (job.attempts > 1 && p.deliver_started) {
        // Correlated dedup: only THIS job's own previously-attempted text
        // counts as "already replied" — research interims/answers landing in
        // the same conversation must not suppress the fallback.
        const { data: fallbackAlreadyReplied } = await supabase
          .from("messages")
          .select("id")
          .eq("conversation_id", job.conversation_id)
          .eq("direction", "outbound")
          .eq("body", p.deliver_started.first_part)
          .gt("created_at", new Date(p.ts).toISOString())
          .limit(1);
        if (fallbackAlreadyReplied?.length) {
          logDecision(supabase, {
            ...base,
            stage: "skipped",
            status: "skip",
            summary: "Fallback skipped: already replied (a previous attempt sent before dying)",
          });
          return { action: "skipped", reason: "already replied" };
        }
      }
      const { checkOutboundAllowed, loadConversationByChatId } =
        await import("@/lib/anti-ban.server");
      const fallbackConv = await loadConversationByChatId(supabase, job.chat_id);
      if (fallbackConv) {
        // The final line isn't drafted yet — the canned line stands in for the
        // guard's duplicate check, which is the shape a repeated fallback
        // would take anyway.
        const fallbackGuard = await checkOutboundAllowed(
          supabase,
          fallbackConv,
          CANT_HELP_FALLBACK_LINE,
        );
        if (!fallbackGuard.ok) {
          logDecision(supabase, {
            ...base,
            stage: "skipped",
            status: "skip",
            summary: `Fallback blocked by the anti-ban guard: ${fallbackGuard.reason}`,
            data: { code: fallbackGuard.code },
          });
          return { action: "skipped", reason: fallbackGuard.code };
        }
      }
      try {
        const line = await draftCantHelpLine(ctx, intent.language);
        const llmDone = Date.now();
        // Deliver marker: lets a crash-retry prove THIS send happened
        // (correlated dedup above), instead of matching any newer outbound.
        p.deliver_started = { at: Date.now(), first_part: line };
        await supabase
          .from("bot_jobs")
          .update({ payload: p, updated_at: new Date().toISOString() })
          .eq("id", job.id);
        const delivery = await deliverReply(supabase, deps.whapi, ctx, [line], {
          humanPacing: deps.humanPacing,
          botName: settings.bot_name,
        });
        logDecision(supabase, {
          ...base,
          stage: "deliver",
          summary: "Sent a fallback line — the drafted reply was unusable",
          data: {
            parts: delivery.parts,
            whapi_ids: delivery.sentMessageIds,
            fallback: true,
            // Same shape as the normal deliver row so fallback replies show
            // up in the recent_dm_replies SLA measurement too.
            latency_breakdown: {
              total_from_message_s: Math.round((Date.now() - p.ts) / 1000),
              webhook_delivery_s: p.received_at ? Math.round((p.received_at - p.ts) / 1000) : null,
              queue_wait_s: p.received_at
                ? Math.round((processStartAt - p.received_at) / 1000)
                : null,
              llm_s: Math.round((llmDone - processStartAt) / 1000),
              waited_for_target_s: 0,
              attempt: job.attempts,
            },
          },
        });
        return { action: "replied", parts: delivery.parts };
      } catch (e) {
        // The fallback is best-effort — a send failure here must not turn a
        // deliberate "nothing safe to send" into an endless retry loop.
        logDecision(supabase, {
          ...base,
          stage: "error",
          status: "error",
          summary: `Fallback send failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        });
      }
    }
    return { action: "skipped", reason: "empty after safety filter" };
  }

  let joined = parts.join("\n\n");

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
  // receipt (3–10s after the DM). The job is runnable almost immediately, so
  // this SHORT, bounded wait serves most of the remaining delay — never the
  // long inline sleep that used to exceed the Cloudflare Worker request limit
  // and strand the job for minutes. On sweeper retries the target is in the
  // past → no-op. Messages arriving during the wait are handled by the
  // consolidation stage right below, not by a restart.
  let llmMs = Date.now() - processStartAt;
  let waitedForTargetMs = 0;
  if (deps.humanPacing && p.target_reply_at) {
    waitedForTargetMs = Math.min(Math.max(p.target_reply_at - Date.now(), 0), MAX_TARGET_TOPUP_MS);
    if (waitedForTargetMs > 0) {
      await new Promise((r) => setTimeout(r, waitedForTargetMs));
    }
  }

  // --- Newer-message consolidation (single round — replaces the old restart) ---
  // Messages that arrived while we drafted used to flip this cycle to
  // "superseded" so the newest message's job redid intent+draft from scratch;
  // measured live, that restart chain ran the intent stage 3x for one reply
  // and pushed it far past the SLA. Instead: fold the new messages into the
  // already-drafted reply with ONE bounded strong call, then retire the newer
  // pending job(s) so they never run a second cycle.
  const { data: newerRows } = await supabase
    .from("messages")
    .select("body, sender_name, created_at")
    .eq("conversation_id", job.conversation_id)
    .eq("direction", "inbound")
    .gt("created_at", new Date(p.ts).toISOString())
    .order("created_at", { ascending: true })
    .limit(10);
  if (newerRows?.length && message.isGroup) {
    // Consolidation is a DM-latency tool and stays DM-only: its prompt omits
    // groupPromptBlock/group context, so a consolidated group reply would
    // drop the managed-group framing. Groups keep the old behavior — bow out
    // and let the newer message's job reply — but only when that job actually
    // exists: unaddressed chatter and trivial acks never enqueue one, and
    // without an owner this cycle is the only reply the chat will ever get,
    // so it proceeds to send (the newer chatter needs no reply of its own).
    const owned = await hasOwningReplyJob(supabase, {
      chatId: job.chat_id,
      excludeJobId: job.id,
      newestInboundTs: new Date(String(newerRows[newerRows.length - 1].created_at)).getTime(),
    });
    if (owned) {
      logDecision(supabase, {
        ...base,
        stage: "skipped",
        status: "skip",
        summary:
          "A newer message arrived mid-draft — its job owns the reply (consolidation is DM-only)",
      });
      return { action: "skipped", reason: "superseded" };
    }
  } else if (newerRows?.length) {
    t = Date.now();
    // Everything up to this timestamp is covered by the consolidated reply.
    const consolidationCutoff = String(newerRows[newerRows.length - 1].created_at);
    // Snapshot the pending jobs BEFORE the consolidation call: only THESE are
    // covered by the reply being built. A job enqueued while the LLM runs
    // answers a message consolidation never fetched — the chat-wide supersede
    // this replaced used to kill it, silently dropping that message's answer.
    const { data: pendingBefore } = await supabase
      .from("bot_jobs")
      .select("id")
      .eq("chat_id", job.chat_id)
      .eq("kind", "inbound_reply")
      .eq("status", "pending");
    const coveredJobIds = (pendingBefore ?? [])
      .map((r) => String(r.id))
      .filter((id) => id !== job.id);
    try {
      const consolidated = await consolidateReply(
        ctx,
        intent,
        parts,
        newerRows.map((r) => ({ body: String(r.body ?? ""), senderName: r.sender_name })),
      );
      // The consolidated output goes through the same deterministic gates as
      // the draft — an empty result here falls back to the superseded path.
      const { parts: cPersonaSafe, leaked: cLeaked } = sanitizeParts(consolidated.messages);
      const { parts: cParts, leaked: cJsonLeaked } = stripStructuredOutput(cPersonaSafe);
      if (!cParts.length) throw new Error("consolidated reply was empty after safety filtering");

      // ONE consolidation round max. If the chat moved on yet again while we
      // consolidated, give this cycle up the old way — checked BEFORE the
      // supersede below, so the newest message's pending job is still alive
      // to own the reply (rare; the already-replied guard remains the last
      // protection against double answers). Bowing out still requires that
      // owning job to EXIST — an even-newer trivial message has none, and
      // then sending the consolidated reply is the only path that answers
      // anyone at all.
      const { data: evenNewer } = await supabase
        .from("messages")
        .select("created_at")
        .eq("conversation_id", job.conversation_id)
        .eq("direction", "inbound")
        .gt("created_at", consolidationCutoff)
        .order("created_at", { ascending: false })
        .limit(1);
      if (evenNewer?.length) {
        const owned = await hasOwningReplyJob(supabase, {
          chatId: job.chat_id,
          excludeJobId: job.id,
          newestInboundTs: new Date(String(evenNewer[0].created_at)).getTime(),
        });
        if (owned) {
          logDecision(supabase, {
            ...base,
            stage: "skipped",
            status: "skip",
            summary: "More messages arrived during consolidation — the newest job owns the reply",
          });
          return { action: "skipped", reason: "superseded" };
        }
      }

      parts = cParts;
      openQuestion = consolidated.openQuestion;
      joined = parts.join("\n\n");
      llmMs += Date.now() - t;
      // The consolidated reply covers the snapshot jobs' messages — they must
      // never run a second full cycle for content already answered. Jobs
      // enqueued after the snapshot are NOT covered and stay alive.
      await supersedeJobsByIds(supabase, coveredJobIds);
      logDecision(supabase, {
        ...base,
        stage: "draft",
        summary: `Consolidated ${newerRows.length} newer message(s) into the reply — no restart`,
        data: {
          messages: parts,
          consolidated_count: newerRows.length,
          persona_leak_stripped: cLeaked,
          json_envelope_stripped: cJsonLeaked,
        },
        duration_ms: Date.now() - t,
      });
    } catch (e) {
      // Consolidation is best-effort: on failure fall back to the old
      // superseded outcome. Nothing was superseded yet, so the newer pending
      // job is intact and will draft with full context — the contact still
      // gets ONE good answer, just via the slower path. That hand-off only
      // works when the owning job exists; a trivial newer message has none,
      // so then the pre-consolidation draft is sent as-is — an answer that
      // ignores a "תודה" beats no answer at all.
      const owned = await hasOwningReplyJob(supabase, {
        chatId: job.chat_id,
        excludeJobId: job.id,
        newestInboundTs: new Date(consolidationCutoff).getTime(),
      });
      if (owned) {
        logDecision(supabase, {
          ...base,
          stage: "skipped",
          status: "skip",
          summary: `Newer message(s) arrived and consolidation failed — the newer job owns the reply (${String((e as Error)?.message ?? e).slice(0, 120)})`,
        });
        return { action: "skipped", reason: "superseded" };
      }
      logDecision(supabase, {
        ...base,
        stage: "error",
        status: "error",
        summary: `Consolidation failed and no other job covers the newer message(s) — sending the pre-consolidation draft (${String((e as Error)?.message ?? e).slice(0, 120)})`,
      });
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
      // min_gap is TEMPORARY: it only fires when another outbound (e.g. a
      // research answer or follow-up) landed moments before this reply, and
      // dropping the reply for that would silently break never-silent.
      // Defer the job past the gap instead — the retry re-runs the full
      // pipeline with fresh history. Other codes stay hard skips: guards
      // outrank never-silent for blocked/limit/duplicate conditions.
      if (
        guard.code === "min_gap" &&
        !message.isGroup &&
        deps.trigger !== "simulation" &&
        !job.chat_id.endsWith("@simulation")
      ) {
        const lastOut = conv.last_outbound_at
          ? new Date(conv.last_outbound_at).getTime()
          : Date.now();
        logDecision(supabase, {
          ...base,
          stage: "skipped",
          status: "skip",
          summary: `Anti-ban min-gap holds the reply — rescheduled instead of dropped (${guard.reason})`,
          data: { code: guard.code },
        });
        return {
          action: "deferred",
          reason: "min_gap",
          runAfterMs: Math.max(Date.now() + 10_000, lastOut + 3 * 60_000 + 10_000),
        };
      }
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
  // Crash-retry dedup ONLY (attempts > 1), CORRELATED to this job: a previous
  // attempt persisted its deliver marker right before sending, so a matching
  // outbound row proves that attempt died AFTER its send — answering again
  // would be a duplicate. Matching ANY newer outbound (the old rule) is no
  // longer safe: research interims/answers legitimately land in the same
  // conversation and must not swallow this reply. No marker = no previous
  // attempt ever reached the send — reply.
  if (job.attempts > 1 && p.deliver_started) {
    const { data: alreadyReplied } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", job.conversation_id)
      .eq("direction", "outbound")
      .eq("body", p.deliver_started.first_part)
      .gt("created_at", new Date(p.ts).toISOString())
      .limit(1);
    if (alreadyReplied?.length) {
      logDecision(supabase, {
        ...base,
        stage: "skipped",
        status: "skip",
        summary: "Already replied to this message (a previous attempt sent before dying)",
      });
      return { action: "skipped", reason: "already replied" };
    }
  }

  // --- Stage: deliver ---
  t = Date.now();
  try {
    // Deliver marker first: the correlated crash-retry dedup above needs
    // proof of exactly what this attempt was about to send.
    p.deliver_started = { at: Date.now(), first_part: parts[0] };
    await supabase
      .from("bot_jobs")
      .update({ payload: p, updated_at: new Date().toISOString() })
      .eq("id", job.id);
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
        // stuck job; llm covers the reasoning stages (consolidation included);
        // waited_for_target is the intentional human-timing sleep.
        latency_breakdown: {
          total_from_message_s: Math.round((Date.now() - p.ts) / 1000),
          webhook_delivery_s: p.received_at ? Math.round((p.received_at - p.ts) / 1000) : null,
          queue_wait_s: p.received_at ? Math.round((processStartAt - p.received_at) / 1000) : null,
          llm_s: Math.round(llmMs / 1000),
          waited_for_target_s: Math.round(waitedForTargetMs / 1000),
          attempt: job.attempts,
        },
      },
      duration_ms: Date.now() - t,
    });

    // --- Stage: research promise (after the send — failures here never cost
    // a reply). A delivered "I'll check and get back to you" gets a tracked
    // job with a hard 10-minute deadline: research runs immediately, the
    // answer follows in minutes, and the watchdog sends an interim update if
    // it can't. Model flag first (open_question), deterministic text scan as
    // the safety net. DMs only, like follow-ups; research answers must never
    // recurse (the research job itself never enqueues another).
    const researchEligible =
      !message.isGroup &&
      deps.trigger !== "simulation" &&
      !job.chat_id.endsWith("@g.us") &&
      !job.chat_id.endsWith("@simulation") &&
      settings.agent_config?.research_enabled !== false;
    if (researchEligible) {
      try {
        const { detectsCheckBackPromise } = await import("./research");
        const sentText = delivery.parts.join("\n");
        const question = openQuestion ?? (detectsCheckBackPromise(sentText) ? message.body : null);
        if (question) {
          const { enqueueResearchJob } = await import("./research.server");
          const researchJobId = await enqueueResearchJob(supabase, {
            chatId: job.chat_id,
            conversationId: job.conversation_id,
            personWaId: ctx.person?.wa_id ?? null,
            question,
            language: intent.language,
            sourceBody: message.body,
            promiseText: sentText,
            promisedAtMs: Date.now(),
          });
          if (!researchJobId) {
            // The promise went out but nothing tracks it — the one state this
            // feature exists to prevent. A human must own it.
            const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
            await raiseAdminAlert(
              supabase,
              `Reply promised to check and get back, but the research job could not be enqueued (chat ${job.chat_id}) — answer it manually. Question: ${question.slice(0, 200)}`,
            );
          }
          logDecision(supabase, {
            ...base,
            stage: "research",
            status: researchJobId ? "ok" : "error",
            summary: researchJobId
              ? "Reply promised to check and get back — tracked research job enqueued, answer due within 10 minutes"
              : "Reply promised to check and get back but the research job enqueue FAILED — admin alerted",
            data: {
              question: question.slice(0, 300),
              research_job_id: researchJobId,
              detected_by: openQuestion ? "model" : "text_scan",
            },
          });
        }
      } catch (e) {
        console.warn("[pipeline] research enqueue failed (reply already sent):", e);
      }
    }

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
