import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { getDashboardStats } from "@/lib/bot.functions";
import { MessageSquare, Users, Send } from "lucide-react";
import { useWhatsAppConnection } from "@/hooks/use-connection";
import { DEMO_MODE, demoDashboardStats } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "Overview — WhatsApp Bot" }] }),
  component: Dashboard,
});

function Dashboard() {
  const statsFn = useServerFn(getDashboardStats);

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
