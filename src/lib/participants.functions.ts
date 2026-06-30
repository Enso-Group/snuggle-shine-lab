import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

function normalizePhone(raw: unknown) {
  return String(raw ?? "").replace(/@.*$/, "").replace(/\D/g, "");
}

function normalizeWhapiTs(raw: unknown) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n > 9_999_999_999 ? n : n * 1000).toISOString();
}

function getMessageBody(m: any) {
  return String(
    m?.text?.body ??
      m?.body ??
      m?.caption ??
      (typeof m?.text === "string" ? m.text : "") ??
      `[${m?.type ?? "media"}]`,
  );
}

export const resetWhatsAppPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { webhookUrl: string }) =>
    z.object({ webhookUrl: z.string().url() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { resetWhapiPipeline, getWhapiSettings, checkHealth } = await import("./whapi.server");
    await resetWhapiPipeline(data.webhookUrl);
    const [settings, health] = await Promise.all([getWhapiSettings(), checkHealth()]);
    const webhooks = (settings as any)?.webhooks ?? [];
    return {
      fullHistory: (settings as any)?.full_history === true,
      webhookUrl: webhooks[0]?.url ?? null,
      webhookEvents: webhooks[0]?.events ?? [],
      connected: health.status === "AUTH",
      status: health.status ?? null,
      userName: health.userName ?? null,
    };
  });


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

export const getWhatsAppConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { checkHealth, getWhapiSettings } = await import("./whapi.server");
    const [health, settings] = await Promise.all([checkHealth(), getWhapiSettings()]);
    return {
      ok: health.ok,
      status: health.status ?? null,
      connected: health.status === "AUTH",
      userName: health.userName ?? null,
      fullHistory: settings?.full_history === true,
      error: health.error ?? null,
    };
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

export const startWhatsAppReconnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { enableWhapiFullHistory, getWhapiLoginQrImage, getWhapiSettings, logoutWhapiUser, checkHealth } = await import("./whapi.server");
    await enableWhapiFullHistory();
    await logoutWhapiUser();
    const qr = await getWhapiLoginQrImage();
    const [settings, health] = await Promise.all([getWhapiSettings(), checkHealth()]);
    return {
      qrImage: qr.image,
      qrStatus: qr.status,
      qrExpire: qr.expire ?? null,
      status: health.status ?? "QR",
      fullHistory: settings?.full_history === true,
    };
  });

export const fetchWhatsAppQr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getWhapiLoginQrImage, checkHealth } = await import("./whapi.server");
    const qr = await getWhapiLoginQrImage();
    const health = await checkHealth();
    return {
      qrImage: qr.image,
      qrStatus: qr.status,
      qrExpire: qr.expire ?? null,
      status: health.status ?? qr.status,
    };
  });

