// Shared types for the agentic reply pipeline.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { InboundMessage } from "./inbound";

/** Service-role Supabase client, typed against the project schema. */
export type Supa = SupabaseClient<Database>;

/** bot_settings row shape the pipeline consumes. */
export type AgentSettings = {
  id?: string;
  enabled: boolean;
  system_prompt: string;
  bot_name: string;
  require_approval_all: boolean;
  model_strong?: string | null;
  model_fast?: string | null;
  agent_config?: AgentConfig | null;
};

/** Tunables stored in bot_settings.agent_config (all optional). */
export type AgentConfig = {
  /** Debounce before replying, so message bursts get one considered answer. */
  reply_delay_seconds?: number;
  /** Skip the critique stage (faster/cheaper, lower quality). */
  skip_critique?: boolean;
  /** Max WhatsApp messages a single reply may be split into. */
  max_reply_parts?: number;
  /** React with 👍-style emoji to trivial messages instead of ignoring them. */
  react_to_trivial?: boolean;
  /** Send agent-proposed follow-ups automatically (default true; approval mode still gates them). */
  follow_ups_enabled?: boolean;
};

/** Everything Whapi-shaped the pipeline touches, so simulation can stub it. */
export type WhapiPort = {
  sendText(
    chatId: string,
    body: string,
  ): Promise<{ message?: { id?: string } } | Record<string, unknown>>;
  sendPoll(
    chatId: string,
    title: string,
    options: string[],
    count: number,
  ): Promise<{ message?: { id?: string } } | Record<string, unknown>>;
  markRead(messageId: string): Promise<void>;
  react(messageId: string, emoji: string): Promise<void>;
  presence(chatId: string, presence: "typing" | "paused", delaySec: number): Promise<void>;
};

export type AgentTrigger = "inbound" | "simulation";

export type AgentDeps = {
  supabase: Supa;
  whapi: WhapiPort;
  trigger: AgentTrigger;
  workerId: string;
  /** Real sends pace like a human (typing, pauses); simulation skips waits. */
  humanPacing: boolean;
};

export type InboundJobPayload = {
  message_db_id?: string;
  whapi_message_id: string;
  body: string;
  sender_id: string;
  sender_name: string;
  chat_name: string;
  is_group: boolean;
  ts: number;
  /** Epoch ms when the webhook delivered the message to us. */
  received_at?: number;
  /** Epoch ms when the reply should land (DMs only) — chosen at receipt. */
  target_reply_at?: number;
};

export type BotJob = {
  id: string;
  kind: string;
  chat_id: string;
  conversation_id: string | null;
  payload: InboundJobPayload;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_until: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentContext = {
  settings: AgentSettings;
  conversation: {
    id: string;
    whapi_chat_id: string;
    name: string | null;
    is_group: boolean;
    inbound_count: number;
    consecutive_outbound: number;
    blocked: boolean;
    last_outbound_at: string | null;
    last_outbound_body: string | null;
  };
  history: Array<{ role: "user" | "assistant"; content: string; senderName?: string }>;
  message: InboundMessage;
  /** Persistent memory of the sender (loaded when the people table exists). */
  person?: import("./people.server").PersonRow | null;
  /** Ranked knowledge-base context for this message. */
  kb?: { block: string; count: number };
  /** Management profile when the message is in a managed group. */
  groupProfile?: import("./groups.server").GroupProfile | null;
  /** Ms since the previous message in this conversation (null = first message). */
  gapSinceLastMs?: number | null;
  /**
   * Set by the pipeline when the model judged this DM a new topic after a
   * gap — the draft/critique stages then start clean instead of dragging in
   * the earlier thread.
   */
  freshStart?: { gap: string; reason: string } | null;
};

export type IntentAnalysis = {
  intent: string;
  language: string;
  urgency: "low" | "normal" | "high";
  sentiment: string;
  goal: string;
  escalate: boolean;
  escalate_reason: string | null;
  /**
   * After a significant gap in a DM: does this message continue the earlier
   * thread ("continuation") or open a new topic ("fresh")? Judged by the
   * model from content + gap together; defaults to "continuation".
   */
  context_relation: "continuation" | "fresh";
  context_reason: string | null;
};

export type DraftResult = {
  messages: string[];
  reasoning: string;
};

export type CritiqueResult = {
  verdict: "approve" | "revise";
  issues: string[];
  messages: string[];
  reasoning: string;
};

export type PipelineOutcome =
  | { action: "replied"; parts: string[] }
  | { action: "queued_approval"; draft: string }
  | { action: "skipped"; reason: string }
  | { action: "failed"; error: string };
