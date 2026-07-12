import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";
import { getThreadMessages, sendChatMessage } from "@/lib/chat.functions";
import { DEMO_MODE, demoThreadMessages } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  ssr: false,
  component: ChatThread,
});

type Msg = { id: string; role: "user" | "assistant"; content: string; created_at: string };
type Thread = { id: string; title: string; mode: string };

const MODE_LABEL: Record<string, string> = {
  "test-bot": "🤖 בדיקת הבוט (משיב כמו ב-WhatsApp)",
  admin: "📊 שאלות ניהול על המערכת",
  general: "💬 עוזר AI כללי",
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
          content: "בטח! זו תצוגת דמו — כך הבוט היה משיב על ההודעה שלך בצורה טבעית וקצרה 🙂",
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
          content: `שגיאה: ${String(e?.message ?? e)}`,
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
      <header className="border-b px-4 py-3 bg-card">
        <div className="font-semibold text-sm truncate">{thread?.title ?? "…"}</div>
        <div className="text-xs text-muted-foreground">
          {thread ? MODE_LABEL[thread.mode] ?? thread.mode : ""}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
        {loading && <div className="text-sm text-muted-foreground">טוען…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-sm text-muted-foreground text-center mt-12">
            התחל בשליחת הודעה למטה ↓
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
              חושב…
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
            placeholder="שאל אותי משהו…"
            rows={2}
            disabled={sending}
            className="resize-none"
          />
          <Button onClick={send} disabled={sending || !input.trim()} size="icon">
            <Send className="size-4" />
          </Button>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          Enter לשליחה · Shift+Enter לשורה חדשה
        </div>
      </div>
    </div>
  );
}
