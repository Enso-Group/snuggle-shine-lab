import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { syncConversationHistory } from "@/lib/participants.functions";
import { Loader2, Users, User } from "lucide-react";
import { DEMO_MODE, demoConversationMessages, demoConversationMeta } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/conversations/$id")({
  component: ConvView,
});

type Msg = { id: string; direction: string; sender_name: string | null; body: string | null; created_at: string };

function ConvView() {
  const { id } = Route.useParams();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [conv, setConv] = useState<{ name: string | null; whapi_chat_id: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const sync = useServerFn(syncConversationHistory);

  useEffect(() => {
    if (DEMO_MODE) {
      setConv(demoConversationMeta(id));
      setMsgs(demoConversationMessages(id) as Msg[]);
      return;
    }
    let mounted = true;
    async function loadMessages() {
      const { data: m } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
        .limit(5000);
      if (mounted) setMsgs((m ?? []) as Msg[]);
    }
    async function run() {
      const { data: c } = await supabase
        .from("conversations")
        .select("name, whapi_chat_id")
        .eq("id", id)
        .maybeSingle();
      if (!mounted) return;
      setConv(c as any);
      await loadMessages();
      setSyncing(true);
      try {
        await sync({ data: { conversationId: id } });
      } catch (e) {
        console.error("sync history failed", e);
      }
      if (!mounted) return;
      await loadMessages();
      setSyncing(false);
    }
    run();
    const ch = supabase
      .channel("conv-" + id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }, (payload) => {
        setMsgs((prev) => [...prev, payload.new as Msg]);
      })
      .subscribe();
    return () => {
      mounted = false;
      supabase.removeChannel(ch);
    };
  }, [id, sync]);

  return (
    <div className="flex flex-col h-screen">
      <div className="p-4 border-b bg-card flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {conv?.whapi_chat_id?.endsWith("@g.us") ? <Users className="size-4" /> : <User className="size-4" />}
          </div>
          <div className="min-w-0">
            <h2 className="truncate font-semibold leading-tight">{conv?.name || conv?.whapi_chat_id || "Chat"}</h2>
            <p className="truncate text-xs text-muted-foreground" dir="ltr">{conv?.whapi_chat_id}</p>
          </div>
        </div>
        {syncing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading history...
          </div>
        )}
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-2 max-w-2xl mx-auto">
          {msgs.map((m) => {
            const out = m.direction === "outbound";
            return (
              <div key={m.id} className={`flex ${out ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[70%] rounded-2xl px-3 py-2 shadow-sm ${out ? "bg-bubble-sent text-bubble-sent-foreground" : "bg-bubble-received text-bubble-received-foreground border"}`}>
                  {m.sender_name && !out && <p className="text-xs font-semibold mb-1 opacity-75">{m.sender_name}</p>}
                  <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                  <p className="text-[10px] opacity-60 mt-1">{new Date(m.created_at).toLocaleTimeString("en-US")}</p>
                </div>
              </div>
            );
          })}
          {msgs.length === 0 && <p className="text-center text-muted-foreground py-12">No messages in this chat</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
