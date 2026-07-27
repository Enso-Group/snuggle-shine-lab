// Proactive WhatsApp updates to designated admins (agent_config.wa_admins).
//
// Two speeds, deliberately:
//  * IMMEDIATE — pending approvals and errors/alerts call notifyWaAdmins the
//    moment they happen (an approval is time-sensitive, an error is urgent).
//  * BATCHED — routine activity (posts sent, replies, new contacts) is rolled
//    into one digest per ~30min window by sendAdminDigest, from the sweeper.
//
// Admin notifications are a management channel, not persona traffic: they send
// directly through Whapi (no anti-ban pacing/guards — those exist to protect
// the bot's conversational behavior, and the admin's own DM chat runs in
// management mode anyway) but every send is mirrored into the conversation
// history. A per-text throttle stops a crash-looping caller from flooding the
// boss's phone.
import type { AgentDeps, Supa, WhapiPort } from "./types";
import { adminChatId, type WaAdmin } from "./wa-admins";
import { loadWaAdmins } from "./wa-admins.server";

const NOTIFY_THROTTLE_MS = 10 * 60 * 1000;
const DIGEST_INTERVAL_MS = 30 * 60 * 1000;
const DIGEST_MARKER = "Admin digest";

async function defaultWhapi(): Promise<WhapiPort> {
  const { realWhapiPort } = await import("./whapi-port.server");
  return realWhapiPort();
}

/** Find-or-create the admin's DM conversation row so sends can be mirrored. */
async function ensureAdminConversation(
  supabase: Supa,
  admin: WaAdmin,
): Promise<string | null> {
  const chatId = adminChatId(admin);
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", chatId)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data: created } = await supabase
    .from("conversations")
    .insert({ whapi_chat_id: chatId, name: admin.label, is_group: false })
    .select("id")
    .single();
  return created?.id ?? null;
}

export type NotifyResult = { sent: number; skipped: number; errors: number };

/**
 * DM `text` to every configured WhatsApp admin. Never throws — a notification
 * failure must not break the caller (pipeline, alert path, sweeper).
 * An identical text already sent to an admin within the throttle window is
 * skipped (repeat alerts from a crash loop collapse to one ping per window).
 */
export async function notifyWaAdmins(
  supabase: Supa,
  text: string,
  opts: { whapi?: WhapiPort; throttleMs?: number } = {},
): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, skipped: 0, errors: 0 };
  try {
    const admins = await loadWaAdmins(supabase);
    if (!admins.length) return result;
    const whapi = opts.whapi ?? (await defaultWhapi());
    const throttleMs = opts.throttleMs ?? NOTIFY_THROTTLE_MS;
    const body = text.slice(0, 3500);

    for (const admin of admins) {
      try {
        const convId = await ensureAdminConversation(supabase, admin);
        if (convId && throttleMs > 0) {
          const { data: recent } = await supabase
            .from("messages")
            .select("id")
            .eq("conversation_id", convId)
            .eq("direction", "outbound")
            .eq("body", body)
            .gte("created_at", new Date(Date.now() - throttleMs).toISOString())
            .limit(1);
          if (recent?.length) {
            result.skipped++;
            continue;
          }
        }
        const sendRes = await whapi.sendText(adminChatId(admin), body);
        const whapiId = (sendRes as { message?: { id?: string } })?.message?.id ?? null;
        if (convId) {
          await supabase.from("messages").insert({
            conversation_id: convId,
            whapi_message_id: whapiId,
            direction: "outbound",
            sender_name: "Bot",
            sender_id: "bot",
            body,
          });
        }
        result.sent++;
      } catch (e) {
        result.errors++;
        console.error(`[admin-notify] send to ${admin.phone} failed:`, e);
      }
    }
  } catch (e) {
    console.error("[admin-notify] failed:", e);
  }
  return result;
}

type DigestCounts = {
  posts: Array<{ summary: string }>;
  replies: number;
  newContacts: number;
  errors: number;
  pendingApprovals: number;
};

/**
 * One compact WhatsApp digest per window covering the routine activity that
 * doesn't warrant an immediate ping. Runs from the full sweep; the window is
 * everything since the previous digest marker (awaited bot_decisions row —
 * fire-and-forget markers get dropped on CF Workers). Quiet windows advance
 * the marker without sending anything.
 */
