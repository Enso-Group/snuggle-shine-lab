// Shared funnel-stage badge — the single source of stage colors, so the
// Profiles contact list and detail header can never drift apart.
import { Badge } from "@/components/ui/badge";

export const FUNNEL_STAGE_STYLES: Record<string, string> = {
  unknown: "bg-muted text-muted-foreground",
  lead: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  customer: "bg-green-500/15 text-green-600 dark:text-green-400",
  community: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  vip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  churned: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function FunnelStageBadge({
  stage,
  size = "sm",
}: {
  stage: string;
  size?: "sm" | "md";
}) {
  const cls = FUNNEL_STAGE_STYLES[stage] ?? FUNNEL_STAGE_STYLES.unknown;
  return (
    <Badge
      variant="secondary"
      className={`shrink-0 ${size === "md" ? "text-xs" : "text-[10px]"} ${cls}`}
    >
      {stage}
    </Badge>
  );
}
