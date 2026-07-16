import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import { ScrollText, ArrowLeft } from "lucide-react";
import { useWhatsAppConnection } from "@/hooks/use-connection";
import { DEMO_MODE, demoLogs } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/logs")({
  head: () => ({ meta: [{ title: "Logs — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: LogsPage,
});

type Log = { id: string; prompt: string; target_chat_id: string; target_name: string | null; result: string | null; status: string; created_at: string };

function LogsPage() {
  const { connected, isLoading: connLoading } = useWhatsAppConnection();
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    if (DEMO_MODE) {
      setLogs(demoLogs as Log[]);
      return;
    }
    // Don't show stale log history when no account is connected.
    if (!connected) {
      setLogs([]);
      return;
    }
    supabase
      .from("commands_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => setLogs((data ?? []) as Log[]));
  }, [connected]);

  return (
    <div className="min-h-full">
      <PageHeader
        icon={ScrollText}
        title="Logs"
        description="Recent commands sent from the dashboard"
        actions={
          <>
            {!connected && !connLoading && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                No WhatsApp account connected
              </Badge>
            )}
            {logs.length > 0 && (
              <Badge variant="secondary" className="font-normal">
                {logs.length} entries
              </Badge>
            )}
          </>
        }
      />

      <PageContent maxWidthClass="max-w-4xl" className="space-y-3">
        {logs.length === 0 && (
          <Card>
            <CardContent>
              <EmptyState
                icon={ScrollText}
                title="No logs yet"
                description="Commands sent from the dashboard will show up here."
              />
            </CardContent>
          </Card>
        )}
        {logs.map((l) => (
          <Card key={l.id}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <ArrowLeft className="size-3.5 shrink-0 rotate-180 text-muted-foreground" />
                  <span className="truncate">{l.target_name || l.target_chat_id}</span>
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={l.status === "sent" ? "default" : l.status === "error" ? "destructive" : "secondary"}>
                    {l.status === "sent" ? "Sent" : l.status === "error" ? "Error" : "Pending"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString("en-US")}</span>
                </div>
              </div>
              <p className="text-sm">
                <span className="font-medium">Request:</span> {l.prompt}
              </p>
              {l.result && (
                <div className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm">
                  <span className="font-medium">Result:</span> {l.result}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </PageContent>
    </div>
  );
}
