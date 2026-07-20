// Bot Brain console — server side. Admin-only:
//  * the live decision feed (bot_decisions) with conversation names attached,
//  * global agent configuration (models + behavior knobs on bot_settings).
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import type { Json } from "@/integrations/supabase/types";
import { z } from "zod";

export type DecisionRow = {
  id: string;
  job_id: string | null;
  chat_id: string | null;
  chat_name: string | null;
  trigger: string;
  stage: string;
  status: string;
  summary: string | null;
  data: Json;
  duration_ms: number | null;
  created_at: string;
};

const STAGE_GROUPS: Record<string, string[]> = {
  replies: [
    "received",
    "reply_gate",
    "context",
    "intent",
    "draft",
    "critique",
    "deliver",
    "queued_approval",
    "skipped",
  ],
  memory: ["memory", "follow_up"],
  groups: ["moderation", "welcome", "post", "insight"],
  errors: ["error"],
};

export const listDecisions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        group: z.enum(["all", "replies", "memory", "groups", "errors"]).default("all"),
        limit: z.number().int().min(10).max(200).default(60),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }): Promise<DecisionRow[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("bot_decisions")
      .select("id, job_id, chat_id, trigger, stage, status, summary, data, duration_ms, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.group !== "all") query = query.in("stage", STAGE_GROUPS[data.group]);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    // Attach conversation names for the chats present in this page.
    const chatIds = [...new Set((rows ?? []).map((r) => r.chat_id).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (chatIds.length) {
      const { data: convs } = await supabaseAdmin
        .from("conversations")
        .select("whapi_chat_id, name")
        .in("whapi_chat_id", chatIds);
      for (const c of convs ?? []) if (c.name) names.set(c.whapi_chat_id, c.name);
    }
    return (rows ?? []).map((r) => ({
      ...r,
      chat_name: r.chat_id ? (names.get(r.chat_id) ?? null) : null,
    }));
  });

export type AgentConfigView = {
  settings_id: string;
  model_strong: string | null;
  model_fast: string | null;
  reply_delay_seconds: number;
  max_reply_parts: number;
  critique_enabled: boolean;
  react_to_trivial: boolean;
  follow_ups_enabled: boolean;
};

export const getAgentConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<AgentConfigView> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("bot_settings")
      .select("id, model_strong, model_fast, agent_config")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();
    if (error) throw new Error(error.message);
    const cfg = (data.agent_config ?? {}) as {
      reply_delay_seconds?: number;
      max_reply_parts?: number;
      skip_critique?: boolean;
      react_to_trivial?: boolean;
      follow_ups_enabled?: boolean;
    };
    return {
      settings_id: data.id,
      model_strong: data.model_strong,
      model_fast: data.model_fast,
      reply_delay_seconds: cfg.reply_delay_seconds ?? 4,
      max_reply_parts: cfg.max_reply_parts ?? 3,
      critique_enabled: !cfg.skip_critique,
      react_to_trivial: cfg.react_to_trivial ?? true,
      follow_ups_enabled: cfg.follow_ups_enabled ?? true,
    };
  });

export const saveAgentConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        settings_id: z.string().uuid(),
        model_strong: z.string().max(80).nullable(),
        model_fast: z.string().max(80).nullable(),
        reply_delay_seconds: z.number().int().min(0).max(30),
        max_reply_parts: z.number().int().min(1).max(5),
        critique_enabled: z.boolean(),
        react_to_trivial: z.boolean(),
        follow_ups_enabled: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("bot_settings")
      .update({
        model_strong: data.model_strong?.trim() || null,
        model_fast: data.model_fast?.trim() || null,
        agent_config: {
          reply_delay_seconds: data.reply_delay_seconds,
          max_reply_parts: data.max_reply_parts,
          skip_critique: !data.critique_enabled,
          react_to_trivial: data.react_to_trivial,
          follow_ups_enabled: data.follow_ups_enabled,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.settings_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
