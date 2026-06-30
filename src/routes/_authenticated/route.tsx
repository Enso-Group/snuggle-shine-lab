import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { MessageSquare, Send, Settings as SettingsIcon, ScrollText, LayoutDashboard, LogOut, Bot, Users, CalendarClock, Inbox, Gauge, UserSearch } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { next: location.pathname } });
    }
    return { user: data.user };
  },
  component: AuthedLayout,
});


// Simple Telegram icon (inline SVG, no extra deps)
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
  );
}

const NAV = [
  { to: "/", label: "סקירה", icon: LayoutDashboard },
  { to: "/conversations", label: "שיחות", icon: MessageSquare },
  { to: "/participants", label: "משתתפים", icon: Users },
  { to: "/chat", label: "צ'אט AI", icon: Bot },
  { to: "/send", label: "שלח הודעה", icon: Send },
  { to: "/schedule", label: "תזמון שבועי", icon: CalendarClock },
  { to: "/approvals", label: "אישור הודעות", icon: Inbox },
  { to: "/usage", label: "שימוש ועלויות", icon: Gauge },
  { to: "/settings", label: "הגדרות", icon: SettingsIcon },
  { to: "/logs", label: "לוגים", icon: ScrollText },
  { to: "/telegram", label: "Telegram", icon: TelegramIcon },
  { to: "/candidates", label: "מועמדים", icon: UserSearch },
] as const;

function AuthedLayout() {
  const nav = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  async function signOut() {
    await supabase.auth.signOut();
    nav({ to: "/auth" });
  }

  return (
    <div dir="rtl" className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 border-l bg-card flex flex-col">
        <div className="p-4 border-b">
          <h1 className="font-bold text-lg">🤖 בוט WhatsApp</h1>
          <p className="text-xs text-muted-foreground mt-1">דשבורד ניהול</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = pathname === n.to || (n.to !== "/" && pathname.startsWith(n.to));
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  active ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                <Icon className="size-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t">
          <Button variant="ghost" className="w-full justify-start" onClick={signOut}>
            <LogOut className="size-4 ms-2" />
            התנתקות
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
