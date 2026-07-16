import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageContent } from "@/components/page-header";
import { getDashboardStats } from "@/lib/bot.functions";
import { MessageSquare, Users, Send, LayoutDashboard, Wifi, WifiOff } from "lucide-react";
import { useWhatsAppConnection } from "@/hooks/use-connection";
import { DEMO_MODE, demoDashboardStats, demoOverviewSeries } from "@/lib/demo";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

type Range = "today" | "week" | "month";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "Overview — WhatsApp Bot" }] }),
  component: Dashboard,
});

function Dashboard() {
  const statsFn = useServerFn(getDashboardStats);
  const [range, setRange] = useState<Range>("week");
  const series = demoOverviewSeries(range);

  const { connected, isLoading: connLoading } = useWhatsAppConnection();
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => statsFn(),
    // Don't fetch (or show) stats unless a WhatsApp account is actually connected.
    enabled: connected,
    refetchInterval: 10000,
  });

  return (
    <div className="min-h-full">
      <PageHeader
        icon={LayoutDashboard}
        title="Overview"
        description="Your bot status at a glance"
        actions={
          !connLoading &&
          (connected ? (
            <Badge variant="secondary" className="gap-1.5 font-normal text-emerald-700 dark:text-emerald-400">
              <Wifi className="size-3" />
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
              <WifiOff className="size-3" />
              No WhatsApp account connected
            </Badge>
          ))
        }
      />

      <PageContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard icon={Users} label="Conversations" value={(DEMO_MODE ? demoDashboardStats : stats.data)?.conversations ?? 0} />
          <StatCard icon={MessageSquare} label="Messages" value={(DEMO_MODE ? demoDashboardStats : stats.data)?.messages ?? 0} />
          <StatCard icon={Send} label="Commands sent" value={(DEMO_MODE ? demoDashboardStats : stats.data)?.commands ?? 0} />
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
            <CardTitle className="text-base">Messages</CardTitle>
            <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
              <TabsList>
                <TabsTrigger value="today">Today</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="month">Month</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series}>
                <defs>
                  <linearGradient id="overviewGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.6} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                />
                <Area type="monotone" dataKey="messages" stroke="var(--primary)" fill="url(#overviewGradient)" name="Messages" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </PageContent>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-6 flex items-center gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Icon className="size-5 text-primary" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</p>
        </div>
      </CardContent>
    </Card>
  );
}
