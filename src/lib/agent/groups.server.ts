// Group Management Profiles — how a human teaches the bot to run a group.
// Loaders degrade gracefully (missing table → null → pre-Phase-3 behavior).
import type { Supa } from "./types";

export type PostingSlot = {
  /** 0 (Sunday) – 6, or null for every day. */
  day: number | null;
  /** "HH:MM" in Israel time. */
  time: string;
  pillar?: string;
  prompt?: string;
};

export type GroupModerationConfig = {
  enabled?: boolean;
  delete_violations?: boolean;
  /** Violations before the member is warned in the group. */
  warn_limit?: number;
  /** Violations before the member is removed (requires bot admin). */
  remove_limit?: number;
};

export type GroupProfile = {
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
  posting_schedule: PostingSlot[];
  rules: string[];
  forbidden_topics: string[];
  moderation: GroupModerationConfig;
  welcome: { enabled?: boolean; hint?: string };
  reply_when_mentioned: boolean;
  reply_to_questions: boolean;
  allow_reactive_posts: boolean;
  escalation_rules: string | null;
  kpis: string | null;
  owner_dm: string | null;
};

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

function rowToProfile(data: Record<string, unknown>): GroupProfile {
  return {
    id: String(data.id),
    chat_id: String(data.chat_id),
    name: (data.name as string) ?? null,
    enabled: data.enabled === true,
    instructions: (data.instructions as string) ?? null,
    purpose: (data.purpose as string) ?? null,
    audience: (data.audience as string) ?? null,
    tone: (data.tone as string) ?? null,
    language: String(data.language ?? "he"),
    content_pillars: toStringArray(data.content_pillars),
    posting_schedule: Array.isArray(data.posting_schedule)
      ? (data.posting_schedule as PostingSlot[]).filter((s) => s && typeof s.time === "string")
      : [],
    rules: toStringArray(data.rules),
    forbidden_topics: toStringArray(data.forbidden_topics),
    moderation: (data.moderation ?? {}) as GroupModerationConfig,
    welcome: (data.welcome ?? {}) as { enabled?: boolean; hint?: string },
    reply_when_mentioned: data.reply_when_mentioned !== false,
    reply_to_questions: data.reply_to_questions === true,
    allow_reactive_posts: data.allow_reactive_posts === true,
    escalation_rules: (data.escalation_rules as string) ?? null,
    kpis: (data.kpis as string) ?? null,
    owner_dm: (data.owner_dm as string) ?? null,
  };
}

export async function loadGroupProfile(
  supabase: Supa,
  chatId: string,
): Promise<GroupProfile | null> {
  if (!chatId.endsWith("@g.us")) return null;
  try {
    const { data, error } = await supabase
      .from("group_profiles")
      .select("*")
      .eq("chat_id", chatId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.warn("[groups] profile load failed:", error.message);
      return null;
    }
    return rowToProfile(data as Record<string, unknown>);
  } catch (e) {
    console.warn("[groups] profile load failed:", e);
    return null;
  }
}

export async function listEnabledGroupProfiles(supabase: Supa): Promise<GroupProfile[]> {
  try {
    const { data, error } = await supabase.from("group_profiles").select("*").eq("enabled", true);
    if (error) {
      console.warn("[groups] list failed:", error.message);
      return [];
    }
    return (data ?? []).map((d) => rowToProfile(d as Record<string, unknown>));
  } catch {
    return [];
  }
}

/** The group's "who we are and how we behave here" block for drafting prompts. */
export function groupPromptBlock(profile: GroupProfile | null | undefined): string {
  if (!profile) return "";
  const lines: string[] = [
    `

הקבוצה שבה אתה פועל — "${profile.name ?? profile.chat_id}" (הנחיות ניהול פנימיות):`,
  ];
  if (profile.purpose) lines.push(`- מטרת הקבוצה: ${profile.purpose}`);
  if (profile.audience) lines.push(`- קהל היעד: ${profile.audience}`);
  if (profile.tone) lines.push(`- טון: ${profile.tone}`);
  if (profile.rules.length) lines.push(`- חוקי הקבוצה: ${profile.rules.join(" | ")}`);
  if (profile.forbidden_topics.length)
    lines.push(
      `- נושאים אסורים (אל תעסוק בהם ואל תעודד אותם): ${profile.forbidden_topics.join(", ")}`,
    );
  if (profile.instructions) lines.push(`- הנחיות מהמנהל: ${profile.instructions}`);
  return lines.join("\n");
}
