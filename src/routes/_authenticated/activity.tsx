import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import { StageBadge } from "@/components/stage-badge";
import {
  listActivity,
  ACTIVITY_KINDS,
  type ActivityEntry,
  type ActivityKind,
} from "@/lib/activity.functions";
import { DEMO_MODE, demoActivityFeed } from "@/lib/demo";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Bell,
  CheckCheck,
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
// show "All quiet" under a non-zero count). `tint` colors the compact card's
// icon chip; `cls` keeps the icon color for the detail panel.
const KIND_META: Record<
  ActivityKind,
  { label: string; icon: typeof MessageCircle; cls: string; tint: string }
> = {
  reply: {
    label: "Replies",
    icon: MessageCircle,
    cls: "text-emerald-600 dark:text-emerald-400",
    tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  approval: {
    label: "Approvals",
    icon: Inbox,
    cls: "text-amber-600 dark:text-amber-400",
    tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  handled: {
    label: "Handled",
    icon: CheckCheck,
    cls: "text-sky-600 dark:text-sky-400",
    tint: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  gate: {
    label: "Reply gate",
    icon: VolumeX,
    cls: "text-muted-foreground",
    tint: "bg-muted text-muted-foreground",
  },
  post: {
    label: "Posts",
    icon: Newspaper,
    cls: "text-emerald-600 dark:text-emerald-400",
    tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  moderation: {
    label: "Moderation",
    icon: Shield,
    cls: "text-orange-600 dark:text-orange-400",
    tint: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  },
  welcome: {
    label: "Welcomes",
    icon: UserPlus,
    cls: "text-lime-600 dark:text-lime-400",
    tint: "bg-lime-500/10 text-lime-600 dark:text-lime-400",
  },
  follow_up: {
    label: "Follow-ups",
    icon: Timer,
    cls: "text-cyan-600 dark:text-cyan-400",
    tint: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  },
  insight: {
    label: "Insights",
    icon: ActivityIcon,
    cls: "text-slate-500",
    tint: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
  config: {
    label: "Config changes",
    icon: Settings2,
    cls: "text-blue-600 dark:text-blue-400",
    tint: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  new_contact: {
    label: "New contacts",
    icon: UserPlus,
    cls: "text-violet-600 dark:text-violet-400",
    tint: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  alert: {
    label: "Alerts",
    icon: Bell,
    cls: "text-rose-600 dark:text-rose-400",
    tint: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  error: {
    label: "Errors",
    icon: AlertTriangle,
    cls: "text-rose-600 dark:text-rose-400",
    tint: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
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

function timeLabel(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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

/**
 * One compact, scannable card: icon by kind, one-line title, contact/group +
 * time. The full pipeline trace lives in the detail panel — nothing expands
 * inline, so a day of activity fits on one screen.
 */
function EntryCard({ entry, onOpen }: { entry: ActivityEntry; onOpen: () => void }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const attention = entry.kind === "error" || entry.kind === "alert";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-start shadow-xs transition-all hover:border-primary/40 hover:shadow-sm ${
        attention ? "border-rose-500/30" : "border-border"
      }`}
    >
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-md ${meta.tint}`}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight" dir="auto">
          {entry.title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" dir="auto">
          {entry.chat_name ?? entry.chat_id ?? meta.label}
        </span>
      </span>
      <span
        className="shrink-0 self-start pt-0.5 text-[11px] tabular-nums text-muted-foreground"
        dir="ltr"
      >
        {timeLabel(entry.ts)}
      </span>
    </button>
  );
}

/** Right-side detail panel: full title, pipeline steps, reasoning, timings. */
function EntryDetail({ entry, onClose }: { entry: ActivityEntry | null; onClose: () => void }) {
  const meta = entry ? KIND_META[entry.kind] : null;
  const Icon = meta?.icon ?? ActivityIcon;
  const totalMs = (entry?.stages ?? []).reduce((a, s) => a + (s.duration_ms ?? 0), 0);
  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {entry && meta && (
          <>
            <SheetHeader className="text-start">
              <div className="flex items-center gap-2.5">
                <span
                  className={`flex size-9 shrink-0 items-center justify-center rounded-md ${meta.tint}`}
                >
                  <Icon className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <Badge variant="outline" className="mb-1 text-[10px]">
                    {meta.label}
                  </Badge>
                  <SheetDescription className="text-xs" dir="ltr">
                    {new Date(entry.ts).toLocaleString("en-GB")}
                    {entry.stages.length > 0 && (
                      <>
                        {" · "}
                        {entry.stages.length} step{entry.stages.length === 1 ? "" : "s"}
                        {totalMs > 0 && <> · {(totalMs / 1000).toFixed(1)}s</>}
                      </>
                    )}
                  </SheetDescription>
                </div>
              </div>
              <SheetTitle className="pt-2 text-base leading-snug" dir="auto">
                {entry.title}
              </SheetTitle>
              {(entry.chat_name ?? entry.chat_id) && (
                <p className="text-sm text-muted-foreground" dir="auto">
                  {entry.chat_name ?? entry.chat_id}
                </p>
              )}
            </SheetHeader>

            <div className="mt-5">
              {entry.stages.length === 0 ? (
                <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                  No pipeline steps for this entry — it's a standalone event.
                </p>
              ) : (
                <>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Pipeline steps
                  </h3>
                  <div className="space-y-2.5 border-s-2 border-primary/20 ps-3">
                    {entry.stages.map((s, i) => (
                      <div key={i} className="flex items-start gap-2 text-[13px]" dir="auto">
                        <StageBadge stage={s.stage} />
                        <span
                          className={`flex-1 leading-snug ${s.status === "error" ? "text-rose-500" : ""}`}
                        >
                          {s.summary}
                        </span>
                        {s.duration_ms != null && (
                          <span
                            className="shrink-0 text-xs tabular-nums text-muted-foreground"
                            dir="ltr"
                          >
                            {s.duration_ms}ms
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ActivityPage() {
  const listFn = useServerFn(listActivity);
  const [range, setRange] = useState<"day" | "week" | "month">("day");
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [selected, setSelected] = useState<ActivityEntry | null>(null);

  const { data: realData, isLoading: realLoading } = useQuery({
    queryKey: ["activity", range, kind],
    queryFn: () => listFn({ data: { range, kind } }),
    refetchInterval: 8000,
    enabled: !DEMO_MODE,
  });
  const data = DEMO_MODE
    ? (demoActivityFeed(range, kind) as unknown as NonNullable<typeof realData>)
    : realData;
  const isLoading = DEMO_MODE ? false : realLoading;

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
        maxWidthClass="max-w-6xl"
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

      <PageContent maxWidthClass="max-w-6xl">
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
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="flex animate-pulse items-center gap-2.5 rounded-lg border p-3"
              >
                <div className="size-8 rounded-md bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-4/5 rounded bg-muted" />
                  <div className="h-2.5 w-2/5 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
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
              <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 bg-background/95 py-2 backdrop-blur">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {bucket.day}
                </h2>
                <Badge variant="outline" className="text-[10px]" dir="ltr">
                  {bucket.items.length}
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {bucket.items.map((e) => (
                  <EntryCard key={e.id} entry={e} onOpen={() => setSelected(e)} />
                ))}
              </div>
            </div>
          ))
        )}
      </PageContent>

      <EntryDetail entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
