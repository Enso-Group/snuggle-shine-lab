// Behind the Scenes → WhatsApp Connection: live channel status, QR
// (re)connect flow, full-history sync and the one-click pipeline reset that
// registers the webhook. Ported from the former Participants page.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { History, QrCode, Radio, RefreshCw, Wifi, WifiOff, Zap } from "lucide-react";
import { useWhatsAppConnection, WA_CONNECTION_QUERY_KEY } from "@/hooks/use-connection";
import {
  enableHistorySync,
  fetchWhatsAppQr,
  resetWhatsAppPipeline,
  startWhatsAppReconnect,
  syncDirectChatHistory,
} from "@/lib/participants.functions";

export function ConnectionTab() {
  const qc = useQueryClient();
  const { connected, status, userName, isLoading } = useWhatsAppConnection();
  const reconnectFn = useServerFn(startWhatsAppReconnect);
  const qrFn = useServerFn(fetchWhatsAppQr);
  const resetFn = useServerFn(resetWhatsAppPipeline);
  const historyFn = useServerFn(enableHistorySync);
  const importDmsFn = useServerFn(syncDirectChatHistory);

  const [qrImage, setQrImage] = useState("");
  const [notice, setNotice] = useState("");
  const [waitingQr, setWaitingQr] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: WA_CONNECTION_QUERY_KEY });

  const reconnect = useMutation({
    mutationFn: () => reconnectFn(),
    onMutate: () => {
      setNotice("");
      setQrImage("");
    },
    onSuccess: (r: { qrImage?: string; qrStatus?: string }) => {
      if (r.qrImage) {
        setQrImage(r.qrImage);
        setWaitingQr(false);
        setNotice(
          "Scan the QR code from your phone (WhatsApp → Linked devices). Status updates automatically.",
        );
      } else {
        setWaitingQr(true);
        setNotice(
          `Waiting for a QR code (status: ${r.qrStatus || "WAITING"})… retrying automatically.`,
        );
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: () =>
      resetFn({ data: { webhookUrl: `${window.location.origin}/api/public/whapi-webhook` } }),
    onSuccess: (r: {
      fullHistory?: boolean | null;
      webhookUrl?: string | null;
      connected?: boolean | null;
      userName?: string | null;
      status?: string | null;
    }) => {
      const parts = [
        r.fullHistory ? "✓ Full history active" : "✗ Full history not enabled",
        r.webhookUrl ? `✓ Webhook registered: ${r.webhookUrl}` : "✗ Webhook not registered",
        r.connected
          ? `✓ Connected${r.userName ? ` as ${r.userName}` : ""}`
          : `Status: ${r.status ?? "not connected"} — scan the QR or reconnect`,
      ];
      setNotice(parts.join("\n"));
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const history = useMutation({
    mutationFn: () => historyFn(),
    onSuccess: () =>
      setNotice("Full history enabled. Reconnect WhatsApp so older history is pulled in."),
    onError: (e: Error) => toast.error(e.message),
  });

  const importDms = useMutation({
    mutationFn: () => importDmsFn({ data: {} }),
    onSuccess: (r: {
      chats: number;
      inserted: number;
      results: Array<{ chat: string; inserted: number; fetched: number; error?: string }>;
    }) => {
      const failed = r.results.filter((x) => x.error);
      const lines = [
        `Imported ${r.inserted} messages across ${r.chats} direct chats.`,
        ...r.results
          .filter((x) => x.inserted > 0)
          .slice(0, 15)
          .map((x) => `✓ ${x.chat}: +${x.inserted}`),
        ...failed.map((x) => `✗ ${x.chat}: ${x.error}`),
      ];
      setNotice(lines.join("\n"));
      toast.success(`Imported ${r.inserted} messages from ${r.chats} chats`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Poll for the QR while the channel transitions to QR-ready.
  useEffect(() => {
    if (!waitingQr || qrImage) return;
    const interval = setInterval(() => {
      qrFn()
        .then((r: { qrImage?: string; qrStatus?: string; status?: string }) => {
          if (r.qrImage) {
            setQrImage(r.qrImage);
            setWaitingQr(false);
            setNotice("Scan the QR code from your phone (WhatsApp → Linked devices).");
          }
          if (r.status === "connected") {
            setWaitingQr(false);
            setQrImage("");
            setNotice("Connected!");
            refresh();
          }
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingQr, qrImage]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div
              className={`flex size-10 items-center justify-center rounded-full ${connected ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-500"}`}
            >
              {connected ? <Wifi className="size-5" /> : <WifiOff className="size-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {isLoading ? "Checking…" : connected ? "WhatsApp connected" : "Not connected"}
              </p>
              <p className="text-xs text-muted-foreground">
                {connected
                  ? `Linked as ${userName ?? "unknown"} · status: ${status ?? "online"}`
                  : `Status: ${status ?? "unknown"} — reconnect below`}
              </p>
            </div>
            <Badge variant={connected ? "secondary" : "destructive"} className="text-xs">
              {connected ? "online" : "offline"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <h3 className="text-sm font-semibold">Connection actions</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                if (
                  window.confirm(
                    "This briefly disconnects WhatsApp and shows a new QR code to scan. Continue?",
                  )
                )
                  reconnect.mutate();
              }}
              disabled={reconnect.isPending}
            >
              <QrCode className="size-4" />
              {reconnect.isPending ? "Starting…" : "Reconnect (new QR)"}
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                if (
                  window.confirm(
                    "This re-registers the webhook (messages + statuses + group events) and enables full history. Continue?",
                  )
                )
                  reset.mutate();
              }}
              disabled={reset.isPending}
            >
              <Zap className="size-4" />
              {reset.isPending ? "Resetting…" : "Reset pipeline (webhook + history)"}
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => history.mutate()}
              disabled={history.isPending}
            >
              <RefreshCw className="size-4" />
              Enable full history
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => importDms.mutate()}
              disabled={importDms.isPending}
            >
              <History className="size-4" />
              {importDms.isPending ? "Importing…" : "Import 1:1 chat history"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Run "Reset pipeline" after any reconnect — it registers the webhook that feeds every
            message and group event into the agent.
          </p>
          {notice && (
            <Alert>
              <Radio className="size-4" />
              <AlertDescription className="whitespace-pre-wrap text-xs">{notice}</AlertDescription>
            </Alert>
          )}
          {qrImage && (
            <div className="flex justify-center rounded-md border p-4">
              <img src={qrImage} alt="WhatsApp QR code" className="size-64" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
