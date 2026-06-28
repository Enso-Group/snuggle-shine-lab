import { createFileRoute, Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, MessageCircle } from "lucide-react";
import {
  listThreads,
  createThread,
  deleteThread,
} from "@/lib/chat.functions";

export const Route = createFileRoute("/_authenticated/chat")({
  ssr: false,
  component: ChatLayout,
});

type Thread = { id: string; title: string; mode: string; updated_at: string };

const MODE_LABEL: Record<string, string> = {
  "test-bot": "🤖 בדיקה",
  admin: "📊 ניהול",
  general: "💬 כללי",
};

function ChatLayout() {
  const nav = useNavigate();
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const list = await listThreads();
      setThreads(list as Thread[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function newThread(mode: "test-bot" | "admin" | "general") {
    const t = await createThread({ data: { mode } });
    await refresh();
    nav({ to: "/chat/$threadId", params: { threadId: t.id } });
  }

  async function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!confirm("למחוק את השיחה?")) return;
    await deleteThread({ data: { id } });
    await refresh();
    router.invalidate();
    nav({ to: "/chat" });
  }

  return (
    <div className="flex h-screen">
      <aside className="w-64 border-l bg-card flex flex-col">
        <div className="p-3 border-b space-y-2">
          <div className="text-sm font-semibold">שיחות חדשות</div>
          <div className="grid grid-cols-3 gap-1">
            <Button size="sm" variant="outline" onClick={() => newThread("general")} title="שיחה כללית">
              💬
            </Button>
            <Button size="sm" variant="outline" onClick={() => newThread("test-bot")} title="בדוק את הבוט">
              🤖
            </Button>
            <Button size="sm" variant="outline" onClick={() => newThread("admin")} title="שאל על המערכת">
              📊
            </Button>
          </div>
          <Button size="sm" className="w-full" onClick={() => newThread("general")}>
            <Plus className="size-3 ms-1" /> שיחה חדשה
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {loading && <div className="text-xs text-muted-foreground p-2">טוען…</div>}
          {!loading && threads.length === 0 && (
            <div className="text-xs text-muted-foreground p-2">אין שיחות עדיין</div>
          )}
          {threads.map((t) => (
            <Link
              key={t.id}
              to="/chat/$threadId"
              params={{ threadId: t.id }}
              className="group flex items-center gap-2 px-2 py-2 rounded-md text-sm hover:bg-accent [&.active]:bg-primary [&.active]:text-primary-foreground"
              activeProps={{ className: "active" }}
            >
              <MessageCircle className="size-3 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="truncate">{t.title}</div>
                <div className="text-[10px] opacity-70">{MODE_LABEL[t.mode] ?? t.mode}</div>
              </div>
              <button
                onClick={(e) => remove(t.id, e)}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive"
                aria-label="מחק"
              >
                <Trash2 className="size-3" />
              </button>
            </Link>
          ))}
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
