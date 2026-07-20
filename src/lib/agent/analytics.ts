// Pure analytics math — no I/O, unit-tested.

export type DayStat = {
  date: string; // YYYY-MM-DD
  messages: number;
  active_members: number;
  bot_posts: number;
  post_replies: number;
};

/** YYYY-MM-DD for an instant, in Israel time. */
export function israelDateKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The Sunday (Israel time) that starts the week containing `d`, as YYYY-MM-DD. */
export function israelWeekStart(d: Date): string {
  const dowName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
  }).format(d);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dayMap[dowName] ?? 0;
  const sunday = new Date(d.getTime() - dow * 24 * 3600_000);
  return israelDateKey(sunday);
}

export type MessageRowLite = {
  direction: string;
  sender_id: string | null;
  created_at: string;
};

/**
 * Aggregate raw message rows into per-day stats (Israel time). Bot messages
 * count as bot_posts; inbound messages count toward volume and active members.
 */
export function aggregateDailyStats(rows: MessageRowLite[]): DayStat[] {
  const byDay = new Map<string, { messages: number; senders: Set<string>; bot: number }>();
  for (const r of rows) {
    const day = israelDateKey(new Date(r.created_at));
    let entry = byDay.get(day);
    if (!entry) {
      entry = { messages: 0, senders: new Set(), bot: 0 };
      byDay.set(day, entry);
    }
    if (r.direction === "inbound") {
      entry.messages += 1;
      if (r.sender_id) entry.senders.add(r.sender_id);
    } else {
      entry.bot += 1;
    }
  }
  return [...byDay.entries()]
    .map(([date, e]) => ({
      date,
      messages: e.messages,
      active_members: e.senders.size,
      bot_posts: e.bot,
      post_replies: 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type StrategyRecommendations = {
  best_times: string[];
  pillar_ranking: string[];
  notes: string;
};

/** Defensive parse of the memo model's recommendations JSON. */
export function parseRecommendations(v: unknown): StrategyRecommendations {
  const obj = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    best_times: Array.isArray(obj.best_times)
      ? obj.best_times.map((t) => String(t)).slice(0, 7)
      : [],
    pillar_ranking: Array.isArray(obj.pillar_ranking)
      ? obj.pillar_ranking.map((p) => String(p)).slice(0, 10)
      : [],
    notes: String(obj.notes ?? "").slice(0, 1000),
  };
}

/** Compact prompt block from the latest memo, consumed by the posting engine. */
export function recommendationsPromptBlock(rec: StrategyRecommendations | null): string {
  if (!rec) return "";
  const lines: string[] = [];
  if (rec.pillar_ranking.length)
    lines.push(`- סוגי התוכן שעובדים הכי טוב (מהטוב לפחות): ${rec.pillar_ranking.join(" > ")}`);
  if (rec.best_times.length) lines.push(`- שעות שיא לתגובות: ${rec.best_times.join(", ")}`);
  if (rec.notes) lines.push(`- הערות אסטרטגיה: ${rec.notes}`);
  if (!lines.length) return "";
  return `

לקחים מהמזכר האסטרטגי האחרון (יישם אותם בפוסט):
${lines.join("\n")}`;
}
