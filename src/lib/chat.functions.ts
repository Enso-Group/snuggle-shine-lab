import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const MODE = z.enum(["test-bot", "admin", "general"]);

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
    if (thread.mode === "admin") {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
          const { data, error } = await supabaseAdmin
            .from("conversations")
            .select("id, name, whapi_chat_id, is_group, last_message_at, inbound_count")
            .ilike("name", `%${q}%`)
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(15);
          if (error) return `שגיאה: ${error.message}`;
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
          // resolve conversation_id
          let convId: string | null = null;
          let convName = "";
          const byId = await supabaseAdmin
            .from("conversations")
            .select("id, name, whapi_chat_id")
            .eq("whapi_chat_id", chat)
            .maybeSingle();
          if (byId.data) {
            convId = byId.data.id;
            convName = byId.data.name ?? byId.data.whapi_chat_id;
          } else {
            const byName = await supabaseAdmin
              .from("conversations")
              .select("id, name, whapi_chat_id")
              .ilike("name", `%${chat}%`)
              .order("last_message_at", { ascending: false, nullsFirst: false })
              .limit(1)
              .maybeSingle();
            if (byName.data) {
              convId = byName.data.id;
              convName = byName.data.name ?? byName.data.whapi_chat_id;
            }
          }
          if (!convId) return `לא נמצאה שיחה התואמת ל-"${chat}". נסה search_conversations.`;
          const { data, error } = await supabaseAdmin
            .from("messages")
            .select("created_at, direction, sender_name, sender_id, body")
            .eq("conversation_id", convId)
            .order("created_at", { ascending: false })
            .limit(limit);
          if (error) return `שגיאה: ${error.message}`;
          const ordered = (data ?? []).reverse();
          return `שיחה: ${convName}\nסה"כ הודעות שהוחזרו: ${ordered.length}\n\n` +
            ordered
              .map((m) => `[${m.created_at}] ${m.direction === "outbound" ? "🤖 הבוט" : m.sender_name ?? m.sender_id ?? "אנונימי"}: ${m.body ?? ""}`)
              .join("\n");
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
      replyText = await runAI({
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
