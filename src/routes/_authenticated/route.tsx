import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { MessageSquare, Send, Settings as SettingsIcon, ScrollText, LayoutDashboard, LogOut, Bot } from "lucide-react";

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

const NAV = [
  { to: "/", label: "סקירה", icon: LayoutDashboard },
  { to: "/conversations", label: "שיחות", icon: MessageSquare },
  { to: "/chat", label: "צ'אט AI", icon: Bot },
  { to: "/send", label: "שלח הודעה", icon: Send },
  { to: "/settings", label: "הגדרות", icon: SettingsIcon },
  { to: "/logs", label: "לוגים", icon: ScrollText },
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
