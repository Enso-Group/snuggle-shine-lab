import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Send, Settings as SettingsIcon, ScrollText, LayoutDashboard, LogOut, Bot, Users, CalendarClock, Inbox, Gauge, UserSearch, BookOpen, UserCog } from "lucide-react";
import { isAdminEmail } from "@/lib/admin";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { next: location.pathname } });
    }
    // Access model:
    //  - admin: identified purely by email (sees the behind-the-scenes pages).
    //  - approved: has any row in user_roles (granted when the admin approves).
    //  - pending: signed in but no role row yet -> shown a "pending" screen.
    // No sign-out/redirect here, so nobody gets stuck in a login loop.
    const isAdmin = isAdminEmail(data.user.email);
    let approved = isAdmin;
    if (!approved) {
      const { data: roleRow } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("user_id", data.user.id)
        .limit(1)
        .maybeSingle();
      approved = !!roleRow;
    }
    return { user: data.user, isAdmin, approved };
  },
  component: AuthedLayout,
});


const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/conversations", label: "Chats", icon: MessageSquare },
  { to: "/participants", label: "Participants", icon: Users },
  { to: "/chat", label: "AI Chat", icon: Bot },
  { to: "/send", label: "Send Message", icon: Send },
  { to: "/schedule", label: "Weekly Scheduler", icon: CalendarClock },
  { to: "/approvals", label: "Approvals", icon: Inbox },
  { to: "/candidates", label: "Candidates", icon: UserSearch },
] as const;

// Behind-the-scenes / system pages — admin only.
const SYSTEM_NAV = [
  { to: "/user-management", label: "User Management", icon: UserCog },
  { to: "/instructions", label: "Instructions", icon: BookOpen },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
  { to: "/usage", label: "Usage & Costs", icon: Gauge },
  { to: "/logs", label: "Logs", icon: ScrollText },
] as const;

function AuthedLayout() {
  const nav = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isAdmin, approved } = Route.useRouteContext();

  async function signOut() {
    await supabase.auth.signOut();
    nav({ to: "/auth" });
  }

  // Signed in but not yet approved by the admin.
  if (!approved) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle className="text-2xl">Awaiting approval</CardTitle>
            <CardDescription>
              Your account was created and is waiting for the administrator to approve it.
              You'll be able to access the dashboard once it's approved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={signOut}>
              <LogOut className="size-4 ms-2" />
              Log out
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div dir="rtl" className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 border-l bg-card flex flex-col">
        <div className="p-4 border-b">
          <h1 className="font-bold text-lg">🤖 WhatsApp Bot</h1>
          <p className="text-xs text-muted-foreground mt-1">Management Dashboard</p>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-auto">
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

          {isAdmin && (
            <>
              <div className="pt-4 pb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Behind the scenes
              </div>
              {SYSTEM_NAV.map((n) => {
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
            </>
          )}
        </nav>
        <div className="p-2 border-t">
          <Button variant="ghost" className="w-full justify-start" onClick={signOut}>
            <LogOut className="size-4 ms-2" />
            Log out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
