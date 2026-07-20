// Context gathering — everything the agent knows before it starts thinking.
import type { Supa } from "./types";
import type { InboundMessage } from "./inbound";
import type { AgentContext, AgentSettings } from "./types";

const HISTORY_LIMIT = 40;

export async function loadAgentSettings(supabase: Supa): Promise<AgentSettings | null> {
  const { data } = await supabase
    .from("bot_settings")
    .select(
      "id, system_prompt, bot_name, enabled, require_approval_all, model_strong, model_fast, agent_config",
    )
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    enabled: data.enabled !== false,
    system_prompt: data.system_prompt ?? "אתה עוזר חכם בעברית.",
    bot_name: data.bot_name ?? "",
    require_approval_all: !!data.require_approval_all,
    model_strong: data.model_strong ?? null,
    model_fast: data.model_fast ?? null,
    agent_config: (data.agent_config ?? {}) as AgentSettings["agent_config"],
  };
}

export async function gatherContext(
  supabase: Supa,
  settings: AgentSettings,
  conversationId: string,
  message: InboundMessage,
): Promise<AgentContext | null> {
  const { data: conv } = await supabase
    .from("conversations")
    .select(
      "id, whapi_chat_id, name, is_group, inbound_count, consecutive_outbound, blocked, last_outbound_at, last_outbound_body",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return null;

  const { data: hist } = await supabase
    .from("messages")
    .select("direction, body, sender_name, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const history = (hist ?? [])
    .reverse()
    .filter((h) => h.body)
    .map((h) => ({
      role: (h.direction === "outbound" ? "assistant" : "user") as "user" | "assistant",
      content: h.body as string,
      senderName: h.sender_name ?? undefined,
    }));
  // The triggering message is passed separately — don't repeat it as history.
  if (
    history.length &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].content === message.body
  ) {
    history.pop();
  }

  return { settings, conversation: conv, history, message };
}
