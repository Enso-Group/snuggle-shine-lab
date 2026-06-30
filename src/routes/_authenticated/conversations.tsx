import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Users, User } from "lucide-react";

export const Route = createFileRoute("/_authenticated/conversations")({
  head: () => ({ meta: [{ title: "שיחות — בוט WhatsApp" }] }),
  component: ConvLayout,
});

type Conv = { id: string; name: string | null; whapi_chat_id: string; is_group: boolean; last_message_at: string | null };

function ConvLayout() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const path = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    let mounted = true;
    async function load() {
      // Only show conversations the user actually participated in:
      // - direct chats (1:1) that have any message
      // - groups where the user sent at least one outbound message
      const [{ data: directs }, { data: outboundRows }] = await Promise.all([
        supabase
          .from("conversations")
          .select("*")
          .eq("is_group", false)
          .not("last_message_at", "is", null),
        supabase
          .from("messages")
          .select("conversation_id")
          .eq("direction", "outbound"),
      ]);
      const outboundConvIds = [...new Set((outboundRows ?? []).map((r: any) => r.conversation_id).filter(Boolean))];
      let groups: Conv[] = [];
      if (outboundConvIds.length) {
        const { data } = await supabase
          .from("conversations")
          .select("*")
          .eq("is_group", true)
          .in("id", outboundConvIds);
        groups = (data ?? []) as Conv[];
      }
      const merged = [...((directs ?? []) as Conv[]), ...groups].sort((a, b) => {
        const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
        const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
        return tb - ta;
      });
      if (mounted) setConvs(merged);
    }
    load();
    const ch = supabase
      .channel("conv-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, load)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, load)
      .subscribe();
    return () => {
      mounted = false;
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="flex h-screen">
      <div className="w-80 border-l bg-card flex flex-col">
        <div className="p-4 border-b">
          <h2 className="font-semibold">שיחות ({convs.length})</h2>
        </div>
        <ScrollArea className="flex-1">
          {convs.length === 0 && <p className="p-4 text-sm text-muted-foreground">אין שיחות עדיין. כשמישהו ישלח הודעה לבוט, היא תופיע כאן.</p>}
          {convs.map((c) => {
            const active = path.endsWith("/" + c.id);
            return (
              <Link
                key={c.id}
                to="/conversations/$id"
                params={{ id: c.id }}
                className={`flex items-center gap-3 p-3 border-b hover:bg-accent transition-colors ${active ? "bg-accent" : ""}`}
              >
                <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center">
                  {c.is_group ? <Users className="size-5" /> : <User className="size-5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.name || c.whapi_chat_id}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {c.last_message_at ? new Date(c.last_message_at).toLocaleString("he-IL") : "—"}
                  </p>
                </div>
                {c.is_group && <Badge variant="secondary" className="text-xs">קבוצה</Badge>}
              </Link>
            );
          })}
        </ScrollArea>
      </div>
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}
