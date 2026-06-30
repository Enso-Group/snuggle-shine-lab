import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

const listSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(5).max(100).default(25),
  kind: z.enum(["all", "llm", "tool"]).default("all"),
  status: z.enum(["all", "success", "error"]).default("all"),
  model: z.string().optional(),
  tool: z.string().optional(),
  rangeHours: z.number().int().min(1).max(24 * 90).default(24 * 7),
});

export const listAiUsage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.supabase, context.userId);
    const since = new Date(Date.now() - data.rangeHours * 60 * 60 * 1000).toISOString();
    const from = (data.page - 1) * data.pageSize;
    const to = from + data.pageSize - 1;

    let q = context.supabase
      .from("ai_usage_log")
      .select("*", { count: "exact" })
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    if (data.kind !== "all") q = q.eq("kind", data.kind);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.model) q = q.eq("model", data.model);
    if (data.tool) q = q.eq("tool_name", data.tool);

    const { data: rows, count, error } = await q.range(from, to);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [], total: count ?? 0, page: data.page, pageSize: data.pageSize };
  });

export const getAiUsageSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rangeHours: z.number().int().min(1).max(24 * 90).default(24 * 7) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.supabase, context.userId);
    const since = new Date(Date.now() - data.rangeHours * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("ai_usage_log")
      .select("kind, model, tool_name, status, prompt_tokens, completion_tokens, total_tokens, cost_usd, duration_ms, created_at")
      .gte("created_at", since);
    if (error) throw new Error(error.message);

    const all = (rows ?? []) as any[];
    const llm = all.filter((r) => r.kind === "llm");
    const tool = all.filter((r) => r.kind === "tool");
    const errors = all.filter((r) => r.status === "error");

    const byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number }> = {};
    for (const r of llm) {
      const key = r.model ?? "unknown";
      byModel[key] ??= { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
      byModel[key].calls += 1;
      byModel[key].promptTokens += Number(r.prompt_tokens ?? 0);
      byModel[key].completionTokens += Number(r.completion_tokens ?? 0);
      byModel[key].totalTokens += Number(r.total_tokens ?? 0);
      byModel[key].cost += Number(r.cost_usd ?? 0);
    }

    const byTool: Record<string, { calls: number; errors: number }> = {};
    for (const r of tool) {
      const key = r.tool_name ?? "unknown";
      byTool[key] ??= { calls: 0, errors: 0 };
      byTool[key].calls += 1;
      if (r.status === "error") byTool[key].errors += 1;
    }

    // Daily series
    const days: Record<string, { calls: number; cost: number; tokens: number }> = {};
    for (const r of all) {
      const day = String(r.created_at).slice(0, 10);
      days[day] ??= { calls: 0, cost: 0, tokens: 0 };
      days[day].calls += 1;
      days[day].cost += Number(r.cost_usd ?? 0);
      days[day].tokens += Number(r.total_tokens ?? 0);
    }
    const series = Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));

    const totalCost = llm.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    const totalTokens = llm.reduce((s, r) => s + Number(r.total_tokens ?? 0), 0);
    const avgLatency = all.length ? Math.round(all.reduce((s, r) => s + Number(r.duration_ms ?? 0), 0) / all.length) : 0;

    return {
      totals: {
        calls: all.length,
        llmCalls: llm.length,
        toolCalls: tool.length,
        errorCount: errors.length,
        totalTokens,
        totalCostUsd: +totalCost.toFixed(6),
        avgLatencyMs: avgLatency,
      },
      byModel,
      byTool,
      series,
    };
  });

export const getAiUsageFilters = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("ai_usage_log")
      .select("model, tool_name")
      .limit(2000);
    if (error) throw new Error(error.message);
    const models = Array.from(new Set((data ?? []).map((r: any) => r.model).filter(Boolean))) as string[];
    const tools = Array.from(new Set((data ?? []).map((r: any) => r.tool_name).filter(Boolean))) as string[];
    return { models, tools };
  });
