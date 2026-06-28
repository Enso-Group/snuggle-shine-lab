// Whapi.Cloud API wrapper (server-only)
// Docs: https://whapi.readme.io/reference

const WHAPI_BASE = "https://gate.whapi.cloud";

function getToken(): string {
  const token = process.env.WHAPI_TOKEN;
  if (!token) throw new Error("WHAPI_TOKEN is not configured");
  return token;
}

async function whapi<T = any>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${WHAPI_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Whapi ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as any;
  }
}

export async function sendTextMessage(chatId: string, body: string) {
  return whapi("/messages/text", {
    method: "POST",
    body: JSON.stringify({ to: chatId, body }),
  });
}

export async function listMessagesByChatId(chatId: string, count = 30): Promise<any[]> {
  try {
    const safeCount = Math.min(Math.max(Math.floor(count) || 30, 1), 500);
    const r = await whapi<{ messages?: any[] }>(
      `/messages/list/${encodeURIComponent(chatId)}?count=${safeCount}&sort=desc`,
    );
    return r.messages ?? [];
  } catch (e) {
    console.error("[whapi] listMessagesByChatId failed", e);
    return [];
  }
}

export async function listAllMessagesByChatId(chatId: string, maxMessages = 20000): Promise<any[]> {
  const all: any[] = [];
  const pageSize = 500;
  let offset = 0;

  try {
    while (all.length < maxMessages) {
      const count = Math.min(pageSize, maxMessages - all.length);
      const r = await whapi<{ messages?: any[]; total?: number; offset?: number; count?: number }>(
        `/messages/list/${encodeURIComponent(chatId)}?count=${count}&offset=${offset}&sort=desc&normal_types=false`,
      );
      const messages = r.messages ?? [];
      all.push(...messages);

      if (messages.length === 0 || messages.length < count) break;
      offset += messages.length;
      if (typeof r.total === "number" && offset >= r.total) break;
    }
  } catch (e) {
    console.error("[whapi] listAllMessagesByChatId failed", e);
  }

  return all;
}

export async function sendPresence(chatId: string, presence: "typing" | "recording" | "paused" = "typing", delaySec = 3) {
  try {
    await whapi(`/presences/${encodeURIComponent(chatId)}`, {
      method: "PUT",
      body: JSON.stringify({ presence, delay: delaySec }),
    });
  } catch (e) {
    // presence is best-effort
    console.warn("[whapi] presence failed", e);
  }
}

export async function listGroups(): Promise<Array<{ id: string; name: string }>> {
  try {
    const r = await whapi<{ groups?: Array<{ id: string; name?: string; subject?: string }> }>("/groups?count=500");
    return (r.groups ?? []).map((g) => ({ id: g.id, name: g.name || g.subject || g.id }));
  } catch (e) {
    console.error("[whapi] listGroups failed", e);
    return [];
  }
}

export async function getGroup(groupId: string): Promise<any | null> {
  try {
    return await whapi<any>(`/groups/${encodeURIComponent(groupId)}`);
  } catch (e) {
    console.error("[whapi] getGroup failed", e);
    return null;
  }
}

export async function listContacts(): Promise<Array<{ id: string; name: string; pushname?: string }>> {
  try {
    const contacts: Array<{ id: string; name?: string; pushname?: string; first_name?: string; last_name?: string }> = [];
    const seen = new Set<string>();
    const pageSize = 500;
    let offset = 0;

    while (true) {
      const r = await whapi<{
        contacts?: Array<{ id: string; name?: string; pushname?: string; first_name?: string; last_name?: string }>;
        total?: number;
      }>(`/contacts?count=${pageSize}&offset=${offset}`);
      const page = r.contacts ?? [];
      for (const c of page) {
        if (!c.id || seen.has(c.id)) continue;
        seen.add(c.id);
        contacts.push(c);
      }

      offset += page.length;
      if (page.length === 0 || page.length < pageSize) break;
      if (typeof r.total === "number" && offset >= r.total) break;
    }

    return contacts.map((c) => ({
      id: c.id,
      name: c.name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.pushname || c.id,
      pushname: c.pushname,
    }));
  } catch (e) {
    console.error("[whapi] listContacts failed", e);
    return [];
  }
}