export async function sendAdminDigest(
  deps: AgentDeps,
): Promise<{ action: string; sent?: number }> {
  const { supabase } = deps;
  const admins = await loadWaAdmins(supabase);
  if (!admins.length) return { action: "no_admins" };

  const { data: markerRow } = await supabase
    .from("bot_decisions")
    .select("created_at")
    .eq("stage", "config")
    .like("summary", `${DIGEST_MARKER}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastAt = markerRow?.created_at ? Date.parse(markerRow.created_at) : 0;
  if (Date.now() - lastAt < DIGEST_INTERVAL_MS) return { action: "not_due" };
  // First-ever digest: look back one interval, not over all history.
  const sinceIso = new Date(Math.max(lastAt, Date.now() - 6 * 60 * 60 * 1000)).toISOString();

  const [postsRes, deliversRes, peopleRes, errorsRes, approvalsRes] = await Promise.all([
    supabase
      .from("bot_decisions")
      .select("summary, data")
      .eq("stage", "post")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("bot_decisions")
      .select("id, data, chat_id")
      .eq("stage", "deliver")
      .gte("created_at", sinceIso)
      .limit(100),
    supabase
      .from("people")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceIso),
    supabase
      .from("bot_decisions")
      .select("id", { count: "exact", head: true })
      .eq("status", "error")
      .gte("created_at", sinceIso),
    supabase
      .from("scheduled_approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);

  const adminChats = new Set(admins.map((a) => adminChatId(a)));
  const counts: DigestCounts = {
    posts: (postsRes.data ?? []).map((r) => ({ summary: r.summary ?? "Post published" })),
    // Management-mode replies to the admins themselves are not "bot activity"
    // worth reporting back to them.
    replies: (deliversRes.data ?? []).filter(
      (r) =>
        !adminChats.has(String(r.chat_id ?? "")) &&
        !(r.data as { admin_mode?: unknown } | null)?.admin_mode,
    ).length,
    newContacts: peopleRes.count ?? 0,
    errors: errorsRes.count ?? 0,
    pendingApprovals: approvalsRes.count ?? 0,
  };

  const hasNews =
    counts.posts.length > 0 || counts.replies > 0 || counts.newContacts > 0 || counts.errors > 0;

  // Advance the marker FIRST (awaited): even if the sends fail we'd rather
  // miss one digest than double-send it every tick of a broken window.
  await supabase.from("bot_decisions").insert({
    trigger: "scheduled",
    stage: "config",
    summary: `${DIGEST_MARKER}: ${hasNews ? "sent" : "quiet window, nothing sent"}`,
    data: {
      posts: counts.posts.length,
      replies: counts.replies,
      new_contacts: counts.newContacts,
      errors: counts.errors,
      pending_approvals: counts.pendingApprovals,
    },
  });
  if (!hasNews) return { action: "quiet" };

  const lines: string[] = ["📋 עדכון תקופתי מהבוט:"];
  if (counts.posts.length) {
    lines.push(`• ${counts.posts.length} פוסטים פורסמו`);
    for (const p of counts.posts.slice(0, 3)) {
      lines.push(`   - ${p.summary.slice(0, 120)}`);
    }
  }
  if (counts.replies) lines.push(`• ${counts.replies} תשובות נשלחו בצ'אטים`);
  if (counts.newContacts) lines.push(`• ${counts.newContacts} אנשי קשר חדשים`);
  if (counts.errors) lines.push(`• ⚠️ ${counts.errors} שגיאות — פירוט בעמוד Activity`);
  if (counts.pendingApprovals) {
    lines.push(`• 🕓 ${counts.pendingApprovals} פריטים עדיין ממתינים לאישור`);
  }

  const res = await notifyWaAdmins(supabase, lines.join("\n"), {
    whapi: deps.whapi,
    // The digest already has its own 30-min gate; identical-text throttling
    // would wrongly swallow a legitimately repeated quiet-then-same summary.
    throttleMs: 0,
  });
  return { action: "sent", sent: res.sent };
}
