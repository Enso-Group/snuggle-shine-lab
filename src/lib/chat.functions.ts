import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const MODE = z.enum(["test-bot", "admin", "general"]);

function normalizeLookup(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[״"׳']/g, "")
    .replace(/[^\p{L}\p{N}@.+-]+/gu, " ")
    .trim()
    .toLowerCase();
}

function fuzzyMatches(haystack: string, needle: string) {
  const hay = normalizeLookup(haystack);
  const q = normalizeLookup(needle);
  if (!q) return false;
  if (hay.includes(q) || q.includes(hay)) return true;
  const tokens = q.split(" ").filter((token) => token.length > 1);
  return tokens.length > 0 && tokens.every((token) => hay.includes(token));
}

function extractChatLookup(content: string) {
  const quoted = content.match(/["“”']([^"“”']{2,})["“”']/)?.[1];
  if (quoted) return quoted.trim();

  const marker = content.match(/(?:מהקבוצה|מקבוצה|מהצ[׳']?אט|מצ[׳']?אט|בשם)\s+(.+)$/i)?.[1];
  const base = marker ?? content;
  const cleaned = base
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/הודעות|הודעה|אחרונות|האחרונות|אחרונים|תביא|תן|לי|אפשר|בבקשה|קבוצה|צ[׳']?אט|chat|group|last|messages/gi, " ")
    .replace(/[?:.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || content.trim();
}

function requestedLimit(content: string) {
  const parsed = Number(content.match(/\b(\d{1,3})\b/)?.[1] ?? 30);
  return Math.min(Math.max(parsed || 30, 1), 200);
}

function shouldDoDirectMessageLookup(
  content: string,
  prior: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const lookupWords = /הודעות|הודעה|אחרונות|האחרונות|קבוצה|צ[׳']?אט|chat|group|messages/i.test(content);
  const previousAssistant = [...prior].reverse().find((msg) => msg.role === "assistant")?.content ?? "";
  const answeringMissingName = /לא מוצא|לא נמצאה|שם המדויק|איזה שם/.test(previousAssistant) && content.trim().length <= 120;
  return lookupWords || answeringMissingName;
}

export const listThreads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("chat_threads")
      .select("id, title, mode, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { mode?: string }) =>
    z.object({ mode: MODE.default("general") }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const titleMap: Record<string, string> = {
      "test-bot": "בדיקת הבוט",
      admin: "שאלת ניהול",
      general: "שיחה חדשה",
    };
    const { data: row, error } = await supabase
      .from("chat_threads")
      .insert({ user_id: userId, mode: data.mode, title: titleMap[data.mode] })
      .select("id, title, mode, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("chat_threads")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getThreadMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { threadId: string }) =>
    z.object({ threadId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: thread, error: tErr } = await supabase
      .from("chat_threads")
      .select("id, title, mode")
      .eq("id", data.threadId)
      .eq("user_id", userId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!thread) throw new Error("Thread not found");

    const { data: rows, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("thread_id", data.threadId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { thread, messages: rows ?? [] };
  });

export const sendChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { threadId: string; content: string }) =>
    z
      .object({
        threadId: z.string().uuid(),
        content: z.string().min(1).max(4000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Verify thread ownership and load mode
    const { data: thread, error: tErr } = await supabase
      .from("chat_threads")
      .select("id, mode, title")
      .eq("id", data.threadId)
      .eq("user_id", userId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!thread) throw new Error("Thread not found");

    // Save user message
    const { error: insErr } = await supabase.from("chat_messages").insert({
      thread_id: thread.id,
      user_id: userId,
      role: "user",
      content: data.content,
    });
    if (insErr) throw new Error(insErr.message);

    // Load full history (ordered)
    const { data: history, error: hErr } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", thread.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (hErr) throw new Error(hErr.message);

    // Build mode-specific system prompt
    const { runAI } = await import("./ai-brain.server");
    let systemPrompt = "";

    if (thread.mode === "test-bot") {
      const { data: settings } = await supabase
        .from("bot_settings")
        .select("system_prompt, bot_name")
        .limit(1)
        .maybeSingle();
      systemPrompt =
        (settings?.system_prompt ??
          "אתה עוזר חכם וידידותי שעונה בעברית בצורה טבעית כמו בן אדם.") +
        `\n\n[מצב בדיקה: ענה בדיוק כפי שהיית עונה ל-WhatsApp בתור "${settings?.bot_name ?? "הבוט"}".]`;
    } else if (thread.mode === "admin") {
      systemPrompt = `אתה עוזר ניהול לאדמין של בוט WhatsApp. ענה בעברית, קצר ולעניין.
יש לך גישה מלאה למסד הנתונים של הבוט דרך כלים:
- search_conversations(query): חפש שיחות/קבוצות לפי שם או חלק משם.
- list_conversations(limit): רשימת השיחות האחרונות לפי פעילות.
- get_messages(chat_id_or_name, limit): קבל הודעות אחרונות משיחה מסוימת (אפשר להעביר whapi_chat_id או שם). ברירת מחדל 30, מקסימום 200.
- stats(): סטטיסטיקות כלליות (כמה שיחות, כמה הודעות, וכו').

כשהמשתמש מבקש הודעות מקבוצה מסוימת — קודם תקרא search_conversations כדי למצוא את ה-id, אחר כך get_messages.
החזר את ההודעות בפורמט קריא: זמן · שם השולח · תוכן. אל תמציא נתונים.`;
    } else {
      systemPrompt =
        "אתה עוזר AI כללי, חכם וידידותי. ענה בעברית בצורה ברורה ולעניין. השתמש בכלי החיפוש כשצריך מידע עדכני.";
    }

    // Last entry in history is the user message we just inserted
    const prior = history.slice(0, -1).map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));

    // Admin tools (DB access via service role) — only enabled for admin mode
    let extraTools: any[] | undefined;
    let toolExecutor: ((name: string, args: Record<string, unknown>) => Promise<string>) | undefined;
    let directAdminReply: string | undefined;
    if (thread.mode === "admin") {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      type ConversationCandidate = {
        id: string | null;
        name: string | null;
        whapi_chat_id: string;
        is_group: boolean;
        last_message_at: string | null;
        inbound_count: number | null;
        source: "database" | "whapi";
      };

      const syncLiveConversation = async (candidate: ConversationCandidate) => {
        if (candidate.id) return candidate;
        const { data: synced } = await supabaseAdmin
          .from("conversations")
          .upsert(
            {
              whapi_chat_id: candidate.whapi_chat_id,
              name: candidate.name ?? candidate.whapi_chat_id,
              is_group: candidate.is_group,
            },
            { onConflict: "whapi_chat_id" },
          )
          .select("id, name, whapi_chat_id, is_group, last_message_at, inbound_count")
          .single();
        return synced
          ? ({ ...synced, source: "database" as const })
          : candidate;
      };

      const searchConversationCandidates = async (query: string) => {
        const q = query.trim();
        const candidateMap = new Map<string, ConversationCandidate>();
        const addCandidate = (candidate: ConversationCandidate) => {
          const key = candidate.whapi_chat_id;
          const existing = candidateMap.get(key);
          if (!existing || existing.source === "whapi") {
            candidateMap.set(key, candidate);
          }
        };

        const { data: dbRows, error } = await supabaseAdmin
          .from("conversations")
          .select("id, name, whapi_chat_id, is_group, last_message_at, inbound_count")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(200);
        if (error) throw new Error(error.message);

        for (const row of dbRows ?? []) {
          const rawName = row.name ?? "";
          const rawId = row.whapi_chat_id ?? "";
          if (!q || fuzzyMatches(`${rawName} ${rawId}`, q)) {
            addCandidate({ ...row, source: "database" });
          }
        }

        if (q) {
          try {
            const { listGroups, listChats } = await import("./whapi.server");
            const [groups, chats] = await Promise.all([listGroups(), listChats()]);
            for (const group of groups) {
              if (fuzzyMatches(`${group.name} ${group.id}`, q)) {
                addCandidate({
                  id: null,
                  name: group.name,
                  whapi_chat_id: group.id,
                  is_group: true,
                  last_message_at: null,
                  inbound_count: null,
                  source: "whapi",
                });
              }
            }
            for (const chat of chats) {
              if (fuzzyMatches(`${chat.name} ${chat.id}`, q)) {
                addCandidate({
                  id: null,
                  name: chat.name,
                  whapi_chat_id: chat.id,
                  is_group: chat.type === "group" || chat.id.endsWith("@g.us"),
                  last_message_at: null,
                  inbound_count: null,
                  source: "whapi",
                });
              }
            }
          } catch (e) {
            console.warn("[admin-chat] live Whapi lookup failed", e);
          }
        }

        return [...candidateMap.values()].slice(0, 25);
      };

      const resolveConversation = async (chat: string) => {
        const byId = await supabaseAdmin
          .from("conversations")
          .select("id, name, whapi_chat_id, is_group, last_message_at, inbound_count")
          .eq("whapi_chat_id", chat)
          .maybeSingle();
        if (byId.data) return { ...byId.data, source: "database" as const };

        const matches = await searchConversationCandidates(chat);
        if (!matches.length) return null;
        return syncLiveConversation(matches[0]);
      };

      const formatMessagesForConversation = async (chat: string, limit: number) => {
        const conversation = await resolveConversation(chat);
        if (!conversation?.id) {
          const suggestions = await searchConversationCandidates(chat);
          if (suggestions.length) {
            return `לא נמצאה שיחה שמורה בשם "${chat}", אבל מצאתי אפשרויות דומות:\n` +
              suggestions
                .slice(0, 8)
                .map((item, index) => `${index + 1}. ${item.name ?? item.whapi_chat_id} (${item.whapi_chat_id})`)
                .join("\n");
          }
          return `לא נמצאה שיחה או קבוצה בשם "${chat}" גם במסד הנתונים וגם ברשימת הצ׳אטים החיה.`;
        }

        const { data, error } = await supabaseAdmin
          .from("messages")
          .select("created_at, direction, sender_name, sender_id, body")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return `שגיאה: ${error.message}`;

        const ordered = (data ?? []).reverse();
        const conversationName = conversation.name ?? conversation.whapi_chat_id;
        if (!ordered.length) {
          return `מצאתי את ${conversation.is_group ? "הקבוצה" : "השיחה"} "${conversationName}" (${conversation.whapi_chat_id}), אבל עדיין אין לה הודעות שמורות במערכת. הודעות יופיעו כאן אחרי שהבוט יקבל אותן דרך הוובהוק.`;
        }

        return `שיחה: ${conversationName}\nסה"כ הודעות שהוחזרו: ${ordered.length}\n\n` +
          ordered
            .map((m) => `[${m.created_at}] ${m.direction === "outbound" ? "🤖 הבוט" : m.sender_name ?? m.sender_id ?? "אנונימי"}: ${m.body ?? ""}`)
            .join("\n");
      };

      if (shouldDoDirectMessageLookup(data.content, prior)) {
        directAdminReply = await formatMessagesForConversation(
          extractChatLookup(data.content),
          requestedLimit(data.content),
        );
      }

      extraTools = [
        {
          type: "function",
          function: {
            name: "search_conversations",
            description: "חפש שיחות לפי שם (חלקי, case-insensitive). מחזיר id, שם, whapi_chat_id, האם קבוצה, וזמן הודעה אחרון.",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "list_conversations",
            description: "רשימת שיחות אחרונות לפי last_message_at.",
            parameters: {
              type: "object",
              properties: { limit: { type: "number", description: "ברירת מחדל 20, מקסימום 100" } },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "get_messages",
            description: "ההודעות האחרונות בשיחה. מקבל whapi_chat_id מדויק או שם (חלקי).",
            parameters: {
              type: "object",
              properties: {
                chat: { type: "string", description: "whapi_chat_id או שם השיחה/קבוצה" },
                limit: { type: "number", description: "ברירת מחדל 30, מקסימום 200" },
              },
              required: ["chat"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "stats",
            description: "סטטיסטיקות כלליות על הבוט.",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      toolExecutor = async (name, args) => {
        if (name === "search_conversations") {
          const q = String(args.query ?? "").trim();
          if (!q) return "חסר query";
          const data = await searchConversationCandidates(q);
          if (!data?.length) return "לא נמצאו שיחות תואמות.";
          return JSON.stringify(data, null, 2);
        }
        if (name === "list_conversations") {
          const limit = Math.min(Number(args.limit ?? 20) || 20, 100);
          const { data, error } = await supabaseAdmin
            .from("conversations")
            .select("id, name, whapi_chat_id, is_group, last_message_at, inbound_count, blocked")
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(limit);
          if (error) return `שגיאה: ${error.message}`;
          return JSON.stringify(data ?? [], null, 2);
        }
        if (name === "get_messages") {
          const chat = String(args.chat ?? "").trim();
          if (!chat) return "חסר chat";
          const limit = Math.min(Number(args.limit ?? 30) || 30, 200);
          return formatMessagesForConversation(chat, limit);
        }
        if (name === "stats") {
          const [{ count: convCount }, { count: msgCount }, { count: blockedCount }] = await Promise.all([
            supabaseAdmin.from("conversations").select("*", { count: "exact", head: true }),
            supabaseAdmin.from("messages").select("*", { count: "exact", head: true }),
            supabaseAdmin.from("conversations").select("*", { count: "exact", head: true }).eq("blocked", true),
          ]);
          return JSON.stringify({ conversations: convCount, messages: msgCount, blocked: blockedCount }, null, 2);
        }
        return `כלי לא ידוע: ${name}`;
      };
    }

    let replyText: string;
    try {
      replyText = directAdminReply ??
        await runAI({
          systemPrompt,
          history: prior,
          userMessage: data.content,
          extraTools,
          toolExecutor,
        });
    } catch (e: any) {
      replyText = `שגיאה: ${String(e?.message ?? e)}`;
    }


    await supabase.from("chat_messages").insert({
      thread_id: thread.id,
      user_id: userId,
      role: "assistant",
      content: replyText,
    });

    // Auto-title: first user message → thread title (truncate)
    if (history.length === 1) {
      const newTitle = data.content.slice(0, 60);
      await supabase
        .from("chat_threads")
        .update({ title: newTitle, updated_at: new Date().toISOString() })
        .eq("id", thread.id)
        .eq("user_id", userId);
    } else {
      await supabase
        .from("chat_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", thread.id)
        .eq("user_id", userId);
    }

    return { reply: replyText };
  });
