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
    const safeCount = Math.min(Math.max(Math.floor(count) || 30, 1), 200);
    const r = await whapi<{ messages?: any[] }>(
      `/messages/list/${encodeURIComponent(chatId)}?count=${safeCount}&sort=desc`,
    );
    return r.messages ?? [];
  } catch (e) {
    console.error("[whapi] listMessagesByChatId failed", e);
    return [];
  }
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
    const r = await whapi<{ groups?: Array<{ id: string; name?: string; subject?: string }> }>("/groups?count=200");
    return (r.groups ?? []).map((g) => ({ id: g.id, name: g.name || g.subject || g.id }));
  } catch (e) {
    console.error("[whapi] listGroups failed", e);
    return [];
  }
}

export async function listChats(): Promise<Array<{ id: string; name: string; type: string }>> {
  try {
    const r = await whapi<{ chats?: Array<{ id: string; name?: string; type?: string }> }>("/chats?count=100");
    return (r.chats ?? []).map((c) => ({ id: c.id, name: c.name || c.id, type: c.type || "contact" }));
  } catch (e) {
    console.error("[whapi] listChats failed", e);
    return [];
  }
}

export async function checkHealth(): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const r = await whapi<{ status?: { text?: string } }>("/health");
    return { ok: true, status: r.status?.text };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
