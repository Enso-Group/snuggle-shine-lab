// Fire-and-forget logger for AI Gateway + tool calls.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type LogEntry = {
  kind: "llm" | "tool";
  provider?: string | null;
  model?: string | null;
  tool_name?: string | null;
  source?: string | null;
  status?: "success" | "error";
  http_status?: number | null;
  error_message?: string | null;
  duration_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cost_usd?: number | null;
  meta?: Record<string, unknown> | null;
};

export function logUsage(entry: LogEntry): void {
  // Don't await — never block the caller's response on logging.
  (async () => {
    try {
      await supabaseAdmin.from("ai_usage_log").insert({
        kind: entry.kind,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        tool_name: entry.tool_name ?? null,
        source: entry.source ?? null,
        status: entry.status ?? "success",
        http_status: entry.http_status ?? null,
        error_message: entry.error_message ?? null,
        duration_ms: entry.duration_ms ?? null,
        prompt_tokens: entry.prompt_tokens ?? null,
        completion_tokens: entry.completion_tokens ?? null,
        total_tokens: entry.total_tokens ?? null,
        cost_usd: entry.cost_usd ?? null,
        meta: (entry.meta ?? null) as any,
      });
    } catch (e) {
      console.error("[usage-log] insert failed", e);
    }
  })();
}
