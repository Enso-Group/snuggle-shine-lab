import { createFileRoute } from "@tanstack/react-router";

// Naive in-memory rate limit per chat (best-effort; resets per worker instance).
// Keeps the bot from spamming if Whapi delivers a burst.
const lastReplyAt = new Map<string, number>();
const MIN_GAP_MS = 4000; // don't reply to same chat twice within 4s

function pickJid(m: any): { chatId: string; senderId: string; senderName: string; body: string; isGroup: boolean; fromMe: boolean; messageId: string; ts: number } | null {
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
  const ts = (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
  return { chatId, senderId, senderName, body: String(body || ""), isGroup, fromMe, messageId: m.id || "", ts };
}

export const Route = createFileRoute("/api/public/whapi-webhook")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, info: "Whapi webhook endpoint" }),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const secretParam = url.searchParams.get("secret") ?? request.headers.get("x-webhook-secret");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Optional shared-secret check
        const { data: settings } = await supabaseAdmin
          .from("bot_settings")
          .select("id, system_prompt, bot_name, enabled, webhook_secret")
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

        const messages: any[] = payload.messages ?? (payload.event === "messages" ? payload.data : []) ?? [];
        if (!Array.isArray(messages) || messages.length === 0) {
          return Response.json({ ok: true, skipped: "no messages" });
        }

        const enabled = settings?.enabled !== false;
        const systemPrompt = settings?.system_prompt ?? "אתה עוזר חכם בעברית.";

        // Don't block webhook; process best-effort serially
        for (const raw of messages) {
          try {
            const m = pickJid(raw);
            if (!m) continue;

            // Ignore own outgoing messages (no echo loops)
            if (m.fromMe) continue;
            // Ignore non-text
            if (!m.body || !m.body.trim()) continue;
            // Ignore old messages (>2 min)
            if (Date.now() - m.ts > 2 * 60 * 1000) continue;

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
                  name: m.senderName || m.chatId,
                  is_group: m.isGroup,
                  last_message_at: new Date(m.ts).toISOString(),
                })
                .select("id")
                .single();
              convId = ins?.id;
            } else {
              await supabaseAdmin
                .from("conversations")
                .update({ last_message_at: new Date(m.ts).toISOString() })
                .eq("id", convId);
            }
            if (!convId) continue;

            // Save inbound
            await supabaseAdmin.from("messages").insert({
              conversation_id: convId,
              whapi_message_id: m.messageId || null,
              direction: "inbound",
              sender_name: m.senderName || null,
              sender_id: m.senderId,
              body: m.body,
              raw: raw,
            });

            if (!enabled) continue;

            // In groups, only reply when the bot is mentioned or addressed
            if (m.isGroup) {
              const botName = settings?.bot_name ?? "";
              const lower = m.body.toLowerCase();
              const mentioned =
                lower.includes("@" + botName.toLowerCase()) ||
                (botName && lower.includes(botName.toLowerCase())) ||
                /@\d+/.test(m.body);
              if (!mentioned) continue;
            }

            // Per-chat rate limit
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
            // Last user message is the current one; drop the trailing duplicate
            if (history.length && history[history.length - 1].role === "user" && history[history.length - 1].content === m.body) {
              history.pop();
            }

            // Human-like behavior: send typing presence + random delay
            const { sendPresence, sendTextMessage } = await import("@/lib/whapi.server");
            const thinkMs = 1500 + Math.floor(Math.random() * 3500); // 1.5s - 5s
            sendPresence(m.chatId, "typing", Math.ceil(thinkMs / 1000)).catch(() => {});

            const { runAI } = await import("@/lib/ai-brain.server");
            let reply: string;
            try {
              reply = await runAI({ systemPrompt, history, userMessage: m.body });
            } catch (e: any) {
              console.error("[bot] AI failure", e);
              continue;
            }

            // Wait a bit to simulate typing
            await new Promise((r) => setTimeout(r, thinkMs));

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
            } catch (e: any) {
              console.error("[bot] send failed", e);
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
