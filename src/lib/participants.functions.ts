import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listGroupConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { listGroups } = await import("./whapi.server");
    const groups = await listGroups();
    return groups
      .map((g) => ({ whapi_chat_id: g.id, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
  });

export const getHistorySyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getWhapiSettings } = await import("./whapi.server");
    const settings = await getWhapiSettings();
    return { fullHistory: settings?.full_history === true };
  });

export const enableHistorySync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { enableWhapiFullHistory, getWhapiSettings } = await import("./whapi.server");
    await enableWhapiFullHistory();
    const settings = await getWhapiSettings();
    return {
      fullHistory: settings?.full_history === true,
      needsReconnect: true,
    };
  });

export const listGroupParticipants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { whapiChatId: string }) =>
    z.object({ whapiChatId: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getGroup, listAllMessagesByChatId, listContacts, listContactLids } = await import("./whapi.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [group, liveMessages, contacts, conv] = await Promise.all([
      getGroup(data.whapiChatId),
      listAllMessagesByChatId(data.whapiChatId),
      listContacts(),
      supabaseAdmin
        .from("conversations")
        .select("id")
        .eq("whapi_chat_id", data.whapiChatId)
        .maybeSingle()
        .then((r) => r.data),
    ]);

    // Build a phone -> name lookup from the contact book
    const contactBook = new Map<string, string>();
    const normalizeId = (raw: string) => raw.replace(/@.*$/, "").replace(/\D/g, "");
    for (const c of contacts ?? []) {
      const phone = normalizeId(c.id);
      if (phone && c.name && c.name !== c.id) contactBook.set(phone, c.name);
    }
    const participants: any[] = group?.participants ?? [];
    const phoneToLid = await listContactLids(participants.map((p) => p.id ?? p.phone ?? ""));
    const lidToPhone = new Map<string, string>();
    for (const [phone, lid] of Object.entries(phoneToLid)) {
      if (phone && lid) lidToPhone.set(lid, phone);
    }
    const participantPhones = new Set(participants.map((p) => normalizeId(p.id ?? p.phone ?? "")).filter(Boolean));
    const resolveSenderKey = (raw: string) => {
      const id = normalizeId(raw);
      if (!id) return "";
      return lidToPhone.get(id) ?? id;
    };
    const resolveName = (id: string, fallback?: string) => {
      const phone = resolveSenderKey(id) || normalizeId(id);
      const fromBook = contactBook.get(phone);
      if (fromBook) return fromBook;
      if (fallback && fallback !== id && fallback !== phone) return fallback;
      return phone || id || "אנונימי";
    };

    const stats = new Map<
      string,
      { sender_id: string; sender_name: string; message_count: number; last_message_at: string | null; last_body: string }
    >();

    const addMessage = (senderId: string, senderName: string, body: string, ts: string | null) => {
      const phone = resolveSenderKey(senderId) || normalizeId(senderId) || senderId;
      if (!phone) return;
      const cur = stats.get(phone);
      const resolved = resolveName(senderId, senderName);
      if (cur) {
        cur.message_count += 1;
        if ((!cur.sender_name || cur.sender_name === cur.sender_id) && resolved) cur.sender_name = resolved;
        if (ts && (!cur.last_message_at || ts > cur.last_message_at)) {
          cur.last_message_at = ts;
          cur.last_body = body;
        }
      } else {
        stats.set(phone, {
          sender_id: phone,
          sender_name: resolved,
          message_count: 1,
          last_message_at: ts,
          last_body: body,
        });
      }
    };

    for (const m of liveMessages ?? []) {
      const senderId = m.from ?? m.author ?? "";
      const senderName = m.from_name ?? m.author_name ?? "";
      const body = m.text?.body ?? m.body ?? m.caption ?? `[${m.type ?? "media"}]`;
      const ts = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null;
      addMessage(senderId, senderName, body, ts);
    }

    if (conv?.id) {
      const { data: dbRows } = await supabaseAdmin
        .from("messages")
        .select("sender_id, sender_name, body, created_at")
        .eq("conversation_id", conv.id)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(5000);
      for (const m of dbRows ?? []) {
        const senderId = m.sender_id ?? "";
        const normalized = resolveSenderKey(senderId) || normalizeId(senderId);
        if (normalized && !participantPhones.has(normalized)) continue;
        addMessage(senderId, m.sender_name ?? "", m.body ?? "", m.created_at);
      }
    }

    // Merge with group roster (participants who haven't messaged)
    for (const p of participants) {
      const id = p.id ?? p.phone ?? "";
      const phone = normalizeId(id) || id;
      const name = resolveName(id, p.name ?? p.pushname ?? p.contact_name);
      const rank = p.rank ?? (p.is_admin ? "admin" : p.is_super_admin ? "creator" : undefined);
      const existing = stats.get(phone);
      if (existing) {
        if (!existing.sender_name || existing.sender_name === existing.sender_id) existing.sender_name = name;
        (existing as any).rank = rank;
      } else {
        stats.set(phone, {
          sender_id: phone,
          sender_name: name,
          message_count: 0,
          last_message_at: null,
          last_body: "",
          ...(rank ? { rank } : {}),
        } as any);
      }
    }

    return {
      groupName: group?.name ?? group?.subject ?? data.whapiChatId,
      participantsCount: participants.length,
      messagesScanned: liveMessages.length,
      rows: [...stats.values()].sort((a, b) => b.message_count - a.message_count),
    };
  });

