// Server-side channel scoping: resolve the currently connected WhatsApp
// account and gate/scope dashboard reads to it.
//
// Two guarantees the dashboard relies on:
//  * disconnected  → getConnectedChannel().phone is null → callers return empty
//    (no stale data from a previous session is shown).
//  * connected     → reads are filtered to this account's channel_phone, so a
//    previously-linked number's data is never mixed in.
import { normalizeChannelPhone } from "./channel";
import type { Supa } from "./types";

export type ConnectedChannel = { connected: boolean; phone: string | null };

// checkHealth hits Whapi; several server functions run per dashboard load, so
// cache the result briefly per isolate to avoid hammering the API.
const HEALTH_TTL_MS = 15_000;
let healthCache: { at: number; value: ConnectedChannel } | null = null;

export async function getConnectedChannel(): Promise<ConnectedChannel> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  let value: ConnectedChannel = { connected: false, phone: null };
  try {
    const { checkHealth } = await import("@/lib/whapi.server");
    const h = await checkHealth();
    const connected = h.status === "AUTH";
    const phone = connected ? normalizeChannelPhone(h.userId) : "";
    value = { connected, phone: phone || null };
  } catch {
    value = { connected: false, phone: null };
  }
  healthCache = { at: Date.now(), value };
  return value;
}

// Whether the channel_phone columns exist yet (the scoping migration may not
// have been applied on the very first deploy). Cached per isolate. Until the
// columns exist, scoping is skipped and only the connection gate applies —
// never a hard error.
let scopeReady: boolean | null = null;

export async function channelScopeReady(supabase: Supa): Promise<boolean> {
  if (scopeReady !== null) return scopeReady;
  const { error } = await supabase.from("conversations").select("channel_phone").limit(1);
  scopeReady = !(error && (error.code === "42703" || /channel_phone/i.test(error.message)));
  return scopeReady;
}

/** For tests / redeploys — forget the cached health + column probe. */
export function resetChannelCaches(): void {
  healthCache = null;
  scopeReady = null;
}
