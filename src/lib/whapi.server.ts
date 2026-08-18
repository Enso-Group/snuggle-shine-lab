// Whapi.Cloud API wrapper (server-only)
// Docs: https://whapi.readme.io/reference
//
// ============================================================================
// THIS PROJECT IS DISCONNECTED FROM WHATSAPP (2026-08-17).
//
// The WhatsApp side of this product moved to `kindred-spirits`, which drives
// the same Whapi channel. Two systems answering one WhatsApp account means
// duplicate replies and a webhook each one keeps taking back from the other,
// so this project no longer touches WhatsApp at all.
//
// THE GUARD IS HERE BECAUSE THIS IS THE ONLY DOOR. Every outbound Whapi call
// in this codebase — sending text, images, polls, reading groups and contacts,
// and resetWhapiPipeline, which is what could re-point the webhook away from
// the new system — goes through the single `whapi()` function below. Guarding
// it disconnects the project in one place rather than in thirty call sites,
// none of which can be missed.
//
// NOTHING WAS DELETED. Every message, group and contact this project stored is
// untouched; the dashboard still reads its own history. What stopped is the
// network call.
//
// TO RECONNECT, deliberately: set WHAPI_REENABLE=true in this project's
// secrets and publish. It is an opt-in rather than a default so that restoring
// service is a decision somebody makes, not something a redeploy does by
// accident — and never while kindred-spirits holds the same channel.
// ============================================================================

const WHAPI_BASE = "https://gate.whapi.cloud";
const WHAPI_TIMEOUT_MS = 20_000;

/** Opt-in escape hatch; absent or anything but "true" means disconnected. */
function whatsappReenabled(): boolean {
  return String(process.env.WHAPI_REENABLE ?? "").trim().toLowerCase() === "true";
}

export class WhatsAppDisconnectedError extends Error {
  override readonly name = "WhatsAppDisconnectedError";
  constructor(path: string) {
    super(
      `WhatsApp is disconnected from this project (tried ${path}). ` +
        "The WhatsApp bot now runs in kindred-spirits, which owns this Whapi channel. " +
        "Nothing was sent. Set WHAPI_REENABLE=true here only if that is no longer true.",
    );
  }
}

function getToken(): string {
  const token = process.env.WHAPI_TOKEN;
  if (!token) throw new Error("WHAPI_TOKEN is not configured");
  return token;
}

