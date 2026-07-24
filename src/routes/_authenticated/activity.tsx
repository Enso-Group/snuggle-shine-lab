import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import { StageBadge } from "@/components/stage-badge";
import {
  listActivity,
  ACTIVITY_KINDS,
  type ActivityEntry,
  type ActivityKind,
} from "@/lib/activity.functions";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Bell,
  CheckCheck,
  ChevronDown,
  Inbox,
  MessageCircle,
  Newspaper,
  Settings2,
  Shield,
  Timer,
  UserPlus,
  VolumeX,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/activity")({
  head: () => ({ meta: [{ title: "Activity — WhatsApp Bot" }] }),
  component: ActivityPage,
});

// Keyed by ActivityKind so a kind added on the server fails compilation here
// instead of silently missing its chip/icon (the drift that once made the page
// show "All quiet" under a non-zero count).
const KIND_META: Record<ActivityKind, { label: string; icon: typeof MessageCircle; cls: string }> =
  {
    reply: { label: "Replies", icon: MessageCircle, cls: "text-emerald-600 dark:text-emerald-400" },
    approval: { label: "Approvals", icon: Inbox, cls: "text-amber-600 dark:text-amber-400" },
    handled: { label: "Handled", icon: CheckCheck, cls: "text-sky-600 dark:text-sky-400" },
    gate: { label: "Reply gate", icon: VolumeX, cls: "text-muted-foreground" },
    post: { label: "Posts", icon: Newspaper, cls: "text-emerald-600 dark:text-emerald-400" },
    moderation: { label: "Moderation", icon: Shield, cls: "text-orange-600 dark:text-orange-400" },
    welcome: { label: "Welcomes", icon: UserPlus, cls: "text-lime-600 dark:text-lime-400" },
    follow_up: { label: "Follow-ups", icon: Timer, cls: "text-cyan-600 dark:text-cyan-400" },
    insight: { label: "Insights", icon: ActivityIcon, cls: "text-slate-500" },
    config: { label: "Config changes", icon: Settings2, cls: "text-blue-600 dark:text-blue-400" },
    new_contact: {
      label: "New contacts",
      icon: UserPlus,
      cls: "text-violet-600 dark:text-violet-400",
    },
    alert: { label: "Alerts", icon: Bell, cls: "text-rose-600 dark:text-rose-400" },
    error: { label: "Errors", icon: AlertTriangle, cls: "text-rose-600 dark:text-rose-400" },
  };

function dayLabel(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 3600_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function KindChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  // Zero-count chips stay in the row (disabled) so the layout never reflows
  // when the 8s poll shifts counts around.
  const disabled = count === 0 && !active;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : disabled
            ? "border-border/60 text-muted-foreground/50"
            : "border-border bg-background hover:bg-muted"
      }`}
    >
      {label}
      <span className="ms-1.5 opacity-70" dir="ltr">
        {count}
      </span>
    </button>
  );
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const expandable = entry.stages.length > 0;

  const row = (
    <>
      <div
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted ${meta.cls}`}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 text-start">
        <p className="text-sm leading-snug" dir="auto">
          {entry.title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground" dir="auto">
          {entry.chat_name ?? entry.chat_id ?? ""}
        </p>
      </div>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground" dir="ltr">
        {new Date(entry.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
      </span>
    </>
  );

  if (!expandable) {
    return (
      <div className="flex items-start gap-3 py-2.5">
        {row}
        {/* Chevron-sized spacer keeps timestamps column-aligned with expandable rows. */}
        <span className="mt-1 size-4 shrink-0" aria-hidden />
      </div>
    );
  }

  return (
    <Collapsible className="group py-2.5">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-start gap-3 text-start">
        {row}
        <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ms-10 mt-2 space-y-1.5 border-s-2 border-primary/20 ps-3">
          {entry.stages.map((s, i) => (
            <div key={i} className="flex items-start gap-2 text-xs" dir="auto">
              <StageBadge stage={s.stage} />
              <span className={`flex-1 ${s.status === "error" ? "text-rose-500" : ""}`}>
                {s.summary}
              </span>
              {s.duration_ms != null && (
                <span className="shrink-0 text-muted-foreground" dir="ltr">
                  {s.duration_ms}ms
                </span>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActivityPage() {
  const listFn = useServerFn(listActivity);
  const [range, setRange] = useState<"day" | "week" | "month">("day");
  const [kind, setKind] = useState<ActivityKind | "all">("all");

  const { data, isLoading } = useQuery({
    queryKey: ["activity", range, kind],
    queryFn: () => listFn({ data: { range, kind } }),
    refetchInterval: 8000,
  });

  const entries = data?.entries;
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Group entries by day for scannable headers.
  const byDay = useMemo(() => {
    const groups: Array<{ day: string; items: ActivityEntry[] }> = [];
    for (const e of entries ?? []) {
      const day = dayLabel(e.ts);
      const bucket = groups[groups.length - 1];
      if (bucket && bucket.day === day) bucket.items.push(e);
      else groups.push({ day, items: [e] });
    }
    return groups;
  }, [entries]);

  return (
    <div className="min-h-full">
      <PageHeader
        icon={ActivityIcon}
        title="Activity"
        description="Everything the bot did — messages, replies, posts, moderation, follow-ups — with full reasoning for every action."
        maxWidthClass="max-w-4xl"
        actions={
          <Tabs value={range} onValueChange={(v) => setRange(v as typeof range)}>
            <TabsList className="h-8">
              <TabsTrigger value="day" className="text-xs">
                Day
              </TabsTrigger>
              <TabsTrigger value="week" className="text-xs">
                Week
              </TabsTrigger>
              <TabsTrigger value="month" className="text-xs">
                Month
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <PageContent maxWidthClass="max-w-4xl">
        <div className="flex flex-wrap gap-1.5">
          <KindChip
            label="All"
            count={total}
            active={kind === "all"}
            onClick={() => setKind("all")}
          />
          {ACTIVITY_KINDS.map((k) => (
            <KindChip
              key={k}
              label={KIND_META[k].label}
              count={counts[k] ?? 0}
              active={kind === k}
              onClick={() => setKind(k)}
            />
          ))}
        </div>

        {isLoading && !data ? (
          <Card>
            <CardContent className="space-y-3 p-5">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex animate-pulse items-center gap-3">
                  <div className="size-7 rounded-full bg-muted" />
                  <div className="h-3 flex-1 rounded bg-muted" />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : !entries || entries.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                icon={ActivityIcon}
                title="All quiet"
                description="No activity recorded in the selected range. Every bot action will appear here the moment it happens."
              />
            </CardContent>
          </Card>
        ) : (
          byDay.map((bucket) => (
            <div key={bucket.day}>
              <div className="sticky top-0 z-10 mb-1 flex items-center gap-2 bg-background/95 py-2 backdrop-blur">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {bucket.day}
                </h2>
                <Badge variant="outline" className="text-[10px]" dir="ltr">
                  {bucket.items.length}
                </Badge>
              </div>
              <Card>
                <CardContent className="divide-y px-4 py-1">
                  {bucket.items.map((e) => (
                    <EntryRow key={e.id} entry={e} />
                  ))}
                </CardContent>
              </Card>
            </div>
          ))
        )}
      </PageContent>
    </div>
  );
}