export const getParticipantMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { whapiChatId: string; senderId: string }) =>
    z
      .object({
        whapiChatId: z.string().min(1),
        senderId: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { getGroup, listAllMessagesByChatId, listContactLids } = await import("./whapi.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const seen = new Set<string>();
    const out: Array<{ id: string; body: string; created_at: string; source: "live" | "db" }> = [];
    const normalizeId = (raw: string) => raw.replace(/@.*$/, "").replace(/\D/g, "");
    const group = await getGroup(data.whapiChatId);
    const participants: any[] = group?.participants ?? [];
    const phoneToLid = await listContactLids(participants.map((p) => p.id ?? p.phone ?? ""));
    const lidToPhone = new Map<string, string>();
    for (const [phone, lid] of Object.entries(phoneToLid)) {
      if (phone && lid) lidToPhone.set(lid, phone);
    }
    const selectedId = normalizeId(data.senderId);
    const selectedLid = phoneToLid[selectedId];
    const resolveSenderKey = (raw: string) => {
      const id = normalizeId(raw);
      if (!id) return "";
      return lidToPhone.get(id) ?? id;
    };
    const isSelectedSender = (rawId: string, rawName?: string | null) => {
      const id = normalizeId(rawId);
      const resolved = resolveSenderKey(rawId);
      return resolved === selectedId || id === selectedId || id === selectedLid || rawName === data.senderId;
    };

    const live = await listAllMessagesByChatId(data.whapiChatId);
    for (const m of live ?? []) {
      const senderId = m.from ?? m.author ?? "";
      const senderName = m.from_name ?? m.author_name ?? "";
      if (!isSelectedSender(senderId, senderName)) continue;
      const id = String(m.id ?? `${m.timestamp}-${senderId}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        body: m.text?.body ?? m.body ?? m.caption ?? "",
        created_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
        source: "live",
      });
    }

    const { data: conv } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("whapi_chat_id", data.whapiChatId)
      .maybeSingle();

    if (conv?.id) {
      const { data: dbRows } = await supabaseAdmin
        .from("messages")
        .select("id, body, created_at, sender_id, sender_name, whapi_message_id")
        .eq("conversation_id", conv.id)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(10000);
      for (const m of dbRows ?? []) {
        if (!isSelectedSender(m.sender_id ?? "", m.sender_name)) continue;
        const key = m.whapi_message_id ?? m.id;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: m.id, body: m.body ?? "", created_at: m.created_at, source: "db" });
      }
    }

    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  });