async function whapi<T = any>(path: string, init?: RequestInit): Promise<T> {
  // BEFORE THE TOKEN IS EVEN READ. Refusing here means a stale credential
  // cannot be used by any path, including one added after this guard.
  if (!whatsappReenabled()) throw new WhatsAppDisconnectedError(path);
  const token = getToken();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), WHAPI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${WHAPI_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; Lovable WhatsApp sync)",
        ...(init?.headers ?? {}),
      },
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(
        "The connection to WhatsApp took too long. Check that the connection is active and try again.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 402 && text.includes("trial version limit exceeded")) {
      throw new Error(
        "Whapi is currently blocking data retrieval due to the Trial limit. You need to upgrade/remove the limit in Whapi and then refresh the group.",
      );
    }
    throw new Error(`Whapi ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as any;
  }
}

function isWhapiTrialLimitError(e: unknown) {
  const msg = String((e as any)?.message ?? e);
  return msg.includes("trial version limit exceeded") || msg.includes("Trial limit");
}

function normalizePhoneLocalPart(local: string): string {
  const digits = local.replace(/\D/g, "");
  // Israeli local numbers are often typed as 05x...; WhatsApp/Whapi expects E.164 without '+'.
  if (/^0\d{9}$/.test(digits)) return `972${digits.slice(1)}`;
  return digits;
}

/**
 * HARD demo fence at the lowest send layer. Demo rows carry a `demo-` chat-id
 * marker, but the phone sanitizer strips non-digits — `demo-972555000101`
 * would launder into a REAL routable number. Every send entry point refuses
 * demo targets outright; dashboard flows special-case them BEFORE calling
 * here so the demo UX still works without a single real send.
 */
export function isDemoTarget(chatId: string): boolean {
  return String(chatId ?? "")
    .trim()
    .toLowerCase()
    .startsWith("demo-");
}

function assertNotDemoTarget(chatId: string): void {
  if (isDemoTarget(chatId)) {
    throw new Error("Demo row — WhatsApp sends are disabled for demo- targets.");
  }
}

function sanitizeWhapiTo(chatId: string): string {
  const raw = String(chatId || "").trim();
  if (!raw) return raw;
  const atIdx = raw.indexOf("@");
  const local = atIdx >= 0 ? raw.slice(0, atIdx) : raw;
  const suffix = atIdx >= 0 ? raw.slice(atIdx) : "";
  // Whapi requires local part to match ^[\d-]{9,31}$ — strip device suffixes like ":5" and any other chars.
  const baseLocal = local.split(":")[0];
  const cleanedLocal =
    suffix === "@g.us" ? baseLocal.replace(/[^\d-]/g, "") : normalizePhoneLocalPart(baseLocal);
  return suffix ? `${cleanedLocal}${suffix}` : cleanedLocal;
}

export async function sendTextMessage(chatId: string, body: string) {
  assertNotDemoTarget(chatId);
  const to = sanitizeWhapiTo(chatId);
  const localPart = to.split("@")[0] ?? "";
  if (!/^[\d-]{9,31}$/.test(localPart)) {
    throw new Error(
      `Invalid recipient for WhatsApp: "${chatId}". Please choose a real contact or group (a phone number or group ID), not a name.`,
    );
  }
  return whapi("/messages/text", {
    method: "POST",
    body: JSON.stringify({ to, body }),
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
    if (isWhapiTrialLimitError(e)) {
      throw new Error(
        "Whapi is currently blocking message retrieval due to the Trial limit. You need to upgrade/remove the limit in Whapi and then refresh the group.",
      );
    }
  }

  return all;
}

function assertSendableRecipient(chatId: string): string {
  assertNotDemoTarget(chatId);
  const to = sanitizeWhapiTo(chatId);
  const localPart = to.split("@")[0] ?? "";
  if (!/^[\d-]{9,31}$/.test(localPart)) {
    throw new Error(
      `Invalid recipient for WhatsApp: "${chatId}". Please choose a real contact or group (a phone number or group ID), not a name.`,
    );
  }
  return to;
}

/**
 * Send media (image / video / document) with an optional caption. `media` is
 * a publicly fetchable URL — Whapi downloads and delivers it natively. The
 * caption rides on the media message itself, so text+attachment is ONE
 * WhatsApp message, exactly like a human sending a photo with a note.
 */
export async function sendImageMessage(chatId: string, mediaUrl: string, caption?: string) {
  const to = assertSendableRecipient(chatId);
  return whapi("/messages/image", {
    method: "POST",
    body: JSON.stringify({ to, media: mediaUrl, ...(caption ? { caption } : {}) }),
  });
}

export async function sendVideoMessage(chatId: string, mediaUrl: string, caption?: string) {
  const to = assertSendableRecipient(chatId);
  return whapi("/messages/video", {
    method: "POST",
    body: JSON.stringify({ to, media: mediaUrl, ...(caption ? { caption } : {}) }),
  });
}

export async function sendDocumentMessage(
  chatId: string,
  mediaUrl: string,
  opts: { caption?: string; filename?: string } = {},
) {
  const to = assertSendableRecipient(chatId);
  return whapi("/messages/document", {
    method: "POST",
    body: JSON.stringify({
      to,
      media: mediaUrl,
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.filename ? { filename: opts.filename } : {}),
    }),
  });
}

/**
 * Send a native WhatsApp poll (tappable, with live vote counts).
 * WhatsApp requires 2-12 unique options; `count` accepts only 0 or 1 —
 * 1 = single choice, 0 = voters may pick any number (use pollCount()).
 */
export async function sendPoll(chatId: string, title: string, options: string[], count = 1) {
  assertNotDemoTarget(chatId);
  const to = sanitizeWhapiTo(chatId);
  const localPart = to.split("@")[0] ?? "";
  if (!/^[\d-]{9,31}$/.test(localPart)) {
    throw new Error(`Invalid recipient for WhatsApp poll: "${chatId}".`);
  }
  return whapi("/messages/poll", {
    method: "POST",
    body: JSON.stringify({ to, title, options, count }),
  });
}

/** Delete a message (ours or a contact's — requires admin rights for others' messages in groups). */
export async function deleteMessage(messageId: string): Promise<{ ok: boolean; error?: string }> {
  if (!messageId) return { ok: false, error: "no message id" };
  try {
    await whapi(`/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn("[whapi] deleteMessage failed", msg);
    return { ok: false, error: msg };
  }
}

