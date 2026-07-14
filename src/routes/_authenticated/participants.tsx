import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  listGroupConversations,
  listGroupParticipants,
  getParticipantMessages,
  enableHistorySync,
  getWhatsAppConnectionStatus,
  startWhatsAppReconnect,
  fetchWhatsAppQr,
  resetWhatsAppPipeline,
} from "@/lib/participants.functions";
import { supabase } from "@/integrations/supabase/client";
import { useWhatsAppConnection, WA_CONNECTION_QUERY_KEY } from "@/hooks/use-connection";
import { DEMO_MODE, demoGroupConversations, demoParticipants, demoParticipantMessages } from "@/lib/demo";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Users, MessageSquare, RefreshCw, Radio, Check, ChevronsUpDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/participants")({
  ssr: false,
  component: ParticipantsPage,
});

type Group = { whapi_chat_id: string; name: string };
type Participant = {
  sender_id: string;
  sender_name: string;
  message_count: number;
  last_message_at: string | null;
  last_body: string;
};
type Msg = { id: string; body: string; created_at: string; source: "live" | "db" };

function ParticipantsPage() {
  const { connected } = useWhatsAppConnection();
  const qc = useQueryClient();
  const wasConnected = useRef<boolean | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string>("");
  const [groupName, setGroupName] = useState<string>("");
  const [participantsCount, setParticipantsCount] = useState(0);
  const [messagesScanned, setMessagesScanned] = useState(0);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingParts, setLoadingParts] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Participant | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [fullHistory, setFullHistory] = useState<boolean | null>(null);
  const [enablingHistory, setEnablingHistory] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [resetting, setResetting] = useState(false);

  function loadGroups() {
    if (DEMO_MODE) {
      setGroups(demoGroupConversations as Group[]);
      setLoadingGroups(false);
      return;
    }
    setLoadingGroups(true);
    listGroupConversations()
      .then((r) => setGroups(r as Group[]))
      .catch(() => {})
      .finally(() => setLoadingGroups(false));
  }

  function loadParticipants(id: string) {
    if (!id) return;
    if (DEMO_MODE) {
      const r = demoParticipants(id);
      setParticipants(r.rows as Participant[]);
      setGroupName(r.groupName);
      setParticipantsCount(r.participantsCount);
      setMessagesScanned(r.messagesScanned);
      setLastRefresh(new Date());
      setLoadingParts(false);
      return;
    }
    setLoadingParts(true);
    setHistoryNotice("");
    listGroupParticipants({ data: { whapiChatId: id } })
      .then((r: any) => {
        setParticipants(r.rows as Participant[]);
        setGroupName(r.groupName);
        setParticipantsCount(r.participantsCount);
        setMessagesScanned(r.messagesScanned ?? 0);
        setLastRefresh(new Date());
      })
      .catch((e: any) => setHistoryNotice(String(e?.message ?? "Couldn't refresh the group.")))
      .finally(() => setLoadingParts(false));
  }

  function loadMsgs(p: Participant) {
    if (!groupId || !p) return;
    if (DEMO_MODE) {
      setMsgs(demoParticipantMessages(p.sender_id || p.sender_name) as Msg[]);
      setLoadingMsgs(false);
      return;
    }
    setLoadingMsgs(true);
    getParticipantMessages({
      data: { whapiChatId: groupId, senderId: p.sender_id || p.sender_name },
    })
      .then((r) => setMsgs(r as Msg[]))
      .finally(() => setLoadingMsgs(false));
  }

  function loadConnectionStatus() {
    if (DEMO_MODE) {
      setFullHistory(true);
      return;
    }
    getWhatsAppConnectionStatus().then((r: any) => {
      setFullHistory(r.fullHistory);
      setConnectionStatus(r.status);
      if (r.connected) setQrImage("");
      // On any connect/disconnect transition, refresh the shared status so every
      // page updates right away.
      if (wasConnected.current !== r.connected) {
        wasConnected.current = r.connected;
        qc.invalidateQueries({ queryKey: WA_CONNECTION_QUERY_KEY });
      }
    });
  }

  useEffect(() => {
    loadConnectionStatus();
  }, []);

  // Load groups only while connected; clear the (now stale) list otherwise.
  useEffect(() => {
    if (connected) {
      loadGroups();
    } else {
      setGroups([]);
      setGroupId("");
      setLoadingGroups(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  function enableFullHistory() {
    setEnablingHistory(true);
    enableHistorySync()
      .then((r: any) => {
        setFullHistory(r.fullHistory);
        setHistoryNotice("The setting is enabled. Now you must reconnect WhatsApp so the old history is pulled into the connection.");
      })
      .catch(() => setHistoryNotice("Couldn't enable full history. Please try again in a moment."))
      .finally(() => setEnablingHistory(false));
  }

  function reconnectWhatsApp() {
    if (!window.confirm("This will briefly disconnect WhatsApp and show a new QR code to scan. Continue?")) return;
    setReconnecting(true);
    setHistoryNotice("");
    setQrImage("");
    startWhatsAppReconnect()
      .then((r: any) => {
        setFullHistory(r.fullHistory);
        setConnectionStatus(r.status);
        if (r.qrImage) {
          setQrImage(r.qrImage);
          setHistoryNotice("A QR code was created. Scan it from your phone. Once the status returns to connected, select the group and refresh it.");
        } else {
          setHistoryNotice(`Waiting for QR (status: ${r.qrStatus || "WAITING"})... will retry automatically.`);
        }
      })
      .catch((e: any) => setHistoryNotice(String(e?.message ?? "Couldn't generate a real QR code. Please try again in a moment.")))
      .finally(() => setReconnecting(false));
  }

  function resetPipeline() {
    if (!window.confirm("This will reset the entire data flow: it enables full history and connects the Webhook to Whapi so every new message flows automatically into the site. Continue?")) return;
    setResetting(true);
    setHistoryNotice("");
    const webhookUrl = `${window.location.origin}/api/public/whapi-webhook`;
    resetWhatsAppPipeline({ data: { webhookUrl } })
      .then((r: any) => {
        setFullHistory(r.fullHistory);
        setConnectionStatus(r.status);
        const parts: string[] = [];
        parts.push(r.fullHistory ? "✓ Full history active" : "✗ Full history not enabled");
        parts.push(r.webhookUrl ? `✓ Webhook registered: ${r.webhookUrl}` : "✗ Webhook not registered");
        parts.push(r.connected ? `✓ Connected${r.userName ? ` as ${r.userName}` : ""}` : `Status: ${r.status ?? "not connected"} — scan QR or reconnect`);
        parts.push("From now on, every new message flows automatically into the site. If you also want old history — disconnect the phone and reconnect.");
        setHistoryNotice(parts.join("\n"));
      })
      .catch((e: any) => setHistoryNotice(`Reset failed: ${e?.message ?? e}`))
      .finally(() => setResetting(false));
  }

  // Poll for QR while waiting (after reconnect started but QR not yet available)
  useEffect(() => {
    if (qrImage || !historyNotice.includes("Waiting for QR")) return;
    const interval = setInterval(() => {
      fetchWhatsAppQr()
        .then((r: any) => {
          setConnectionStatus(r.status);
          if (r.qrImage) {
            setQrImage(r.qrImage);
            setHistoryNotice("A QR code was created. Scan it from your phone. Once the status returns to connected, select the group and refresh it.");
          } else {
            setHistoryNotice(`Waiting for QR (status: ${r.qrStatus || "WAITING"})... will retry automatically.`);
          }
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [qrImage, historyNotice]);


  useEffect(() => {
    setParticipants([]);
    if (groupId) loadParticipants(groupId);
  }, [groupId]);

  // Realtime: refresh on new messages in this group's conversation
  useEffect(() => {
    if (!groupId) return;
    const channel = supabase
      .channel(`participants-${groupId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        () => {
          loadParticipants(groupId);
          if (selected) loadMsgs(selected);
        },
      )
      .subscribe();
    // Auto-refresh every 10s so the table updates in near real-time
    const interval = setInterval(() => loadParticipants(groupId), 10000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, selected?.sender_id]);

  useEffect(() => {
    if (!qrImage) return;
    const interval = setInterval(loadConnectionStatus, 5000);
    return () => clearInterval(interval);
  }, [qrImage]);


  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter(
      (p) =>
        p.sender_name.toLowerCase().includes(q) ||
        p.sender_id.toLowerCase().includes(q),
    );
  }, [filter, participants]);

  async function openParticipant(p: Participant) {
    setSelected(p);
    setMsgs(null);
    loadMsgs(p);
  }

  const filteredGroups = useMemo(() => groups, [groups]);

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="size-6" /> Group participants
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            All groups and participants update in real time from WhatsApp.
          </p>
          {!connected && (
            <p className="text-xs text-muted-foreground mt-1">No WhatsApp account connected.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Radio className="size-3 text-green-500" />
              Updated {lastRefresh.toLocaleTimeString("en-US")}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => (groupId ? loadParticipants(groupId) : loadGroups())}
            disabled={loadingParts}
          >
            <RefreshCw className={`size-3 ms-1 ${loadingParts ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                disabled={loadingGroups}
                className="w-full justify-between font-normal"
              >
                <span className="truncate">
                  {loadingGroups
                    ? "Loading groups from WhatsApp…"
                    : groupId
                    ? groups.find((g) => g.whapi_chat_id === groupId)?.name ?? "Select a group"
                    : `Select a group (${groups.length})`}
                </span>
                <ChevronsUpDown className="size-4 opacity-50 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
              <Command
                filter={(value, search) =>
                  value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                }
              >
                <CommandInput placeholder="Search a group…" />
                <CommandList>
                  <CommandEmpty>No groups found.</CommandEmpty>
                  <CommandGroup>
                    {groups.map((g) => (
                      <CommandItem
                        key={g.whapi_chat_id}
                        value={`${g.name} ${g.whapi_chat_id}`}
                        onSelect={() => setGroupId(g.whapi_chat_id)}
                      >
                        <Check
                          className={cn(
                            "size-4 ms-2",
                            groupId === g.whapi_chat_id ? "opacity-100" : "opacity-0",
                          )}
                        />
                        {g.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <Input
          placeholder="Filter participants…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="sm:max-w-xs"
          disabled={!groupId}
        />
        {groupId && (
          <Button
            variant="default"
            onClick={() => loadParticipants(groupId)}
            disabled={loadingParts}
          >
            <RefreshCw className={`size-4 ms-1 ${loadingParts ? "animate-spin" : ""}`} />
            Refresh group
          </Button>
        )}
      </div>

      <Alert>
        <AlertTriangle className="size-4" />
        <AlertTitle>
          {fullHistory === true
            ? "Full history active"
            : "Sync full history from WhatsApp"}
        </AlertTitle>
        <AlertDescription className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <span>
            To manage full history and the WhatsApp connection — see the <strong>Instructions</strong> page.
          </span>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={resetPipeline}
              disabled={resetting || reconnecting || enablingHistory}
              variant="default"
            >
              <RefreshCw className={`size-3 ms-1 ${resetting ? "animate-spin" : ""}`} />
              Reset all data flow
            </Button>
            <Button
              size="sm"
              onClick={enableFullHistory}
              disabled={enablingHistory || reconnecting || resetting}
              variant="outline"
            >
              <RefreshCw className={`size-3 ms-1 ${enablingHistory ? "animate-spin" : ""}`} />
              {fullHistory === true ? "Enable again" : "Enable full history"}
            </Button>
            <Button
              size="sm"
              onClick={reconnectWhatsApp}
              disabled={reconnecting || enablingHistory || resetting}
              variant="outline"
            >
              <RefreshCw className={`size-3 ms-1 ${reconnecting ? "animate-spin" : ""}`} />
              Reconnect with QR
            </Button>
          </div>
        </AlertDescription>
      </Alert>

      {qrImage && (
        <Alert>
          <AlertTitle>Scan the QR to re-authorize the connection</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Open WhatsApp on your phone → Linked devices → Link a device, and scan the code. After connecting, the history will start syncing.</p>
            <img src={qrImage} alt="QR for WhatsApp connection" className="w-64 max-w-full rounded-lg border bg-background p-2" />
          </AlertDescription>
        </Alert>
      )}

      {historyNotice && (
        <Alert>
          <AlertDescription className="whitespace-pre-line">{historyNotice}</AlertDescription>
        </Alert>
      )}


      {groupId && (
        <>

          <div className="text-sm text-muted-foreground">
            {groupName} · {participantsCount} participants in the group · {participants.length} known · {messagesScanned} messages available in the connection
          </div>
          <div className="border rounded-lg overflow-hidden bg-card">
            {loadingParts && participants.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Loading participants…</div>
            ) : participants.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No participants found.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-left">Participant</TableHead>
                    <TableHead className="text-left">ID</TableHead>
                    <TableHead className="text-left"># Messages</TableHead>
                    <TableHead className="text-left">Last message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((p) => (
                    <TableRow
                      key={p.sender_id || p.sender_name}
                      className="cursor-pointer"
                      onClick={() => openParticipant(p)}
                    >
                      <TableCell className="font-medium">{p.sender_name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground" dir="ltr">
                        {p.sender_id}
                      </TableCell>
                      <TableCell>{p.message_count}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.last_message_at ? new Date(p.last_message_at).toLocaleString("en-US") : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="left" className="w-full sm:max-w-xl flex flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              {selected?.sender_name}
            </SheetTitle>
            <SheetDescription>
              Messages in group {groupName} ({msgs?.length ?? 0})
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-auto mt-4 space-y-2 pl-1">
            {loadingMsgs && <div className="text-sm text-muted-foreground">Loading messages…</div>}
            {!loadingMsgs && msgs?.length === 0 && (
              <div className="text-sm text-muted-foreground">No messages available.</div>
            )}
            {msgs?.map((m) => (
              <div key={m.id} className="rounded-lg border bg-muted/30 px-3 py-2">
                <div className="text-[11px] text-muted-foreground mb-1 flex items-center justify-between">
                  <span>{new Date(m.created_at).toLocaleString("en-US")}</span>
                  <span className="opacity-60">{m.source === "live" ? "WhatsApp" : "DB"}</span>
                </div>
                <div className="text-sm whitespace-pre-wrap break-words">{m.body || "—"}</div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
