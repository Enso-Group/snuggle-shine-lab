import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getUsageStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const s = context.supabase;

    const [
      convsTotal,
      convsBlocked,
      msgsTotal,
      msgsInDay,
      msgsOutDay,
      msgsInWeek,
      msgsOutWeek,
      msgsInMonth,
      msgsOutMonth,
      cmdsMonth,
      scheduled,
      pending,
      distinctOutHour,
      lastInbound,
      lastOutbound,
    ] = await Promise.all([
      s.from("conversations").select("id", { count: "exact", head: true }),
      s.from("conversations").select("id", { count: "exact", head: true }).eq("blocked", true),
      s.from("messages").select("id", { count: "exact", head: true }),
      s.from("messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", dayAgo),
      s.from("messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("created_at", dayAgo),
      s.from("messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", weekAgo),
      s.from("messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("created_at", weekAgo),
      s.from("messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", monthAgo),
      s.from("messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("created_at", monthAgo),
      s.from("commands_log").select("id", { count: "exact", head: true }).gte("created_at", monthAgo),
      s.from("scheduled_messages").select("id, enabled"),
      s.from("scheduled_approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
      s.from("messages").select("conversation_id").eq("direction", "outbound").gte("created_at", hourAgo),
      s.from("messages").select("created_at").eq("direction", "inbound").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      s.from("messages").select("created_at").eq("direction", "outbound").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const distinctChatsHour = new Set((distinctOutHour.data ?? []).map((r: any) => r.conversation_id)).size;
    const schedRows = scheduled.data ?? [];

    return {
      conversations: {
        total: convsTotal.count ?? 0,
        blocked: convsBlocked.count ?? 0,
      },
      messages: {
        total: msgsTotal.count ?? 0,
        inbound24h: msgsInDay.count ?? 0,
        outbound24h: msgsOutDay.count ?? 0,
        inbound7d: msgsInWeek.count ?? 0,
        outbound7d: msgsOutWeek.count ?? 0,
        inbound30d: msgsInMonth.count ?? 0,
        outbound30d: msgsOutMonth.count ?? 0,
        lastInboundAt: lastInbound.data?.created_at ?? null,
        lastOutboundAt: lastOutbound.data?.created_at ?? null,
      },
      commands30d: cmdsMonth.count ?? 0,
      scheduled: {
        total: schedRows.length,
        enabled: schedRows.filter((r: any) => r.enabled).length,
      },
      pendingApprovals: pending.count ?? 0,
      antiBan: {
        distinctChatsLastHour: distinctChatsHour,
        maxDistinctChatsPerHour: 10,
        maxConsecutiveOutbound: 3,
        minGapMinutes: 3,
      },
    };
  });