export async function listContactLids(contactIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(contactIds.map((id) => id.replace(/@.*$/, "").replace(/\D/g, "")).filter(Boolean))];
  const out: Record<string, string> = {};

  try {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const r = await whapi<Record<string, { lid?: string }>>(
        `/contacts/lids?ContactIDList=${encodeURIComponent(batch.join(","))}`,
      );
      for (const [phoneId, value] of Object.entries(r ?? {})) {
        const phone = phoneId.replace(/@.*$/, "").replace(/\D/g, "");
        if (phone && value?.lid) out[phone] = String(value.lid).replace(/@.*$/, "").replace(/\D/g, "");
      }
    }
  } catch (e) {
    console.error("[whapi] listContactLids failed", e);
  }

  return out;
}

export async function getWhapiSettings(): Promise<{ full_history?: boolean } | null> {
  try {
    return await whapi<{ full_history?: boolean }>("/settings");
  } catch (e) {
    console.error("[whapi] getWhapiSettings failed", e);
    return null;
  }
}

export async function enableWhapiFullHistory(): Promise<{ full_history?: boolean } | null> {
  try {
    return await whapi<{ full_history?: boolean }>("/settings", {
      method: "PATCH",
      body: JSON.stringify({ full_history: true }),
    });
  } catch (e) {
    console.error("[whapi] enableWhapiFullHistory failed", e);
    throw e;
  }
}

export async function logoutWhapiUser(): Promise<{ ok: boolean; alreadyLoggedOut?: boolean }> {
  try {
    await whapi("/users/logout", { method: "POST" });
    return { ok: true };
  } catch (e: any) {
    if (String(e?.message ?? e).includes("Whapi 409")) return { ok: true, alreadyLoggedOut: true };
    console.error("[whapi] logoutWhapiUser failed", e);
    throw e;
  }
}

export async function getWhapiLoginQrImage(): Promise<{ image: string; status: string; expire?: number }> {
  let lastStatus = "";
  let lastError = "";

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const qr = await whapi<{ status?: string; base64?: string; expire?: number }>(
        "/users/login?wakeup=true&size=360&width=360&height=360",
      );
      lastStatus = qr.status ?? "";
      if (qr.base64 && qr.status === "OK") {
        const image = qr.base64.startsWith("data:image") ? qr.base64 : `data:image/png;base64,${qr.base64}`;
        return { image, status: qr.status, expire: qr.expire };
      }
    } catch (e: any) {
      lastError = String(e?.message ?? e);
      if (lastError.includes("Whapi 409")) {
        throw new Error("החיבור עדיין מחובר. נתק את המכשיר המקושר מ-WhatsApp או נסה שוב בעוד כמה שניות.");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`לא נוצר QR אמיתי עדיין. סטטוס אחרון: ${lastStatus || lastError || "לא ידוע"}`);
}


export async function listChats(): Promise<Array<{ id: string; name: string; type: string }>> {
  try {
    const r = await whapi<{ chats?: Array<{ id: string; name?: string; type?: string }> }>("/chats?count=500");
    return (r.chats ?? []).map((c) => ({ id: c.id, name: c.name || c.id, type: c.type || "contact" }));
  } catch (e) {
    console.error("[whapi] listChats failed", e);
    return [];
  }
}

export async function checkHealth(): Promise<{ ok: boolean; status?: string; userName?: string; error?: string }> {
  try {
    const r = await whapi<{ status?: { text?: string }; user?: { name?: string; pushname?: string; id?: string } }>("/health");
    return { ok: true, status: r.status?.text, userName: r.user?.name || r.user?.pushname || r.user?.id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
