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
  /** Master reply switch; null/absent = legacy default (replies allowed). */
  reply_enabled?: boolean | null;
  /** Per-group approval override; null/absent = follow the global setting. */
  require_approval?: boolean | null;
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
    const { getChannelScope } = await import("@/lib/agent/channel.server");

    // Presentation mode: while demo data is seeded, the list shows ONLY the
    // demo group — no real group name may appear in a recording.
    const { isDemoViewOn } = await import("./demo-seed");
    if (await isDemoViewOn(supabaseAdmin as never)) {
      const { data: demoProfiles } = await supabaseAdmin
        .from("group_profiles")
        .select("*")
        .like("chat_id", "demo-%");
      return ((demoProfiles ?? []) as unknown as GroupProfileRow[]).map((p) => ({
        chat_id: p.chat_id,
        whatsapp_name: p.name ?? p.chat_id,
        profile: p,
      }));
    }

    // Disconnected → no groups at all (the live list needs the account anyway).
    const scope = await getChannelScope(supabaseAdmin);
    if (scope.mode === "disconnected") return [];

    // STRICT equality — a profile stamped for another number (or not yet
    // stamped) is not this account's data. The sweeper adopts legacy NULLs
    // within a minute, and inbound events re-stamp live groups.
    let profilesQuery = supabaseAdmin.from("group_profiles").select("*");
    if (scope.mode === "scoped") {
      profilesQuery = profilesQuery.eq("channel_phone", scope.phone);
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
    // Rank: autonomous groups first, then any group with a taught profile
    // (incl. DB-only rows like demo/archived groups — otherwise they sink
    // below every bare WhatsApp group), then the rest.
    const rank = (g: ManagedGroup) => (g.profile?.enabled ? 2 : g.profile ? 1 : 0);
    return out.sort((a, b) => rank(b) - rank(a));
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
        /** Master reply switch; omitted = leave as-is. */
        reply_enabled: z.boolean().optional(),
        /** Per-group approval override; omitted = leave as-is. */
        require_approval: z.boolean().optional(),
        escalation_rules: z.string().max(2000).optional(),
        kpis: z.string().max(1000).optional(),
        owner_dm: z.string().max(40).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<GroupProfileRow> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { channelStamp } = await import("@/lib/agent/channel.server");
    const patch = {
      ...(await channelStamp(supabaseAdmin)),
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
    // Late-migration columns — separate FENCED writes (a missing column must
    // not fail the whole save; it throws an instructive message instead).
    await writeFencedColumn(
      supabaseAdmin,
      data.chat_id,
      "require_approval",
      data.require_approval,
      {
        migration: "20260727090000_group_require_approval.sql",
        row: row as unknown as Record<string, unknown>,
      },
    );
    await writeFencedColumn(supabaseAdmin, data.chat_id, "reply_enabled", data.reply_enabled, {
      migration: "20260728120000_group_reply_enabled.sql",
      row: row as unknown as Record<string, unknown>,
    });
    return row as unknown as GroupProfileRow;
  });

/**
 * Write one late-migration boolean column, translating a missing-column error
 * into an instruction naming the exact migration to apply. Mirrors the saved
 * value onto `row` so callers return the up-to-date shape.
 */
async function writeFencedColumn(
  supabaseAdmin: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
  chatId: string,
  column: "require_approval" | "reply_enabled",
  value: boolean | undefined,
  opts: { migration: string; row: Record<string, unknown> },
): Promise<void> {
  if (typeof value !== "boolean") return;
  const { error } = await supabaseAdmin
    .from("group_profiles")
    .update({ [column]: value } as never)
    .eq("chat_id", chatId);
  if (error) {
    if (new RegExp(column).test(error.message) && /column/i.test(error.message)) {
      throw new Error(
        `The "${column}" toggle needs a migration — apply supabase/migrations/${opts.migration} in Lovable first.`,
      );
    }
    throw new Error(error.message);
  }
  opts.row[column] = value;
}

/**
 * Instant persistence for the editor's toggle switches: saves ONLY the flags
 * provided, immediately, without touching the rest of the profile (so a
 * toggle flip can never be lost by navigating away before "Save", and never
 * clobbers half-edited text fields). Creates the profile row if the group
 * was never taught.
 */
