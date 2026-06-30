import { createFileRoute } from "@tanstack/react-router";

// Per-chat in-memory state (best-effort; durable rules live in DB via anti-ban.server)
const lastReplyAt = new Map<string, number>();
const latestInboundAt = new Map<string, number>();
const MIN_GAP_MS = 800;

function normalizeTimestampMs(raw: unknown) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n > 9_999_999_999 ? n : n * 1000;
}

function pickJid(m: any): { chatId: string; chatName: string; senderId: string; senderName: string; body: string; isGroup: boolean; fromMe: boolean; messageId: string; ts: number } | null {
  if (!m) return null;
  const chatId = m.chat_id || m.from || m.chatId;
  if (!chatId) return null;
  const isGroup = String(chatId).endsWith("@g.us");
  const fromMe = !!m.from_me;
  const body =
    m.text?.body ??
    m.body ??
    m.caption ??
    (typeof m.text === "string" ? m.text : "") ??
    "";
  const senderId = m.from || m.author || chatId;
  const senderName = m.from_name || m.author_name || m.pushname || "";
  const chatName = m.chat_name || m.chat?.name || m.group_name || "";
  const ts = normalizeTimestampMs(m.timestamp);
  return { chatId, chatName, senderId, senderName, body: String(body || ""), isGroup, fromMe, messageId: m.id || "", ts };
}

