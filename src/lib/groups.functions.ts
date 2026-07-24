// Group Management Profiles — dashboard CRUD. Admin-only.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import type { Json } from "@/integrations/supabase/types";
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
    const { getConnectedChannel, channelScopeReady } = await import("@/lib/agent/channel.server");
    const { channelOrFilter } = await import("@/lib/agent/channel");

    // Disconnected → no groups at all (the live list needs the account anyway).
    const { connected, phone } = await getConnectedChannel();
    if (!connected || !phone) return [];

    let profilesQuery = supabaseAdmin.from("group_profiles").select("*");
    if (await channelScopeReady(supabaseAdmin)) {
      profilesQuery = profilesQuery.or(channelOrFilter(phone));
    }
    const [waGroups, { data: profiles }] = await Promise.all([
      listGroups().catch(() => [] as Array<{ id: string; name: string }>),
      profilesQuery,
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
        .select("id, source, pillar, prompt, body, status, reasoning, sent_at, engagement, created_at")
        .eq("group_chat_id", data.chat_id)
        .order("created_at", { ascending: false })
        // 30, not 10 — the Command Center splits posts into three columns
        // (not sent / in progress / sent) and each needs enough rows to be useful.
        .limit(30),
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

/** Re-queue a failed/cancelled post so the engine regenerates it from scratch. */
export const retryPlannedPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ post_id: z.string().uuid() }).parse(d))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { logDecision } = await import("@/lib/agent/decisions.server");

    const { data: post, error } = await supabaseAdmin
      .from("planned_posts")
      .select("id, group_chat_id, status, engagement, prompt, pillar, source")
      .eq("id", data.post_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!post) throw new Error("Planned post not found");
    // Only terminal posts are retryable: re-planning a planned post would
    // double its attempt budget mid-run, and retrying a sent post would
    // post to the group twice.
    if (post.status !== "failed" && post.status !== "cancelled") {
      throw new Error(`Only failed or cancelled posts can be retried (status is '${post.status}')`);
    }

    // Drop the stored draft, the spent attempt counter, AND the generation
    // lease: the retry must regenerate with a fresh MAX_GEN_ATTEMPTS budget,
    // not resend a stale draft — and a dead worker's leftover lease must not
    // make the freshly-planned row untouchable until it expires.
    const {
      draft: _staleDraft,
      gen_attempts: _spentAttempts,
      gen_lease_until: _staleLease,
      gen_started_at: _staleStart,
      ...engagement
    } = (post.engagement ?? {}) as Record<string, unknown>;

    // created_at/scheduled_for are bumped to NOW: the engine's supersede
    // sweep keeps only the NEWEST planned post per group (by created_at), so
    // a retry that kept its old timestamp would be re-cancelled on the next
    // tick. A manual retry is a fresh statement of intent — it should win.
    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("planned_posts")
      .update({
        status: "planned",
        reasoning: null,
        engagement: engagement as Json,
        created_at: now,
        scheduled_for: now,
        updated_at: now,
      })
      .eq("id", post.id)
      // Re-check the status inside the update itself — a concurrent sweep
      // (or double-click) must not reset a row that already moved on.
      .in("status", ["failed", "cancelled"]);
    if (updateError) throw new Error(updateError.message);

    // The retry itself shows in the Activity trail alongside the failure.
    logDecision(supabaseAdmin, {
      chat_id: post.group_chat_id,
      trigger: "scheduled",
      stage: "config",
      status: "ok",
      summary: `Manager requested a retry of a ${post.status} post`,
      data: { planned_post_id: post.id },
    });
    return { ok: true };
  });