export const listGroupParticipants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { whapiChatId: string }) =>
    z.object({ whapiChatId: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getGroup, listAllMessagesByChatId, listContacts, listContactLids, checkHealth } = await import("./whapi.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [groupBase, liveMessages, contacts, health, conv] = await Promise.all([
      getGroup(data.whapiChatId, true),
      listAllMessagesByChatId(data.whapiChatId),
      listContacts(),
      checkHealth(),
      supabaseAdmin
        .from("conversations")
        .select("id")
        .eq("whapi_chat_id", data.whapiChatId)
        .maybeSingle()
        .then((r) => r.data),
    ]);
    let group = groupBase;

    // Build a phone -> name lookup from the contact book
    const contactBook = new Map<string, string>();
    const normalizeId = normalizePhone;
    for (const c of contacts ?? []) {
      const phone = normalizeId(c.id);
      if (phone && c.name && c.name !== c.id) contactBook.set(phone, c.name);
    }
    let participants: any[] = Array.isArray(group?.participants) ? group.participants : [];
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
    const ownPhone = resolveSenderKey(health.userId ?? "") || normalizeId(health.userId ?? "");
    if (ownPhone) participantPhones.add(ownPhone);
    const getSenderId = (m: any) => {
      if (m.from_me) return resolveSenderKey(m.from ?? m.author ?? ownPhone) || normalizeId(m.from ?? m.author ?? ownPhone) || ownPhone;
      return resolveSenderKey(m.from ?? m.author ?? "") || m.from || m.author || data.whapiChatId;
    };
    const getSenderName = (m: any) => {
      if (m.from_me) return health.userName || contactBook.get(ownPhone) || "אני";
      return m.from_name ?? m.author_name ?? m.pushname ?? "";
    };
    const resolveName = (id: string, fallback?: string) => {
      const phone = resolveSenderKey(id) || normalizeId(id);
      const fromBook = contactBook.get(phone);
      if (fromBook) return fromBook;
      if (fallback && fallback !== id && fallback !== phone) return fallback;
      return phone || id || "אנונימי";
    };

    const upsertConversation = async () => {
      if (conv?.id) return conv.id as string;
      const { data: existing } = await supabaseAdmin
        .from("conversations")
        .select("id")
        .eq("whapi_chat_id", data.whapiChatId)
        .maybeSingle();
      if (existing?.id) return existing.id as string;
      const { data: inserted } = await supabaseAdmin
        .from("conversations")
        .insert({
          whapi_chat_id: data.whapiChatId,
          name: group?.name ?? group?.subject ?? data.whapiChatId,
          is_group: String(data.whapiChatId).endsWith("@g.us"),
          last_message_at: liveMessages[0]?.timestamp ? normalizeWhapiTs(liveMessages[0].timestamp) : null,
        })
        .select("id")
        .single();
      return inserted?.id as string | undefined;
    };

    async function persistLiveHistory() {
      const convId = await upsertConversation();
      if (!convId || !liveMessages.length) return;
      const { data: existingRows } = await supabaseAdmin
        .from("messages")
        .select("whapi_message_id")
        .eq("conversation_id", convId)
        .not("whapi_message_id", "is", null)
        .limit(10000);
      const existing = new Set((existingRows ?? []).map((r: any) => r.whapi_message_id).filter(Boolean));
      const rows = (liveMessages ?? [])
        .filter((m: any) => m.id && !existing.has(m.id))
        .map((m: any) => ({
          conversation_id: convId,
          whapi_message_id: m.id,
          direction: "inbound",
          sender_name: getSenderName(m) || null,
          sender_id: getSenderId(m),
          body: getMessageBody(m),
          raw: m,
          created_at: normalizeWhapiTs(m.timestamp),
        }));
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        if (batch.length) await supabaseAdmin.from("messages").insert(batch);
      }
      const latest = rows.map((r) => r.created_at).sort().at(-1);
      if (latest) {
        await supabaseAdmin
          .from("conversations")
          .update({ last_message_at: latest, name: group?.name ?? group?.subject ?? data.whapiChatId })
          .eq("id", convId);
      }
    }

    const stats = new Map<
      string,
      { sender_id: string; sender_name: string; message_count: number; last_message_at: string | null; last_body: string }
    >();
    const countedMessageKeys = new Set<string>();

    const addMessage = (senderId: string, senderName: string, body: string, ts: string | null, uniqueKey?: string | null) => {
      const phone = resolveSenderKey(senderId) || normalizeId(senderId) || senderId;
      if (!phone) return;
      const countKey = uniqueKey || `${phone}-${ts ?? ""}-${body}`;
      if (countedMessageKeys.has(countKey)) return;
      countedMessageKeys.add(countKey);
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
      const senderId = getSenderId(m);
      const senderName = getSenderName(m);
      const body = getMessageBody(m);
      const ts = m.timestamp ? normalizeWhapiTs(m.timestamp) : null;
      addMessage(senderId, senderName, body, ts, m.id ?? null);
    }

    if (participants.length === 0 && stats.size > 0) {
      participants = [...stats.values()].map((p) => ({ id: p.sender_id, name: p.sender_name, rank: "member" }));
      group = { ...(group ?? {}), participants, participants_count: participants.length };
    }

    await persistLiveHistory();

    if (conv?.id) {
      const { data: dbRows } = await supabaseAdmin
        .from("messages")
        .select("id, whapi_message_id, sender_id, sender_name, body, created_at")
        .eq("conversation_id", conv.id)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(5000);
      for (const m of dbRows ?? []) {
        const senderId = m.sender_id ?? "";
        const normalized = resolveSenderKey(senderId) || normalizeId(senderId);
        if (participantPhones.size > 0 && normalized && !participantPhones.has(normalized)) continue;
        addMessage(senderId, m.sender_name ?? "", m.body ?? "", m.created_at, m.whapi_message_id ?? m.id);
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
      participantsCount: group?.participants_count ?? participants.length,
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
    const { getGroup, listAllMessagesByChatId, listContactLids, checkHealth } = await import("./whapi.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const seen = new Set<string>();
    const out: Array<{ id: string; body: string; created_at: string; source: "live" | "db" }> = [];
    const normalizeId = normalizePhone;
    const [group, health] = await Promise.all([getGroup(data.whapiChatId), checkHealth()]);
    const participants: any[] = group?.participants ?? [];
    const phoneToLid = await listContactLids(participants.map((p) => p.id ?? p.phone ?? ""));
    const lidToPhone = new Map<string, string>();
    for (const [phone, lid] of Object.entries(phoneToLid)) {
      if (phone && lid) lidToPhone.set(lid, phone);
    }
    const selectedId = normalizeId(data.senderId);
    const selectedLid = phoneToLid[selectedId];
    const ownPhone = normalizeId(health.userId ?? "");
    const resolveSenderKey = (raw: string) => {
      const id = normalizeId(raw);
      if (!id) return "";
      return lidToPhone.get(id) ?? id;
    };
    const getSenderId = (m: any) => {
      if (m.from_me) return resolveSenderKey(m.from ?? m.author ?? ownPhone) || normalizeId(m.from ?? m.author ?? ownPhone) || ownPhone;
      return m.from ?? m.author ?? "";
    };
    const isSelectedSender = (rawId: string, rawName?: string | null) => {
      const id = normalizeId(rawId);
      const resolved = resolveSenderKey(rawId);
      return resolved === selectedId || id === selectedId || id === selectedLid || rawName === data.senderId;
    };

    const live = await listAllMessagesByChatId(data.whapiChatId);
    for (const m of live ?? []) {
      const senderId = getSenderId(m);
      const senderName = m.from_me ? health.userName ?? "אני" : m.from_name ?? m.author_name ?? "";
      if (!isSelectedSender(senderId, senderName)) continue;
      const id = String(m.id ?? `${m.timestamp}-${senderId}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        body: getMessageBody(m),
        created_at: m.timestamp ? normalizeWhapiTs(m.timestamp) : new Date().toISOString(),
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
