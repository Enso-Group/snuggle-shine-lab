// Server-side WhatsApp-admin registry: the list lives in
// bot_settings.agent_config.wa_admins so it needs no migration and is loaded
// with the settings row the webhook already reads on every message.
import type { Supa } from "./types";
import { parseWaAdmins, type WaAdmin } from "./wa-admins";

export async function loadWaAdmins(supabase: Supa): Promise<WaAdmin[]> {
  const { data } = await supabase
    .from("bot_settings")
    .select("agent_config")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return parseWaAdmins((data?.agent_config as { wa_admins?: unknown } | null)?.wa_admins);
}

/**
 * Replace the stored admin list, merging into agent_config without clobbering
 * other knobs (same pattern as setDemoView). Returns the saved list.
 */
export async function saveWaAdmins(supabase: Supa, admins: WaAdmin[]): Promise<WaAdmin[]> {
  const { data, error } = await supabase
    .from("bot_settings")
    .select("id, agent_config")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("bot_settings row not found");
  const config = {
    ...((data.agent_config as Record<string, unknown>) ?? {}),
    wa_admins: admins,
  };
  const { error: upErr } = await supabase
    .from("bot_settings")
    .update({ agent_config: config, updated_at: new Date().toISOString() })
    .eq("id", data.id);
  if (upErr) throw new Error(upErr.message);
  return admins;
}