/** Remove participants from a group (bot must be a group admin). */
export async function removeGroupParticipants(
  groupId: string,
  participantIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const participants = participantIds
    .map((p) => p.replace(/@.*$/, "").replace(/\D/g, ""))
    .filter(Boolean);
  if (!groupId || !participants.length) return { ok: false, error: "missing group/participants" };
  try {
    await whapi(`/groups/${encodeURIComponent(groupId)}/participants`, {
      method: "DELETE",
      body: JSON.stringify({ participants }),
    });
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn("[whapi] removeGroupParticipants failed", msg);
    return { ok: false, error: msg };
  }
}

/** Mark a received message as read (blue ticks). Best-effort. */
export async function markMessageRead(messageId: string): Promise<void> {
  if (!messageId) return;
  try {
    await whapi(`/messages/${encodeURIComponent(messageId)}`, { method: "PUT" });
  } catch (e) {
    console.warn("[whapi] markMessageRead failed", e);
  }
}

/** React to a message with an emoji (empty string removes the reaction). Best-effort. */
export async function reactToMessage(messageId: string, emoji: string): Promise<void> {
  if (!messageId) return;
  try {
    await whapi(`/messages/${encodeURIComponent(messageId)}/reaction`, {
      method: "PUT",
      body: JSON.stringify({ emoji }),
    });
  } catch (e) {
    console.warn("[whapi] reactToMessage failed", e);
  }
}

export async function sendPresence(
  chatId: string,
  presence: "typing" | "recording" | "paused" = "typing",
  delaySec = 3,
) {
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
    const r = await whapi<{ groups?: Array<{ id: string; name?: string; subject?: string }> }>(
      "/groups?count=500",
    );
    return (r.groups ?? []).map((g) => ({ id: g.id, name: g.name || g.subject || g.id }));
  } catch (e) {
    console.error("[whapi] listGroups failed", e);
    return [];
  }
}

export async function getGroup(groupId: string, resync = false): Promise<any | null> {
  try {
    return await whapi<any>(
      `/groups/${encodeURIComponent(groupId)}${resync ? "?resync=true" : ""}`,
    );
  } catch (e) {
    console.error("[whapi] getGroup failed", e);
    if (isWhapiTrialLimitError(e)) throw e;
    return null;
  }
}

export async function listContacts(): Promise<
  Array<{ id: string; name: string; pushname?: string }>
