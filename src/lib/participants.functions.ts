import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listGroupConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("conversations")
      .select("id, name, whapi_chat_id, last_message_at, inbound_count")
      .eq("is_group", true)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listGroupParticipants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { conversationId: string }) =>
    z.object({ conversationId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("messages")
      .select("sender_id, sender_name, body, created_at")
      .eq("conversation_id", data.conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);

    const map = new Map<
      string,
      { sender_id: string; sender_name: string; message_count: number; last_message_at: string; last_body: string }
    >();
    for (const m of rows ?? []) {
      const key = m.sender_id ?? m.sender_name ?? "anonymous";
      const existing = map.get(key);
      if (existing) {
        existing.message_count += 1;
        if (!existing.sender_name && m.sender_name) existing.sender_name = m.sender_name;
      } else {
        map.set(key, {
          sender_id: m.sender_id ?? "",
          sender_name: m.sender_name ?? m.sender_id ?? "אנונימי",
          message_count: 1,
          last_message_at: m.created_at,
          last_body: m.body ?? "",
        });
      }
    }
    return [...map.values()].sort((a, b) => b.message_count - a.message_count);
  });

export const getParticipantMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { conversationId: string; senderId: string }) =>
    z
      .object({
        conversationId: z.string().uuid(),
        senderId: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const query = supabase
      .from("messages")
      .select("id, body, created_at, sender_name, sender_id")
      .eq("conversation_id", data.conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1000);

    const { data: rows, error } = data.senderId
      ? await query.or(`sender_id.eq.${data.senderId},sender_name.eq.${data.senderId}`)
      : await query;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
