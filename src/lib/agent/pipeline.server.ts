// Pipeline orchestrator — runs one inbound_reply job through every stage and
// logs each decision. Called by the worker (never directly by routes).
import type { Supa } from "./types";
import type { InboundMessage } from "./inbound";
import { loadAgentSettings, gatherContext } from "./context.server";
import { logDecision } from "./decisions.server";
import { deliverReply } from "./deliver.server";
import { analyzeIntent, critiqueAndRevise, draftReply, sanitizeParts } from "./stages.server";
import type { AgentDeps, BotJob, PipelineOutcome } from "./types";

/** Thrown when retrying can only make things worse (e.g. WhatsApp restriction). */
export class PermanentJobError extends Error {}

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
  const base = {
    job_id: job.id,
    conversation_id: job.conversation_id,
    chat_id: job.chat_id,
    trigger: deps.trigger,
  };

  const settings = await loadAgentSettings(supabase);
  if (!settings || !settings.enabled) {
    logDecision(supabase, { ...base, stage: "skipped", status: "skip", summary: "הבוט כבוי" });
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
    summary: `נטענו ${ctx.history.length} הודעות היסטוריה${ctx.person ? ` + פרופיל עם ${ctx.person.facts.length} עובדות` : ""}`,
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
      summary: "הגיעה הודעה חדשה יותר — התשובה תיכתב בהקשר שלה",
    });
    return { action: "skipped", reason: "superseded" };
  }

  // --- Stage: intent ---
  t = Date.now();
  const intent = await analyzeIntent(ctx);
  logDecision(supabase, {
    ...base,
    stage: "intent",
    summary: `כוונה: ${intent.intent} | שפה: ${intent.language} | דחיפות: ${intent.urgency}${intent.escalate ? " | דורש הסלמה" : ""}`,
    data: intent as unknown as Record<string, unknown>,
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
    summary: draft.reasoning || `נכתבה טיוטה של ${draft.messages.length} הודעות`,
    data: { messages: draft.messages },
    duration_ms: Date.now() - t,
  });

  // --- Stage: critique ---
  t = Date.now();
  const critique = await critiqueAndRevise(ctx, intent, draft);
  const { parts, leaked } = sanitizeParts(critique.messages);
  logDecision(supabase, {
    ...base,
    stage: "critique",
    summary:
      critique.verdict === "revise"
        ? `תוקן: ${critique.issues.join("; ") || critique.reasoning}`
        : "הטיוטה עברה את בדיקת האיכות",
    data: {
      verdict: critique.verdict,
      issues: critique.issues,
      messages: parts,
      persona_leak_stripped: leaked,
    },
    duration_ms: Date.now() - t,
  });

  const joined = parts.join("\n\n");

  // --- Approval gate (global toggle, or the agent itself asked to escalate) ---
  if (settings.require_approval_all || intent.escalate) {
    const ownerUserId = await findApprovalOwner(supabase);
    if (!ownerUserId) {
      logDecision(supabase, {
        ...base,
        stage: "error",
        status: "error",
        summary: "אין משתמש שאפשר לשייך אליו את האישור",
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
        ? `הועבר לאישור אנושי — ${intent.escalate_reason ?? "הסלמה"}`
        : "מצב אישור-לכל פעיל — ממתין לאישור",
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
        summary: `נחסם על ידי מגן אנטי-חסימה: ${guard.reason}`,
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
      summary: "כבר נשלחה תשובה להודעה הזו",
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
      summary: `נשלחו ${delivery.parts.length} הודעות`,
      data: { parts: delivery.parts, whapi_ids: delivery.sentMessageIds },
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
            ? `נשמרו ${extraction.facts.length} עובדות חדשות על ${ctx.person.display_name ?? message.senderName ?? "איש הקשר"}`
            : "אין עובדות חדשות לשמירה",
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
            summary: `תוזמן מעקב בעוד ${extraction.follow_up.hours} שעות — ${extraction.follow_up.reason}`,
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
        summary: "וואטסאפ הגביל את החשבון — הבוט הושבת והמנהל קיבל התראה",
      });
      throw new PermanentJobError(String(err?.message ?? err));
    }
    logDecision(supabase, {
      ...base,
      stage: "error",
      status: "error",
      summary: `שליחה נכשלה: ${String(err?.message ?? err).slice(0, 200)}`,
    });
    throw err;
  }
}
