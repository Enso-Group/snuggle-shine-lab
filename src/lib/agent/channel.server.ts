// Server-side channel scoping: resolve the currently connected WhatsApp
// account and gate/scope dashboard reads to it.
//
// Two guarantees the dashboard relies on:
//  * disconnected  → getConnectedChannel().phone is null → callers return empty
//    (no stale data from a previous session is shown).
//  * connected     → reads are filtered to this account's channel_phone, so a
//    previously-linked number's data is never mixed in.
import { checkHealth } from "@/lib/whapi.server";
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

// Whether the ACCOUNT-ISOLATION migration (channel_phone on every dashboard
// table, 20260802090000) has been applied — probed separately from
// channelScopeReady because the two migrations shipped weeks apart.
let isolationReady: boolean | null = null;

export async function accountScopeReady(supabase: Supa): Promise<boolean> {
  if (isolationReady !== null) return isolationReady;
  try {
    const { error } = await supabase.from("scheduled_approvals").select("channel_phone").limit(1);
    isolationReady = !(error && (error.code === "42703" || /channel_phone/i.test(error.message)));
    return isolationReady;
  } catch {
    // A thrown probe (test fakes, transient outage) must never break a write
    // path — treat as not-ready this once, without caching the verdict.
    return false;
  }
}

export type ChannelScope =
  | { mode: "disconnected"; phone: null }
  | { mode: "unscoped"; phone: string }
  | { mode: "scoped"; phone: string };

/**
 * The one call every dashboard read starts with. "disconnected" ⇒ show
 * NOTHING; "scoped" ⇒ filter with strict .eq("channel_phone", phone) — a NULL
 * channel_phone is never visible; "unscoped" (isolation migration not applied
 * yet) ⇒ connection gate only, never a hard error.
 */
export async function getChannelScope(supabase: Supa): Promise<ChannelScope> {
  const { connected, phone } = await getConnectedChannel();
  if (!connected || !phone) return { mode: "disconnected", phone: null };
  return (await accountScopeReady(supabase))
    ? { mode: "scoped", phone }
    : { mode: "unscoped", phone };
}

/**
 * Spreadable INSERT/UPSERT stamp: `{ channel_phone }` of the connected
 * account, or `{}` while disconnected or before the isolation migration (a
 * missing column must never fail a write — the sweeper adopts NULLs).
 */
export async function channelStamp(supabase: Supa): Promise<{ channel_phone?: string }> {
  if (!(await accountScopeReady(supabase))) return {};
  const { phone } = await getConnectedChannel();
  return phone ? { channel_phone: phone } : {};
}

/** For tests / redeploys — forget the cached health + column probes. */
export function resetChannelCaches(): void {
  healthCache = null;
  scopeReady = null;
  isolationReady = null;
}
