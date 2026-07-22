import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import { StageBadge } from "@/components/stage-badge";
import { listActivity, type ActivityEntry, type ActivityKind } from "@/lib/activity.functions";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Bell,
  CheckCheck,
  Inbox,
  MessageCircle,
  Newspaper,
  Shield,
  Timer,
  UserPlus,
  VolumeX,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/activity")({
  head: () => ({ meta: [{ title: "Activity — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAdmin?: boolean }).isAdmin) throw redirect({ to: "/approvals" });
  },
  component: ActivityPage,
});

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
    new_contact: {
      label: "New contacts",
      icon: UserPlus,
      cls: "text-violet-600 dark:text-violet-400",
    },
    alert: { label: "Alerts", icon: Bell, cls: "text-rose-600 dark:text-rose-400" },
    error: { label: "Errors", icon: AlertTriangle, cls: "text-rose-600 dark:text-rose-400" },
  };

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "reply", label: "Replies" },
  { value: "approval", label: "Approvals" },
  { value: "post", label: "Posts" },
  { value: "moderation", label: "Moderation" },
  { value: "follow_up", label: "Follow-ups" },
  { value: "new_contact", label: "New contacts" },
  { value: "gate", label: "Reply gate" },
  { value: "alert", label: "Alerts" },
  { value: "error", label: "Errors" },
];

function dayLabel(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 3600_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const expandable = entry.stages.length > 0;
  return (
    <div className="py-2.5">
      <details className="group">
        <summary
          className={`flex items-start gap-3 ${expandable ? "cursor-pointer" : "cursor-default [&::-webkit-details-marker]:hidden"} list-none`}
        >
          <div
            className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted ${meta.cls}`}
          >
            <Icon className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1" dir="auto">
            <p className="text-sm leading-snug">{entry.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span dir="auto">{entry.chat_name ?? entry.chat_id ?? ""}</span>
              {expandable && (
                <span className="ms-2 text-primary/70 group-open:hidden">· details ▾</span>
              )}
            </p>
          </div>
          <span className="shrink-0 pt-0.5 text-xs text-muted-foreground" dir="ltr">
            {new Date(entry.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </summary>
        {expandable && (
          <div className="ms-10 mt-2 space-y-1.5 border-s-2 border-primary/20 ps-3">
            {entry.stages.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-xs" dir="auto">
                <StageBadge stage={s.stage} />
                <span className={`flex-1 ${s.status === "error" ? "text-rose-500" : ""}`}>
                  {s.summary}
                </span>
                {s.duration_ms != null && (
                  <span className="shrink-0 text-muted-foreground">{s.duration_ms}ms</span>
                )}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}

function ActivityPage() {
  const listFn = useServerFn(listActivity);
  const [range, setRange] = useState<"day" | "week" | "month">("day");
  const [kind, setKind] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["activity", range, kind],
    queryFn: () => listFn({ data: { range, kind: kind as "all" } }),
    refetchInterval: 8000,
  });

  const entries = data?.entries ?? [];
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Group entries by day for scannable headers.
  const byDay: Array<{ day: string; items: ActivityEntry[] }> = [];
  for (const e of entries) {
    const day = dayLabel(e.ts);
    const bucket = byDay[byDay.length - 1];
    if (bucket && bucket.day === day) bucket.items.push(e);
    else byDay.push({ day, items: [e] });
  }

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
          {FILTERS.map((f) => {
            const count = f.value === "all" ? total : (counts[f.value] ?? 0);
            if (f.value !== "all" && count === 0 && kind !== f.value) return null;
            return (
              <button
                key={f.value}
                onClick={() => setKind(f.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  kind === f.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background hover:bg-muted"
                }`}
              >
                {f.label}
                <span className="ms-1.5 opacity-70">{count}</span>
              </button>
            );
          })}
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
        ) : entries.length === 0 ? (
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
              <div className="mb-1 mt-2 flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {bucket.day}
                </h2>
                <Badge variant="outline" className="text-[10px]">
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
