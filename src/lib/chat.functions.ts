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
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const [{ count: convCount }, { count: msgCount }, recent] = await Promise.all([
        supabaseAdmin.from("conversations").select("*", { count: "exact", head: true }),
        supabaseAdmin.from("messages").select("*", { count: "exact", head: true }),
        supabaseAdmin
          .from("conversations")
          .select("name, whapi_chat_id, last_message_at, inbound_count, blocked")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(15),
      ]);
      const list = (recent.data ?? [])
        .map(
          (c) =>
            `- ${c.name ?? c.whapi_chat_id} | last: ${c.last_message_at ?? "—"} | inbound: ${c.inbound_count} | blocked: ${c.blocked}`,
        )
        .join("\n");
      systemPrompt = `אתה עוזר ניהול לאדמין של בוט WhatsApp. ענה בעברית, קצר ולעניין.
נתונים נוכחיים:
- סה"כ שיחות: ${convCount ?? 0}
- סה"כ הודעות: ${msgCount ?? 0}
שיחות אחרונות:
${list || "אין נתונים"}

ענה על שאלות ניהול לפי הנתונים הללו. אם צריך מידע נוסף, אמור שהאדמין יכול לראות בלשונית "שיחות".`;
    } else {
      systemPrompt =
        "אתה עוזר AI כללי, חכם וידידותי. ענה בעברית בצורה ברורה ולעניין. השתמש בכלי החיפוש כשצריך מידע עדכני.";
    }

    // Last entry in history is the user message we just inserted
    const prior = history.slice(0, -1).map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));

    let replyText: string;
    try {
      replyText = await runAI({
        systemPrompt,
        history: prior,
        userMessage: data.content,
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
