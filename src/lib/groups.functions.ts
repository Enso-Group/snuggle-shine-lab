// Group Management Profiles — dashboard CRUD. Admin-only.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";

export type GroupProfileRow = {
  id: string;
  chat_id: string;
  name: string | null;
  enabled: boolean;
  instructions: string | null;
  purpose: string | null;
  audience: string | null;
  tone: string | null;
  language: string;
  content_pillars: string[];
  posting_schedule: Array<{ day: number | null; time: string; pillar?: string; prompt?: string }>;
  rules: string[];
  forbidden_topics: string[];
  moderation: {
    enabled?: boolean;
    delete_violations?: boolean;
    warn_limit?: number;
    remove_limit?: number;
  };
  welcome: { enabled?: boolean; hint?: string };
  reply_when_mentioned: boolean;
  reply_to_questions: boolean;
  allow_reactive_posts: boolean;
  escalation_rules: string | null;
  kpis: string | null;
  owner_dm: string | null;
  updated_at: string;
};

export type ManagedGroup = {
  chat_id: string;
  whatsapp_name: string;
  profile: GroupProfileRow | null;
};

/** All WhatsApp groups the account is in, merged with their profiles. */
export const listManagedGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<ManagedGroup[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listGroups } = await import("@/lib/whapi.server");

    const [waGroups, { data: profiles }] = await Promise.all([
      listGroups().catch(() => [] as Array<{ id: string; name: string }>),
      supabaseAdmin.from("group_profiles").select("*"),
    ]);
    const profileByChat = new Map(
      ((profiles ?? []) as unknown as GroupProfileRow[]).map((p) => [p.chat_id, p]),
    );

    const out: ManagedGroup[] = waGroups.map((g) => ({
      chat_id: g.id,
      whatsapp_name: g.name,
      profile: profileByChat.get(g.id) ?? null,
    }));
    // Profiles for groups the account can no longer list still show up.
    for (const p of profileByChat.values()) {
      if (!out.some((g) => g.chat_id === p.chat_id)) {
        out.push({ chat_id: p.chat_id, whatsapp_name: p.name ?? p.chat_id, profile: p });
      }
    }
    return out.sort((a, b) => Number(!!b.profile?.enabled) - Number(!!a.profile?.enabled));
  });

const slotSchema = z.object({
  day: z.number().int().min(0).max(6).nullable(),
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
  pillar: z.string().max(120).optional(),
  prompt: z.string().max(1000).optional(),
});

export const saveGroupProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        chat_id: z.string().min(5).endsWith("@g.us"),
        name: z.string().max(200).optional(),
        enabled: z.boolean(),
        instructions: z.string().max(8000).optional(),
        purpose: z.string().max(1000).optional(),
        audience: z.string().max(1000).optional(),
        tone: z.string().max(500).optional(),
        language: z.string().min(2).max(8).default("he"),
        content_pillars: z.array(z.string().max(120)).max(20).default([]),
        posting_schedule: z.array(slotSchema).max(30).default([]),
        rules: z.array(z.string().max(300)).max(30).default([]),
        forbidden_topics: z.array(z.string().max(120)).max(30).default([]),
        moderation: z
          .object({
            enabled: z.boolean().optional(),
            delete_violations: z.boolean().optional(),
            warn_limit: z.number().int().min(1).max(10).optional(),
            remove_limit: z.number().int().min(1).max(20).optional(),
          })
          .default({}),
        welcome: z
          .object({ enabled: z.boolean().optional(), hint: z.string().max(500).optional() })
          .default({}),
        reply_when_mentioned: z.boolean().default(true),
        reply_to_questions: z.boolean().default(false),
        allow_reactive_posts: z.boolean().default(false),
        escalation_rules: z.string().max(2000).optional(),
        kpis: z.string().max(1000).optional(),
        owner_dm: z.string().max(40).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<GroupProfileRow> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch = {
      chat_id: data.chat_id,
      name: data.name?.trim() || null,
      enabled: data.enabled,
      instructions: data.instructions?.trim() || null,
      purpose: data.purpose?.trim() || null,
      audience: data.audience?.trim() || null,
      tone: data.tone?.trim() || null,
      language: data.language,
      content_pillars: data.content_pillars,
      posting_schedule: data.posting_schedule,
      rules: data.rules,
      forbidden_topics: data.forbidden_topics,
      moderation: data.moderation,
      welcome: data.welcome,
      reply_when_mentioned: data.reply_when_mentioned,
      reply_to_questions: data.reply_to_questions,
      allow_reactive_posts: data.allow_reactive_posts,
      escalation_rules: data.escalation_rules?.trim() || null,
      kpis: data.kpis?.trim() || null,
      owner_dm: data.owner_dm?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { data: row, error } = await supabaseAdmin
      .from("group_profiles")
      .upsert(patch, { onConflict: "chat_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as GroupProfileRow;
  });

/** Recent autonomous activity for one group — posts, moderation, insights. */
export const getGroupActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ chat_id: z.string().min(5) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [posts, actions, insights, stats, memo] = await Promise.all([
      supabaseAdmin
        .from("planned_posts")
        .select("id, source, pillar, body, status, sent_at, engagement, created_at")
        .eq("group_chat_id", data.chat_id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("moderation_actions")
        .select("id, action, target_name, rule_violated, reasoning, status, created_at")
        .eq("group_chat_id", data.chat_id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("group_insights")
        .select("id, kind, content, created_at")
        .eq("group_chat_id", data.chat_id)
        .order("created_at", { ascending: false })
        .limit(6),
      supabaseAdmin
        .from("group_daily_stats")
        .select(
          "date, messages, active_members, bot_posts, post_replies, new_members, left_members",
        )
        .eq("group_chat_id", data.chat_id)
        .order("date", { ascending: false })
        .limit(7),
      supabaseAdmin
        .from("strategy_memos")
        .select("week_start, memo, recommendations, created_at")
        .eq("group_chat_id", data.chat_id)
        .order("week_start", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      posts: posts.data ?? [],
      actions: actions.data ?? [],
      insights: insights.data ?? [],
      stats: (stats.data ?? []).slice().reverse(),
      memo: memo.data ?? null,
    };
  });
