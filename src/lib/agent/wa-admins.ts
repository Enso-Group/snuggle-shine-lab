// WhatsApp admins — phone numbers designated on the Users & Access page that
// unlock management mode when they DM the bot. Pure helpers only; the list
// itself lives in bot_settings.agent_config.wa_admins (no migration needed).
//
// SECURITY MODEL: an admin is recognized ONLY by the canonical phone digits of
// the DM chat id — never by display name, never in groups, never for our own
// (fromMe) messages, never in simulation. '@lid' ids are numeric but are NOT
// phone numbers, so they can never match a stored phone (fail-closed).
import { normalizeWaId } from "./wa-id";
import { isDmChatId } from "./inbound";

export type WaAdmin = {
  /** Canonical phone digits, e.g. "972501234567". */
  phone: string;
  /** Human label shown in the dashboard and used when the bot addresses them. */
  label: string;
  added_at?: string;
};

/**
 * Normalize a phone number as typed by a human into canonical digits.
 * Accepts local Israeli form ("0501234567" → "972501234567"), international
 * digits, "+972..." and separators. Returns null for anything that can't be a
 * real phone (too short/long, demo markers, group ids).
 */
export function normalizeAdminPhone(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.includes("@g.us") || raw.toLowerCase().includes("demo")) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const phone = /^0\d{8,9}$/.test(digits) ? `972${digits.slice(1)}` : digits;
  if (phone.length < 8 || phone.length > 15) return null;
  return phone;
}

/** Parse the agent_config.wa_admins value defensively (jsonb → typed list). */
export function parseWaAdmins(raw: unknown): WaAdmin[] {
  if (!Array.isArray(raw)) return [];
  const out: WaAdmin[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const phone = normalizeAdminPhone((item as { phone?: unknown }).phone as string);
    if (!phone) continue;
    const label = String((item as { label?: unknown }).label ?? "").trim();
    const added = (item as { added_at?: unknown }).added_at;
    out.push({
      phone,
      label: label.slice(0, 80) || phone,
      ...(typeof added === "string" ? { added_at: added } : {}),
    });
  }
  return out;
}

/**
 * The admin matching a DM chat id, or null. The ONLY admin-recognition
 * decision point: DM chats only (groups/channels/simulation ids normalize
 * away or fail isDmChatId), matched on canonical digits.
 */
export function findWaAdmin(
  admins: WaAdmin[] | null | undefined,
  chatId: string | null | undefined,
): WaAdmin | null {
  if (!admins?.length || !chatId) return null;
  if (!isDmChatId(chatId)) return null;
  const canonical = normalizeWaId(chatId);
  // '@lid'/'@simulation' come back raw (non-digit forms) — they must never
  // match a phone, so require pure digits.
  if (!canonical || !/^\d+$/.test(canonical)) return null;
  return admins.find((a) => a.phone === canonical) ?? null;
}

/** The DM chat id notifications to this admin are sent to. */
export function adminChatId(admin: WaAdmin): string {
  return `${admin.phone}@s.whatsapp.net`;
}
