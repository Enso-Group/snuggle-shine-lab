import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";

export const Route = createFileRoute("/_authenticated/conversations/$id")({
  component: ConvView,
});

type Msg = { id: string; direction: string; sender_name: string | null; body: string | null; created_at: string };

function ConvView() {
  const { id } = Route.useParams();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [conv, setConv] = useState<{ name: string | null; whapi_chat_id: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [{ data: c }, { data: m }] = await Promise.all([
        supabase.from("conversations").select("name, whapi_chat_id").eq("id", id).maybeSingle(),
        supabase.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: true }).limit(500),
      ]);
      if (!mounted) return;
      setConv(c as any);
      setMsgs((m ?? []) as Msg[]);
    }
    load();
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
  }, [id]);

  return (
    <div className="flex flex-col h-screen">
      <div className="p-4 border-b bg-card">
        <h2 className="font-semibold">{conv?.name || conv?.whapi_chat_id || "שיחה"}</h2>
        <p className="text-xs text-muted-foreground">{conv?.whapi_chat_id}</p>
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-2 max-w-2xl mx-auto">
          {msgs.map((m) => {
            const out = m.direction === "outbound";
            return (
              <div key={m.id} className={`flex ${out ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[70%] rounded-lg px-3 py-2 ${out ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  {m.sender_name && !out && <p className="text-xs font-semibold mb-1 opacity-75">{m.sender_name}</p>}
                  <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                  <p className="text-[10px] opacity-60 mt-1">{new Date(m.created_at).toLocaleTimeString("he-IL")}</p>
                </div>
              </div>
            );
          })}
          {msgs.length === 0 && <p className="text-center text-muted-foreground py-12">אין הודעות בשיחה</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