export const setGroupProfileFlags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        chat_id: z.string().min(5).endsWith("@g.us"),
        name: z.string().max(200).optional(),
        enabled: z.boolean().optional(),
        reply_when_mentioned: z.boolean().optional(),
        reply_to_questions: z.boolean().optional(),
        allow_reactive_posts: z.boolean().optional(),
        reply_enabled: z.boolean().optional(),
        require_approval: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<GroupProfileRow> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { channelStamp } = await import("@/lib/agent/channel.server");
    const plain: Record<string, unknown> = {
      ...(await channelStamp(supabaseAdmin)),
      chat_id: data.chat_id,
      updated_at: new Date().toISOString(),
    };
    if (data.name?.trim()) plain.name = data.name.trim();
    for (const key of [
      "enabled",
      "reply_when_mentioned",
      "reply_to_questions",
      "allow_reactive_posts",
    ] as const) {
      if (typeof data[key] === "boolean") plain[key] = data[key];
    }
    const { data: row, error } = await supabaseAdmin
      .from("group_profiles")
      .upsert(plain as never, { onConflict: "chat_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await writeFencedColumn(
      supabaseAdmin,
      data.chat_id,
      "require_approval",
      data.require_approval,
      {
        migration: "20260727090000_group_require_approval.sql",
        row: row as unknown as Record<string, unknown>,
      },
    );
    await writeFencedColumn(supabaseAdmin, data.chat_id, "reply_enabled", data.reply_enabled, {
      migration: "20260728120000_group_reply_enabled.sql",
      row: row as unknown as Record<string, unknown>,
    });
    // The change trail: which flag was flipped, by the dashboard, to what.
    const { logDecision } = await import("@/lib/agent/decisions.server");
    logDecision(supabaseAdmin, {
      chat_id: data.chat_id,
      trigger: "scheduled",
      stage: "config",
      status: "ok",
      summary: `Group toggle saved from the dashboard: ${Object.entries(data)
        .filter(([k, v]) => k !== "chat_id" && k !== "name" && typeof v === "boolean")
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
      data: { chat_id: data.chat_id },
    });
    return row as unknown as GroupProfileRow;
  });

/** Recent autonomous activity for one group — posts, moderation, insights. */
export const getGroupActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ chat_id: z.string().min(5) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getChannelScope } = await import("@/lib/agent/channel.server");
    // Account isolation: no connection → no activity at all; connected → only
    // rows stamped for THIS account (demo groups excepted — they are fixtures
    // with no account).
    const scope = await getChannelScope(supabaseAdmin);
    const isDemoChat = data.chat_id.startsWith("demo-");
    if (scope.mode === "disconnected" && !isDemoChat) {
      return { posts: [], actions: [], insights: [], stats: [], memo: null };
    }
    const scopePhone = scope.mode === "scoped" && !isDemoChat ? scope.phone : null;
    // media is fetched tolerantly: the column arrives with the 20260726
    // migration, and the page must keep working before it is applied. The
    // typed client can't know about the not-yet-migrated column, so the
    // result is cast back to the base row shape (+ optional media).
    type Jsonish = string | number | boolean | null | { [k: string]: Jsonish } | Jsonish[];
    type PostRow = {
      id: string;
      source: string;
      pillar: string | null;
      prompt: string | null;
      body: string | null;
      status: string;
      reasoning: string | null;
      sent_at: string | null;
      engagement: Jsonish;
      media?: Jsonish;
      created_at: string;
    };
    type PostsResult = { data: PostRow[] | null; error: { message: string } | null };
    const fetchPosts = async (): Promise<PostsResult> => {
      let q1 = supabaseAdmin
        .from("planned_posts")
        .select(
          "id, source, pillar, prompt, body, status, reasoning, sent_at, engagement, media, created_at",
        )
        .eq("group_chat_id", data.chat_id);
      if (scopePhone) q1 = q1.eq("channel_phone", scopePhone);
      const withMedia = (await q1
        .order("created_at", { ascending: false })
        // 30, not 10 — the Command Center splits posts into three columns
        // (not sent / in progress / sent) and each needs enough rows to be useful.
        .limit(30)) as unknown as PostsResult;
      if (!withMedia.error) return withMedia;
      let q2 = supabaseAdmin
        .from("planned_posts")
        .select(
          "id, source, pillar, prompt, body, status, reasoning, sent_at, engagement, created_at",
        )
        .eq("group_chat_id", data.chat_id);
      if (scopePhone) q2 = q2.eq("channel_phone", scopePhone);
      return (await q2
        .order("created_at", { ascending: false })
        .limit(30)) as unknown as PostsResult;
    };
    const fetchActions = () => {
      let q = supabaseAdmin
        .from("moderation_actions")
        .select("id, action, target_name, rule_violated, reasoning, status, created_at")
        .eq("group_chat_id", data.chat_id);
      if (scopePhone) q = q.eq("channel_phone", scopePhone);
      return q.order("created_at", { ascending: false }).limit(10);
    };
    const fetchInsights = () => {
      let q = supabaseAdmin
        .from("group_insights")
        .select("id, kind, content, created_at")
        .eq("group_chat_id", data.chat_id);
      if (scopePhone) q = q.eq("channel_phone", scopePhone);
      return q.order("created_at", { ascending: false }).limit(6);
    };
    const fetchStats = () => {
      let q = supabaseAdmin
        .from("group_daily_stats")
        .select(
          "date, messages, active_members, bot_posts, post_replies, new_members, left_members",
        )
        .eq("group_chat_id", data.chat_id);
      if (scopePhone) q = q.eq("channel_phone", scopePhone);
      return q.order("date", { ascending: false }).limit(7);
    };
    const fetchMemo = () => {
      let q = supabaseAdmin
        .from("strategy_memos")
        .select("week_start, memo, recommendations, created_at")
        .eq("group_chat_id", data.chat_id);
      if (scopePhone) q = q.eq("channel_phone", scopePhone);
      return q.order("week_start", { ascending: false }).limit(1).maybeSingle();
    };
    const [posts, actions, insights, stats, memo] = await Promise.all([
      fetchPosts(),
      fetchActions(),
      fetchInsights(),
      fetchStats(),
      fetchMemo(),
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
    // Account isolation: never operate on another account's post. Checked via
    // a separate scoped existence probe so this keeps working before the
    // isolation migration lands (getChannelScope reports "unscoped" then).
    const { getChannelScope } = await import("@/lib/agent/channel.server");
    const scope = await getChannelScope(supabaseAdmin);
    if (scope.mode === "scoped") {
      const { data: mine } = await supabaseAdmin
        .from("planned_posts")
        .select("id")
        .eq("id", data.post_id)
        .or(`channel_phone.is.null,channel_phone.eq.${scope.phone}`)
        .maybeSingle();
      if (!mine) throw new Error("This post belongs to a different WhatsApp account");
    }
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
