// Shared pipeline-stage badge — used by the Activity feed and anywhere else
// bot_decisions rows are rendered.
import { Badge } from "@/components/ui/badge";

export const STAGE_LABELS: Record<string, { label: string; cls: string }> = {
  received: { label: "Received", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  reply_gate: { label: "Reply gate", cls: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400" },
  context: { label: "Context", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  intent: { label: "Intent", cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
  draft: { label: "Draft", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  critique: { label: "Critique", cls: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400" },
  deliver: { label: "Sent", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  queued_approval: {
    label: "Awaiting approval",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  memory: { label: "Memory", cls: "bg-teal-500/15 text-teal-600 dark:text-teal-400" },
  follow_up: { label: "Follow-up", cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  moderation: { label: "Moderation", cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  welcome: { label: "Welcome", cls: "bg-lime-500/15 text-lime-600 dark:text-lime-400" },
  post: { label: "Post", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  insight: { label: "Insight", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  config: { label: "Config", cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  skipped: { label: "Skipped", cls: "bg-muted text-muted-foreground" },
  error: { label: "Error", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
};

export function StageBadge({ stage }: { stage: string }) {
  const s = STAGE_LABELS[stage] ?? { label: stage, cls: "bg-muted text-muted-foreground" };
  return (
    <Badge variant="secondary" className={`shrink-0 text-[10px] ${s.cls}`}>
      {s.label}
    </Badge>
  );
}
