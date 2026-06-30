// Anti-ban guardrails. All checks/state live in Supabase via supabaseAdmin.
// Rules enforced:
//  - Stop/unsubscribe words => block contact, never message again
//  - Outbound only to conversations with prior inbound (no cold-contact / broadcast)
//  - Max 3 consecutive outbound to same chat without a reply
//  - Min 3 minutes between outbound to same chat (+ random jitter)
//  - Max 10 distinct chats messaged per rolling hour
//  - No duplicate body text (vary wording vs. last outbound to same chat)
//  - On Whapi-side restriction error, halt sending + alert admin

const STOP_PATTERNS = [
  // English
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bdon'?t contact me\b/i,
  /\bleave me alone\b/i,
  /\bremove me\b/i,
  // Hebrew
  /תפסיק/i,
  /תפסיקי/i,
  /הסר אותי/i,
  /תוריד אותי/i,
  /אל תכתוב לי/i,
  /אל תכתבי לי/i,
  /לא מעוניין/i,
  /לא מעוניינת/i,
  /להסיר/i,
];

export function isStopRequest(text: string): boolean {
  if (!text) return false;
  return STOP_PATTERNS.some((re) => re.test(text));
}

export type ConversationRow = {
  id: string;
  whapi_chat_id: string;
  inbound_count: number;
  consecutive_outbound: number;
  blocked: boolean;
  last_outbound_at: string | null;
  last_outbound_body: string | null;
};

const MIN_GAP_BETWEEN_OUTBOUND_MS = 3 * 60 * 1000; // 3 min
const MAX_RANDOM_JITTER_MS = 2 * 60 * 1000; // up to +2 min => 3-5 min window
const MAX_CONSECUTIVE_OUTBOUND = 3;
const MAX_DISTINCT_CHATS_PER_HOUR = 10;

export type GuardOk = { ok: true; jitterMs: number };
export type GuardBlock = { ok: false; reason: string; code: string };
export type GuardResult = GuardOk | GuardBlock;
export type GuardOptions = { allowColdContact?: boolean };

export async function checkOutboundAllowed(
  supabaseAdmin: any,
  conv: ConversationRow,
  body: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  if (conv.blocked) {
    return { ok: false, code: "blocked", reason: "איש קשר חסום (ביקש להפסיק או הוסר ידנית)." };
  }
  if (!options.allowColdContact && (!conv.inbound_count || conv.inbound_count <= 0)) {
    return {
      ok: false,
      code: "cold_contact",
      reason: "אסור לשלוח לאיש קשר שלא יזם שיחה. שלחי רק למי שכתב לבוט קודם.",
    };
  }
  if ((conv.consecutive_outbound ?? 0) >= MAX_CONSECUTIVE_OUTBOUND) {
    return {
      ok: false,
      code: "consecutive_limit",
      reason: `כבר נשלחו ${MAX_CONSECUTIVE_OUTBOUND} הודעות ברצף ללא תשובה. ממתינים לתגובה.`,
    };
  }
  // Min-gap only applies when we're piling outbound on top of outbound.
  // If the user just replied (consecutive_outbound was reset to 0), respond immediately.
  if (conv.last_outbound_at && (conv.consecutive_outbound ?? 0) > 0) {
    const since = Date.now() - new Date(conv.last_outbound_at).getTime();
    if (since < MIN_GAP_BETWEEN_OUTBOUND_MS) {
      const wait = Math.ceil((MIN_GAP_BETWEEN_OUTBOUND_MS - since) / 1000);
      return {
        ok: false,
        code: "min_gap",
        reason: `יש להמתין לפחות 3 דקות בין הודעות לאותו צ'אט. נסי שוב בעוד ${wait} שניות.`,
      };
    }
  }

  if (conv.last_outbound_body && normalizeForCompare(conv.last_outbound_body) === normalizeForCompare(body)) {
    return {
      ok: false,
      code: "duplicate",
      reason: "אסור לשלוח את אותו טקסט פעמיים ברצף — שני נוסח קצת.",
    };
  }

  // Hourly distinct-chat cap
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabaseAdmin
    .from("messages")
    .select("conversation_id")
    .eq("direction", "outbound")
    .gte("created_at", since);
  const distinct = new Set((recent ?? []).map((r: any) => r.conversation_id));
  if (!distinct.has(conv.id) && distinct.size >= MAX_DISTINCT_CHATS_PER_HOUR) {
    return {
      ok: false,
      code: "hourly_cap",
      reason: `הגעת לתקרה של ${MAX_DISTINCT_CHATS_PER_HOUR} אנשי קשר חדשים בשעה האחרונה. המתיני.`,
    };
  }

  // Random jitter on top of the 3-min minimum (used by callers that want it)
  const jitterMs = Math.floor(Math.random() * MAX_RANDOM_JITTER_MS);
  return { ok: true, jitterMs };
}

