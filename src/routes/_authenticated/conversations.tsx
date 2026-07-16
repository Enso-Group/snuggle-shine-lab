import { createFileRoute, Link, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, User, Trash2, MessageSquare } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { toast } from "sonner";
import { useWhatsAppConnection } from "@/hooks/use-connection";
import { deleteConversation } from "@/lib/conversations.functions";
import { DEMO_MODE, demoConversations } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/conversations")({
  head: () => ({ meta: [{ title: "Chats — WhatsApp Bot" }] }),
  component: ConvLayout,
});

type Conv = { id: string; name: string | null; whapi_chat_id: string; is_group: boolean; last_message_at: string | null };

function ConvLayout() {
  const { connected, isLoading: connLoading } = useWhatsAppConnection();
  const [convs, setConvs] = useState<Conv[]>([]);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const nav = useNavigate();
  const deleteFn = useServerFn(deleteConversation);

  // Only show conversations the user actually participated in:
  // - direct chats (1:1) that have any message
  // - groups where the user sent at least one outbound message
  const load = useCallback(async () => {
    if (DEMO_MODE) {
      setConvs(demoConversations as Conv[]);
      return;
    }
    if (!connected) {
      setConvs([]);
      return;
    }
    const [{ data: directs }, { data: outboundRows }] = await Promise.all([
      supabase
        .from("conversations")
        .select("*")
        .eq("is_group", false)
        .not("last_message_at", "is", null),
      supabase.from("messages").select("conversation_id").eq("direction", "outbound"),
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
    setConvs(merged);
  }, [connected]);

  useEffect(() => {
    load();
    if (DEMO_MODE || !connected) return;
    const ch = supabase
      .channel("conv-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, load)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [connected, load]);

  async function handleDelete(e: React.MouseEvent, c: Conv) {
    e.preventDefault();
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete the chat "${c.name || c.whapi_chat_id}"? This will also delete all messages in the chat and cannot be undone.`,
      )
    )
      return;
    // Optimistic removal; reconcile from the server on failure.
    setConvs((prev) => prev.filter((x) => x.id !== c.id));
    if (DEMO_MODE) {
      toast.success("Chat deleted");
      if (path.endsWith("/" + c.id)) nav({ to: "/conversations" });
      return;
    }
    try {
      await deleteFn({ data: { id: c.id } });
      toast.success("Chat deleted");
      if (path.endsWith("/" + c.id)) nav({ to: "/conversations" });
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to delete the chat");
      load();
    }
  }

  return (
    <div className="flex h-screen">
      <div className="w-80 border-r bg-card flex flex-col">
        <div className="flex items-center gap-3 border-b p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <MessageSquare className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">Chats</h2>
            <p className="text-xs text-muted-foreground">
              {!connected && !connLoading ? "No WhatsApp account connected" : `${convs.length} conversations`}
            </p>
          </div>
        </div>
        <ScrollArea className="flex-1">
          {convs.length === 0 && (
            <EmptyState
              icon={MessageSquare}
              title="No chats yet"
              description="When someone messages the bot, it will appear here."
            />
          )}
          {convs.map((c) => {
            const active = path.endsWith("/" + c.id);
            return (
              <div
                key={c.id}
                className={`group flex items-center border-b hover:bg-accent transition-colors ${active ? "bg-accent" : ""}`}
              >
                <Link
                  to="/conversations/$id"
                  params={{ id: c.id }}
                  className="flex items-center gap-3 p-3 flex-1 min-w-0"
                >
                  <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    {c.is_group ? <Users className="size-5" /> : <User className="size-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{c.name || c.whapi_chat_id}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.last_message_at ? new Date(c.last_message_at).toLocaleString("en-US") : "—"}
                    </p>
                  </div>
                  {c.is_group && <Badge variant="secondary" className="text-xs shrink-0">Group</Badge>}
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="me-1 size-8 shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100"
                  title="Delete chat"
                  aria-label="Delete chat"
                  onClick={(e) => handleDelete(e, c)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
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