export const Route = createFileRoute("/api/public/whapi-webhook")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, info: "Whapi webhook endpoint" }),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const secretParam = url.searchParams.get("secret") ?? request.headers.get("x-webhook-secret");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: settings } = await supabaseAdmin
          .from("bot_settings")
          .select("id, system_prompt, bot_name, enabled, webhook_secret, require_approval_all")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (settings?.webhook_secret && settings.webhook_secret !== secretParam) {
          return new Response("forbidden", { status: 403 });
        }

        let payload: any;
        try {
          payload = await request.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }

        const messages: any[] =
          (Array.isArray(payload.messages) && payload.messages) ||
          (Array.isArray(payload.data) && payload.data) ||
          (payload.message ? [payload.message] : []) ||
          [];
        console.log("[webhook] payload keys:", Object.keys(payload || {}), "messages:", messages.length);
        if (messages.length === 0) {
          console.log("[webhook] raw payload (no messages):", JSON.stringify(payload).slice(0, 800));
          return Response.json({ ok: true, skipped: "no messages", keys: Object.keys(payload || {}) });
        }

        const enabled = settings?.enabled !== false;
        const systemPrompt = settings?.system_prompt ?? "אתה עוזר חכם בעברית.";

        const {
          isStopRequest,
          recordInbound,
          recordOutbound,
          checkOutboundAllowed,
          loadConversationByChatId,
          isWhapiRestrictionError,
          raiseAdminAlert,
        } = await import("@/lib/anti-ban.server");

        for (const raw of messages) {
          try {
            const m = pickJid(raw);
            if (!m) continue;

            if (!m.body || !m.body.trim()) continue;
            const isFreshMessage = Math.abs(Date.now() - m.ts) <= 2 * 60 * 1000;
            let ownUser: { id?: string; name?: string } = {};
            if (m.fromMe) {
              try {
                const { checkHealth } = await import("@/lib/whapi.server");
                const health = await checkHealth();
                ownUser = { id: health.userId, name: health.userName };
              } catch {}
            }

            // Upsert conversation
            const { data: convExisting } = await supabaseAdmin
              .from("conversations")
              .select("id")
              .eq("whapi_chat_id", m.chatId)
              .maybeSingle();

            let convId = convExisting?.id as string | undefined;
            if (!convId) {
              const { data: ins } = await supabaseAdmin
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
              await supabaseAdmin
                .from("conversations")
                .update({
                  last_message_at: new Date(m.ts).toISOString(),
                  ...(m.chatName ? { name: m.chatName } : {}),
                })
                .eq("id", convId);
            }
            if (!convId) continue;

            if (m.messageId) {
              const { data: existingMessage } = await supabaseAdmin
                .from("messages")
                .select("id")
                .eq("conversation_id", convId)
                .eq("whapi_message_id", m.messageId)
                .maybeSingle();
              if (existingMessage?.id) continue;
            }

            // Save inbound message row
            await supabaseAdmin.from("messages").insert({
              conversation_id: convId,
              whapi_message_id: m.messageId || null,
              direction: "inbound",
              sender_name: m.fromMe ? ownUser.name || m.senderName || "אני" : m.senderName || null,
              sender_id: m.fromMe ? ownUser.id || m.senderId : m.senderId,
              body: m.body,
              raw: raw,
              created_at: new Date(m.ts).toISOString(),
            });

            // Messages sent from the linked phone should be stored and counted,
            // but must never trigger bot replies or anti-ban inbound counters.
            if (m.fromMe) continue;

            // Historical replay should be stored, but must never trigger old bot replies.
            if (!isFreshMessage) continue;

            // Update inbound counters + auto-block if stop request
            const { blockedNow } = await recordInbound(supabaseAdmin, convId, m.body);

            if (!enabled) continue;
            if (blockedNow) {
              // Honor stop silently — no confirmation reply (never message them again)
              continue;
            }
            if (isStopRequest(m.body)) continue; // double-guard

            // In groups, only reply if addressed
            if (m.isGroup) {
              const botName = settings?.bot_name ?? "";
              const lower = m.body.toLowerCase();
              const mentioned =
                lower.includes("@" + botName.toLowerCase()) ||
                (botName && lower.includes(botName.toLowerCase())) ||
                /@\d+/.test(m.body);
              if (!mentioned) continue;
            }

            // Track latest inbound for this chat so a newer message cancels this reply
            const myInboundTs = m.ts || Date.now();
            latestInboundAt.set(m.chatId, Math.max(latestInboundAt.get(m.chatId) ?? 0, myInboundTs));

            // Tiny burst guard (avoid double-processing same payload)
            const last = lastReplyAt.get(m.chatId) ?? 0;
            if (Date.now() - last < MIN_GAP_MS) continue;
            lastReplyAt.set(m.chatId, Date.now());

            // Load short history
            const { data: hist } = await supabaseAdmin
              .from("messages")
              .select("direction, body")
              .eq("conversation_id", convId)
              .order("created_at", { ascending: false })
              .limit(30);
            const history = (hist ?? [])
              .reverse()
              .filter((h) => h.body)
              .map((h) => ({
                role: (h.direction === "outbound" ? "assistant" : "user") as "user" | "assistant",
                content: h.body as string,
              }));
            if (history.length && history[history.length - 1].role === "user" && history[history.length - 1].content === m.body) {
              history.pop();
            }

            const { sendPresence, sendTextMessage } = await import("@/lib/whapi.server");
            sendPresence(m.chatId, "typing", 3).catch(() => {});

            const { runAI, isTrivialMessage } = await import("@/lib/ai-brain.server");
            if (isTrivialMessage(m.body)) {
              console.log("[bot] trivial message skipped");
              continue;
            }
            let reply: string;
            try {
              reply = await runAI({ systemPrompt, history, userMessage: m.body, chatId: m.chatId, source: "whatsapp" });
              if (!reply) continue;
            } catch (e: any) {
              console.error("[bot] AI failure", e);
              continue;
            }

            // If a newer inbound arrived while we were thinking, abort — the newer one will be handled
            if ((latestInboundAt.get(m.chatId) ?? 0) > myInboundTs) {
              console.log("[bot] superseded by newer inbound, skipping send");
              continue;
            }

            // Re-check anti-ban guards immediately before sending
            const conv = await loadConversationByChatId(supabaseAdmin, m.chatId);
            if (conv) {
              const guard = await checkOutboundAllowed(supabaseAdmin, conv, reply);
              if (!guard.ok) {
                console.warn("[bot] outbound blocked", guard.code, guard.reason);
                continue;
              }
            }



            // Global approval gate — queue instead of sending
            if (settings?.require_approval_all) {
              const { data: admin } = await supabaseAdmin
                .from("user_roles")
                .select("user_id")
                .eq("role", "admin")
                .limit(1)
                .maybeSingle();
              if (admin?.user_id) {
                await supabaseAdmin.from("scheduled_approvals").insert({
                  user_id: admin.user_id,
                  conversation_id: convId,
                  target_chat_id: m.chatId,
                  target_name: m.chatName || m.senderName || m.chatId,
                  body: reply,
                  source: "ai_reply",
                  status: "pending",
                });
              }
              continue;
            }

            try {
              const sendRes: any = await sendTextMessage(m.chatId, reply);
              await supabaseAdmin.from("messages").insert({
                conversation_id: convId,
                whapi_message_id: sendRes?.message?.id ?? null,
                direction: "outbound",
                sender_name: settings?.bot_name ?? "הבוט",
                sender_id: "bot",
                body: reply,
                raw: sendRes,
              });
              await recordOutbound(supabaseAdmin, convId, reply);
            } catch (e: any) {
              console.error("[bot] send failed", e);
              if (isWhapiRestrictionError(e)) {
                // Halt + alert admin
                if (settings?.id) {
                  await supabaseAdmin
                    .from("bot_settings")
                    .update({ enabled: false })
                    .eq("id", settings.id);
                }
                await raiseAdminAlert(
                  supabaseAdmin,
                  `WhatsApp restricted the account — bot disabled. Error: ${String(e?.message ?? e)}`,
                );
                return Response.json({ ok: false, halted: true });
              }
            }
          } catch (e) {
            console.error("[webhook] handler error", e);
          }
        }

        return Response.json({ ok: true, processed: messages.length });
      },
    },
  },
});