function normalizeForCompare(s: string) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function loadConversationByChatId(
  supabaseAdmin: any,
  whapiChatId: string,
): Promise<ConversationRow | null> {
  const { data } = await supabaseAdmin
    .from("conversations")
    .select("id, whapi_chat_id, inbound_count, consecutive_outbound, blocked, last_outbound_at, last_outbound_body")
    .eq("whapi_chat_id", whapiChatId)
    .maybeSingle();
  return (data as ConversationRow) ?? null;
}

export async function recordOutbound(
  supabaseAdmin: any,
  convId: string,
  body: string,
) {
  // Bump consecutive_outbound and set last_outbound_*
  const { data: cur } = await supabaseAdmin
    .from("conversations")
    .select("consecutive_outbound")
    .eq("id", convId)
    .maybeSingle();
  const next = (cur?.consecutive_outbound ?? 0) + 1;
  await supabaseAdmin
    .from("conversations")
    .update({
      consecutive_outbound: next,
      last_outbound_at: new Date().toISOString(),
      last_outbound_body: body,
    })
    .eq("id", convId);
}

export async function recordInbound(
  supabaseAdmin: any,
  convId: string,
  body: string,
): Promise<{ blockedNow: boolean }> {
  const stop = isStopRequest(body);
  const patch: Record<string, any> = {
    consecutive_outbound: 0,
  };
  // inbound_count + first_inbound_at — increment via RPC-less read+write
  const { data: cur } = await supabaseAdmin
    .from("conversations")
    .select("inbound_count, first_inbound_at")
    .eq("id", convId)
    .maybeSingle();
  patch.inbound_count = (cur?.inbound_count ?? 0) + 1;
  if (!cur?.first_inbound_at) patch.first_inbound_at = new Date().toISOString();
  if (stop) {
    patch.blocked = true;
    patch.blocked_reason = "user requested stop";
    patch.blocked_at = new Date().toISOString();
  }
  await supabaseAdmin.from("conversations").update(patch).eq("id", convId);
  return { blockedNow: stop };
}

export function isWhapiRestrictionError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("banned") ||
    msg.includes("restricted") ||
    msg.includes("blocked by whatsapp") ||
    msg.includes("forbidden") && msg.includes("whapi")
  );
}

export async function raiseAdminAlert(
  supabaseAdmin: any,
  message: string,
) {
  try {
    // Find any admin user to attach the alert to
    const { data: admin } = await supabaseAdmin
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin")
      .limit(1)
      .maybeSingle();
    if (!admin?.user_id) return;
    await supabaseAdmin.from("commands_log").insert({
      user_id: admin.user_id,
      prompt: "[ALERT] " + message.slice(0, 500),
      target_chat_id: "system",
      target_name: "התראת מערכת",
      status: "alert",
      result: message.slice(0, 2000),
    });
  } catch (e) {
    console.error("[anti-ban] raiseAdminAlert failed", e);
  }
}
