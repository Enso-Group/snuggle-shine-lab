import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Bot } from "lucide-react";
import { getThreadMessages, sendChatMessage } from "@/lib/chat.functions";
import { DEMO_MODE, demoThreadMessages } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  ssr: false,
  component: ChatThread,
});

type Msg = { id: string; role: "user" | "assistant"; content: string; created_at: string };
type Thread = { id: string; title: string; mode: string };

const MODE_LABEL: Record<string, string> = {
  "test-bot": "🤖 Bot test (replies like on WhatsApp)",
  admin: "📊 Admin questions about the system",
  general: "💬 General AI assistant",
};

function ChatThread() {
  const { threadId } = Route.useParams();
  const router = useRouter();
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    if (DEMO_MODE) {
      const r = demoThreadMessages(threadId);
      setThread(r.thread as Thread);
      setMessages(r.messages as Msg[]);
      setLoading(false);
      return;
    }
    try {
      const r = await getThreadMessages({ data: { threadId } });
      setThread(r.thread as Thread);
      setMessages(r.messages as Msg[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    taRef.current?.focus();
  }, [threadId, sending]);

  async function send() {
    const content = input.trim();
    if (!content || sending) return;
    setInput("");
    const optimistic: Msg = {
      id: "tmp-" + Date.now(),
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setSending(true);
    if (DEMO_MODE) {
      await new Promise((r) => setTimeout(r, 700));
      setMessages((m) => [
        ...m,
        {
          id: "demo-reply-" + Date.now(),
          role: "assistant",
          content: "Sure! This is a demo — this is how the bot would reply to your message, naturally and briefly 🙂",
          created_at: new Date().toISOString(),
        },
      ]);
      setSending(false);
      return;
    }
    try {
      await sendChatMessage({ data: { threadId, content } });
      await load();
      router.invalidate();
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        {
          id: "err-" + Date.now(),
          role: "assistant",
          content: `Error: ${String(e?.message ?? e)}`,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center gap-3 border-b bg-card px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">{thread?.title ?? "…"}</div>
          <div className="truncate text-xs text-muted-foreground">
            {thread ? MODE_LABEL[thread.mode] ?? thread.mode : ""}
          </div>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
        {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-sm text-muted-foreground text-center mt-12">
            Start by sending a message below ↓
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-end">
            <div className="bg-muted rounded-2xl px-4 py-2 text-sm text-muted-foreground">
              Thinking…
            </div>
          </div>
        )}
      </div>

      <div className="border-t p-3 bg-card">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask me anything…"
            rows={2}
            disabled={sending}
            className="resize-none"
          />
          <Button onClick={send} disabled={sending || !input.trim()} size="icon">
            <Send className="size-4" />
          </Button>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          Enter to send · Shift+Enter for a new line
        </div>
      </div>
    </div>
  );
}
