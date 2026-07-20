// Decision log — every pipeline stage writes one row to bot_decisions with
// its reasoning. This trail powers the dashboard activity log; it must never
// break the pipeline, so writes are fire-and-forget.
import type { Json } from "@/integrations/supabase/types";
import type { Supa } from "./types";
import type { AgentTrigger } from "./types";

export type DecisionEntry = {
  job_id?: string | null;
  conversation_id?: string | null;
  chat_id?: string | null;
  trigger: AgentTrigger | "scheduled" | "follow_up";
  stage:
    | "received"
    | "skipped"
    | "context"
    | "intent"
    | "draft"
    | "critique"
    | "deliver"
    | "queued_approval"
    | "error";
  status?: "ok" | "skip" | "error";
  summary?: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
};

export function logDecision(supabase: Supa, entry: DecisionEntry): void {
  void (async () => {
    try {
      await supabase.from("bot_decisions").insert({
        job_id: entry.job_id ?? null,
        conversation_id: entry.conversation_id ?? null,
        chat_id: entry.chat_id ?? null,
        trigger: entry.trigger,
        stage: entry.stage,
        status: entry.status ?? "ok",
        summary: entry.summary ?? null,
        data: (entry.data ?? {}) as Json,
        duration_ms: entry.duration_ms ?? null,
      });
    } catch (e) {
      console.error("[decisions] insert failed", e);
    }
  })();
}
