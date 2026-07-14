import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDashboardStats } from "@/lib/bot.functions";
import { MessageSquare, Users, Send } from "lucide-react";
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
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Overview</h1>
        <p className="text-muted-foreground mt-1">Your bot status at a glance</p>
        {!connected && !connLoading && (
          <p className="text-xs text-muted-foreground mt-1">No WhatsApp account connected.</p>
        )}
      </div>

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
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.6} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
              />
              <Area type="monotone" dataKey="messages" stroke="hsl(var(--primary))" fill="url(#overviewGradient)" name="Messages" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-6 flex items-center gap-4">
        <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon className="size-6 text-primary" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
