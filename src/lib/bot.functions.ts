import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

export const getBotSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("bot_settings")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

export const updateBotSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      system_prompt: z.string().min(1).max(8000),
      bot_name: z.string().min(1).max(80),
      enabled: z.boolean(),
      require_approval_all: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("bot_settings")
      .update({
        system_prompt: data.system_prompt,
        bot_name: data.bot_name,
        enabled: data.enabled,
        ...(data.require_approval_all !== undefined ? { require_approval_all: data.require_approval_all } : {}),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const checkWhapiConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.supabase, context.userId);
    const { checkHealth } = await import("./whapi.server");
    return checkHealth();
  });

export const listWhapiGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.supabase, context.userId);
    const { listGroups, listChats } = await import("./whapi.server");
    const [groups, chats] = await Promise.all([listGroups(), listChats()]);
    return { groups, chats };
  });

export const sendManualMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      target_chat_id: z.string().min(3),
      target_name: z.string().optional(),
      prompt: z.string().min(1).max(4000),
      mode: z.enum(["direct", "ai"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.supabase, context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      loadConversationByChatId,
      checkOutboundAllowed,
      recordOutbound,
      isWhapiRestrictionError,
      raiseAdminAlert,
    } = await import("./anti-ban.server");

    // Admin chose the recipient explicitly. If we don't have a conversation
    // row yet (e.g. manual chat id / first outbound to a group), create one
    // so downstream guards and logging have something to attach to.
    let conv = await loadConversationByChatId(supabaseAdmin, data.target_chat_id);
    if (!conv) {
      const isGroup = data.target_chat_id.endsWith("@g.us");
      const { data: created, error: convErr } = await supabaseAdmin
        .from("conversations")
        .insert({
          whapi_chat_id: data.target_chat_id,
          name: data.target_name ?? data.target_chat_id,
          is_group: isGroup,
        })
        .select("id, whapi_chat_id, inbound_count, consecutive_outbound, blocked, last_outbound_at, last_outbound_body")
        .single();
      if (convErr || !created) {
        throw new Error(`לא ניתן ליצור שיחה חדשה: ${convErr?.message ?? "unknown"}`);
      }
      conv = created as NonNullable<typeof conv>;
    }



    // Log command (pending)
    const { data: log } = await context.supabase
      .from("commands_log")
      .insert({
        user_id: context.userId,
        prompt: data.prompt,
        target_chat_id: data.target_chat_id,
        target_name: data.target_name ?? null,
        status: "pending",
      })
      .select()
      .single();

    try {
      let body = data.prompt;
      if (data.mode === "ai") {
        const { data: settings } = await context.supabase
          .from("bot_settings")
          .select("system_prompt")
          .limit(1)
          .maybeSingle();
        const { runCommand } = await import("./ai-brain.server");
        body = await runCommand(
          data.prompt,
          settings?.system_prompt ?? "אתה עוזר חכם בעברית.",
        );
      }

      // Enforce all anti-ban guards
      const guard = await checkOutboundAllowed(supabaseAdmin, conv, body, { allowColdContact: true });
      if (!guard.ok) {
        if (log?.id) {
          await context.supabase
            .from("commands_log")
            .update({ status: "blocked", result: `[${guard.code}] ${guard.reason}` })
            .eq("id", log.id);
        }
        return { ok: false, blocked: true, code: guard.code, reason: guard.reason, body };
      }

      const { sendTextMessage } = await import("./whapi.server");
      try {
        await sendTextMessage(data.target_chat_id, body);
      } catch (e) {
        if (isWhapiRestrictionError(e)) {
          await supabaseAdmin
            .from("bot_settings")
            .update({ enabled: false })
            .gte("created_at", "1970-01-01");
          await raiseAdminAlert(
            supabaseAdmin,
            `WhatsApp restricted the account — bot disabled. ${String((e as any)?.message ?? e)}`,
          );
        }
        throw e;
      }

      // Persist outbound message + bump counters
      await supabaseAdmin.from("messages").insert({
        conversation_id: conv.id,
        direction: "outbound",
        sender_name: "מנהל",
        sender_id: "manual",
        body,
      });
      await recordOutbound(supabaseAdmin, conv.id, body);

      if (log?.id) {
        await context.supabase
          .from("commands_log")
          .update({ status: "sent", result: body.slice(0, 2000) })
          .eq("id", log.id);
      }
      return { ok: true, body };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (log?.id) {
        await context.supabase
          .from("commands_log")
          .update({ status: "error", result: msg.slice(0, 2000) })
          .eq("id", log.id);
      }
      return { ok: false, blocked: false, code: "send_error", reason: msg };
    }
  });

export const getDashboardStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.supabase, context.userId);
    const [conv, msg, cmd] = await Promise.all([
      context.supabase.from("conversations").select("id", { count: "exact", head: true }),
      context.supabase.from("messages").select("id", { count: "exact", head: true }),
      context.supabase.from("commands_log").select("id", { count: "exact", head: true }),
    ]);
    return {
      conversations: conv.count ?? 0,
      messages: msg.count ?? 0,
      commands: cmd.count ?? 0,
    };
  });

export const checkIsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    return { isAdmin: !!data, userId: context.userId };
  });