> {
  try {
    const contacts: Array<{
      id: string;
      name?: string;
      pushname?: string;
      first_name?: string;
      last_name?: string;
    }> = [];
    const seen = new Set<string>();
    const pageSize = 500;
    let offset = 0;

    while (true) {
      const r = await whapi<{
        contacts?: Array<{
          id: string;
          name?: string;
          pushname?: string;
          first_name?: string;
          last_name?: string;
        }>;
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
    if (isWhapiTrialLimitError(e)) throw e;
    return [];
  }
}

export async function listContactLids(contactIds: string[]): Promise<Record<string, string>> {
  const ids = [
    ...new Set(contactIds.map((id) => id.replace(/@.*$/, "").replace(/\D/g, "")).filter(Boolean)),
  ];
  const out: Record<string, string> = {};

  try {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const r = await whapi<Record<string, { lid?: string }>>(
        `/contacts/lids?ContactIDList=${encodeURIComponent(batch.join(","))}`,
      );
      for (const [phoneId, value] of Object.entries(r ?? {})) {
        const phone = phoneId.replace(/@.*$/, "").replace(/\D/g, "");
        if (phone && value?.lid)
          out[phone] = String(value.lid).replace(/@.*$/, "").replace(/\D/g, "");
      }
    }
  } catch (e) {
    console.error("[whapi] listContactLids failed", e);
  }

  return out;
}

export async function getWhapiSettings(): Promise<any | null> {
  try {
    return await whapi<any>("/settings");
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

export async function resetWhapiPipeline(webhookUrl: string): Promise<any> {
  // Single PATCH: enable full history + register our webhook so every
  // incoming message is POSTed to the app automatically.
  // If a webhook secret is configured server-side, bake it into the registered
  // URL so Whapi presents it on every call (the secret never touches the client).
  const secret = process.env.WHAPI_WEBHOOK_SECRET;
  let registeredUrl = webhookUrl;
  if (secret) {
    try {
      const u = new URL(webhookUrl);
      u.searchParams.set("secret", secret);
      registeredUrl = u.toString();
    } catch {
      registeredUrl = `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(secret)}`;
    }
  }
  const body = {
    full_history: true,
    webhooks: [
      {
        url: registeredUrl,
        events: [
          { type: "messages", method: "post" },
          { type: "statuses", method: "post" },
          // Group membership changes (join/leave/request) — powers welcomes
          // and member tracking. Requires re-registering the webhook
          // (Participants → reconnect) after deploy.
          { type: "groups", method: "post" },
        ],
        mode: "body",
      },
    ],
    callback_persist: true,
    callback_backoff_delay_ms: 3000,
    max_callback_backoff_delay_ms: 900000,
  };
  return whapi("/settings", { method: "PATCH", body: JSON.stringify(body) });
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

function normalizeQrImage(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:image")) return trimmed;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

function extractQrImage(payload: any): string {
  const direct = normalizeQrImage(
    payload?.base64 ?? payload?.image ?? payload?.qr ?? payload?.qrcode ?? payload?.qr_code,
  );
  if (direct) return direct;

  const nested = normalizeQrImage(
    payload?.login?.base64 ??
      payload?.login?.image ??
      payload?.login?.qr ??
      payload?.qrCode?.base64 ??
      payload?.qrCode?.image ??
      payload?.data?.base64 ??
      payload?.data?.image ??
      payload?.data?.qr,
  );
  return nested;
}

export async function getWhapiLoginQrImage(): Promise<{
  image: string;
  status: string;
  expire?: number;
}> {
  let lastStatus = "";
  let lastError = "";

  // Whapi needs time after logout for the channel to transition WAITING → QR.
  // Poll up to ~60s and return as soon as base64 is available.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const qr = await whapi<any>("/users/login?wakeup=true&size=360&width=360&height=360");
      lastStatus = qr.status ?? "";
      const image = extractQrImage(qr);
      if (image) {
        return { image, status: qr.status ?? "QR", expire: qr.expire };
      }
      if (qr.status === "AUTH" || qr.status === "AUTHENTICATED") {
        return { image: "", status: qr.status };
      }
    } catch (e: any) {
      lastError = String(e?.message ?? e);
      if (lastError.includes("Whapi 409")) {
        throw new Error(
          "The connection is still active. Unlink the linked device from WhatsApp or try again in a few seconds.",
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Don't throw on transient states — let UI keep polling via the status endpoint.
  if (lastStatus) {
    return { image: "", status: lastStatus };
  }
  throw new Error(
    `No real QR code was generated yet. ${lastError || "Try again in a few seconds."}`,
  );
}

export async function listChats(): Promise<Array<{ id: string; name: string; type: string }>> {
  try {
    const r = await whapi<{ chats?: Array<{ id: string; name?: string; type?: string }> }>(
      "/chats?count=500",
    );
    return (r.chats ?? []).map((c) => ({
      id: c.id,
      name: c.name || c.id,
      type: c.type || "contact",
    }));
  } catch (e) {
    console.error("[whapi] listChats failed", e);
    return [];
  }
}

export async function checkHealth(): Promise<{
  ok: boolean;
  status?: string;
  userName?: string;
  userId?: string;
  error?: string;
}> {
  try {
    const r = await whapi<{
      status?: { text?: string };
      user?: { name?: string; pushname?: string; id?: string };
    }>("/health");
    return {
      ok: true,
      status: r.status?.text,
      userName: r.user?.name || r.user?.pushname || r.user?.id,
      userId: r.user?.id,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
