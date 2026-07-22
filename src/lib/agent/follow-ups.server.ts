// Follow-up engine — runs from the every-minute sweeper. Claims due
// follow-ups one at a time (compare-and-swap, safe across isolates), checks
// they are still relevant, drafts a short natural nudge with the strong model,
// and sends it under the same anti-ban guards and approval gate as any reply.
import { callLLM } from "@/lib/llm.server";
import { loadAgentSettings } from "./context.server";
import { logDecision } from "./decisions.server";
import { deliverReply } from "./deliver.server";
import { loadOrCreatePerson, personPromptBlock } from "./people.server";
import { sanitizeParts } from "./stages.server";
import { buildHumanizeRules, buildDateContext } from "./prompts.server";
import type { AgentContext, AgentDeps } from "./types";

type FollowUpRow = {
  id: string;
  conversation_id: string;
  chat_id: string;
  person_wa_id: string | null;
  due_at: string;
  reason: string;
  status: string;
  attempts: number;
  created_at: string;
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30 * 60 * 1000;

export type FollowUpRunResult = {
  due: number;
  results: Array<{ id: string; action: string; detail?: string }>;
};

export async function processDueFollowUps(
  deps: AgentDeps,
  opts: { max?: number } = {},
): Promise<FollowUpRunResult> {
  const { supabase } = deps;
  const max = opts.max ?? 2;
  const results: FollowUpRunResult["results"] = [];

  const settings = await loadAgentSettings(supabase);
  if (!settings || !settings.enabled) return { due: 0, results };
  if (settings.agent_config?.follow_ups_enabled === false) return { due: 0, results };

  const { data: dueRows, error } = await supabase
    .from("follow_ups")
    .select(
      "id, conversation_id, chat_id, person_wa_id, due_at, reason, status, attempts, created_at",
    )
    .eq("status", "pending")
    .lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .limit(max);
  if (error) {
    // Table may not exist yet mid-rollout — never take the sweeper down.
    console.warn("[follow-ups] load failed:", error.message);
    return { due: 0, results };
  }

  for (const row of (dueRows ?? []) as FollowUpRow[]) {
    // Claim via CAS: only one isolate can flip pending → sending.
    const { data: claimed } = await supabase
      .from("follow_ups")
      .update({
        status: "sending",
        attempts: row.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    try {
      const outcome = await sendOneFollowUp(deps, settings, row);
      results.push({ id: row.id, ...outcome });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const permanent = row.attempts + 1 >= MAX_ATTEMPTS;
      await supabase
        .from("follow_ups")
        .update({
          status: permanent ? "failed" : "pending",
          due_at: permanent ? row.due_at : new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
          last_error: msg.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      results.push({ id: row.id, action: "failed", detail: msg.slice(0, 120) });
    }
  }
  return { due: dueRows?.length ?? 0, results };
}

async function finish(
  deps: AgentDeps,
  row: FollowUpRow,
  status: "sent" | "queued_approval" | "cancelled",
  summary: string,
): Promise<{ action: string; detail?: string }> {
  await deps.supabase
    .from("follow_ups")
    .update({
      status,
      ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  logDecision(deps.supabase, {
    conversation_id: row.conversation_id,
    chat_id: row.chat_id,
    trigger: "follow_up",
    stage: "follow_up",
    status: status === "cancelled" ? "skip" : "ok",
    summary,
    data: { follow_up_id: row.id, reason: row.reason },
  });
  return { action: status, detail: summary };
}

async function sendOneFollowUp(
  deps: AgentDeps,
  settings: NonNullable<Awaited<ReturnType<typeof loadAgentSettings>>>,
  row: FollowUpRow,
): Promise<{ action: string; detail?: string }> {
  const { supabase } = deps;

  const { data: conv } = await supabase
    .from("conversations")
    .select(
      "id, whapi_chat_id, name, is_group, inbound_count, consecutive_outbound, blocked, last_outbound_at, last_outbound_body",
    )
    .eq("id", row.conversation_id)
    .maybeSingle();
  if (!conv) return finish(deps, row, "cancelled", "Conversation no longer exists");
  if (conv.blocked) return finish(deps, row, "cancelled", "Contact is blocked — no follow-ups");

  // Still relevant? Any message since the follow-up was scheduled cancels it:
  // an inbound means they came back; an outbound means someone already pinged.
  const { data: newer } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", row.conversation_id)
    .gt("created_at", row.created_at)
    .limit(1);
  if (newer?.length) {
    return finish(
      deps,
      row,
      "cancelled",
      "Conversation moved on since scheduling — follow-up no longer needed",
    );
  }

  // Draft the nudge.
  const { data: hist } = await supabase
    .from("messages")
    .select("direction, body")
    .eq("conversation_id", row.conversation_id)
    .order("created_at", { ascending: false })
    .limit(16);
  const history = (hist ?? [])
    .reverse()
    .filter((h) => h.body)
    .map(
      (h) => `${h.direction === "outbound" ? "אנחנו" : "הלקוח"}: ${String(h.body).slice(0, 250)}`,
    )
    .join("\n");

  const person = row.person_wa_id ? await loadOrCreatePerson(supabase, row.person_wa_id) : null;

  const system =
    settings.system_prompt +
    buildHumanizeRules() +
    buildDateContext() +
    personPromptBlock(person) +
    `

משימה: כתוב הודעת מעקב אחת, קצרה וטבעית (משפט אחד-שניים), בשפה שבה התנהלה השיחה.
הסיבה למעקב: ${row.reason}
בלי לחץ מכירתי, בלי "רק רציתי לוודא", בלי להתנצל על ההודעה. פשוט המשך שיחה אנושי שמזמין תגובה. החזר את טקסט ההודעה בלבד.`;

  const res = await callLLM({
    role: "strong",
    source: "agent_follow_up",
    overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
    messages: [
      { role: "system", content: system },
      { role: "user", content: `השיחה עד כה:\n${history || "(אין היסטוריה)"}` },
    ],
  });
  const { parts } = sanitizeParts([res.content.trim()]);
  const text = parts[0];
  if (!text) throw new Error("follow-up draft came back empty");

  // Approval gate mirrors the reply pipeline.
  if (settings.require_approval_all) {
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin")
      .limit(1)
      .maybeSingle();
    if (!adminRole?.user_id) throw new Error("no approval owner for follow-up");
    await supabase.from("scheduled_approvals").insert({
      user_id: adminRole.user_id,
      conversation_id: row.conversation_id,
      target_chat_id: row.chat_id,
      target_name: conv.name ?? row.chat_id,
      body: text,
      source: "follow_up",
      status: "pending",
    });
    return finish(deps, row, "queued_approval", "Follow-up awaiting human approval");
  }

  // Anti-ban guards right before the send.
  const { checkOutboundAllowed } = await import("@/lib/anti-ban.server");
  const guard = await checkOutboundAllowed(supabase, conv, text);
  if (!guard.ok) {
    if (guard.code === "consecutive_limit" || guard.code === "blocked") {
      return finish(deps, row, "cancelled", `Cancelled by the anti-ban guard: ${guard.reason}`);
    }
    // Temporary condition (min gap / hourly cap) — try again later.
    await supabase
      .from("follow_ups")
      .update({
        status: "pending",
        due_at: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { action: "deferred", detail: guard.code };
  }

  const ctx = {
    settings,
    conversation: conv,
    history: [],
    message: {
      chatId: row.chat_id,
      chatName: conv.name ?? "",
      senderId: row.person_wa_id ?? row.chat_id,
      senderName: "",
      body: "",
      isGroup: !!conv.is_group,
      fromMe: false,
      messageId: "",
      ts: Date.now(),
      mentions: [],
      quotedId: null,
      quotedAuthor: null,
    },
  } satisfies AgentContext;

  await deliverReply(supabase, deps.whapi, ctx, [text], {
    humanPacing: deps.humanPacing,
    botName: settings.bot_name,
  });
  return finish(deps, row, "sent", `Follow-up sent: ${text.slice(0, 120)}`);
}
