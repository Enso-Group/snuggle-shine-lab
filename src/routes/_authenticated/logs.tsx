import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
    <div className="p-8 max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Logs</h1>
        <p className="text-muted-foreground mt-1">Recent commands sent from the dashboard</p>
        {!connected && !connLoading && (
          <p className="text-xs text-muted-foreground mt-1">No WhatsApp account connected.</p>
        )}
      </div>
      <div className="space-y-3">
        {logs.length === 0 && <p className="text-muted-foreground">No logs yet.</p>}
        {logs.map((l) => (
          <Card key={l.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">→ {l.target_name || l.target_chat_id}</span>
                <div className="flex gap-2 items-center">
                  <Badge variant={l.status === "sent" ? "default" : l.status === "error" ? "destructive" : "secondary"}>
                    {l.status === "sent" ? "Sent" : l.status === "error" ? "Error" : "Pending"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString("en-US")}</span>
                </div>
              </div>
              <p className="text-sm"><strong>Request:</strong> {l.prompt}</p>
              {l.result && <p className="text-sm bg-muted p-2 rounded whitespace-pre-wrap"><strong>Result:</strong> {l.result}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
