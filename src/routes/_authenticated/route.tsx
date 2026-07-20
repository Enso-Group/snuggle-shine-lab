import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Send, Settings as SettingsIcon, ScrollText, LayoutDashboard, LogOut, Bot, Users, CalendarClock, Inbox, Gauge, UserSearch, BookOpen, UserCog, ShieldX } from "lucide-react";
import { isAdminEmail } from "@/lib/admin";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { next: location.pathname } });
    }
    // Invite-only access model:
    //  - admin: identified purely by email (sees the behind-the-scenes pages,
    //    and is always allowed in).
    //  - invited: their email is present in the invited_emails table.
    //  - not invited: signed in but not on the list -> shown a "not invited"
    //    screen. No sign-out/redirect here, so nobody gets stuck in a loop.
    const email = (data.user.email ?? "").trim().toLowerCase();
    const isAdmin = isAdminEmail(email);
    let invited = isAdmin;
    if (!invited && email) {
      const { data: inviteRow } = await (supabase as any)
        .from("invited_emails")
        .select("email")
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      invited = !!inviteRow;
    }
    return { user: data.user, isAdmin, invited };
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
  const { isAdmin, invited, user } = Route.useRouteContext();

  async function signOut() {
    await supabase.auth.signOut();
    nav({ to: "/auth", search: { next: "/" } });
  }

  // Signed in with Google, but the email isn't on the invite list.
  if (!invited) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <ShieldX className="size-6 text-destructive" />
            </div>
            <CardTitle className="text-2xl">You're not on the invite list</CardTitle>
            <CardDescription>
              This dashboard is invite-only.
              {user?.email ? (
                <>
                  {" "}The account <strong className="text-foreground">{user.email}</strong> hasn't been invited.
                </>
              ) : null}
              {" "}Ask the administrator to add your email, then sign in again.
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
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="p-4 border-b border-sidebar-border flex items-center gap-3">
          <div className="size-9 rounded-lg bg-brand text-brand-foreground flex items-center justify-center shrink-0">
            <Bot className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold text-sm leading-tight truncate">WhatsApp Bot</h1>
            <p className="text-xs text-sidebar-foreground/70 truncate">Management Dashboard</p>
          </div>
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
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium shadow-sm"
                    : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon className="size-4" />
                {n.label}
              </Link>
            );
          })}

          {isAdmin && (
            <>
              <div className="pt-4 pb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/60">
                Behind the scenes
              </div>
              {SYSTEM_NAV.map((n) => {
                const Icon = n.icon;
                const active = pathname === n.to || ((n.to as string) !== "/" && pathname.startsWith(n.to));
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                      active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium shadow-sm"
                    : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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
        <div className="p-2 border-t border-sidebar-border">
          <Button variant="ghost" className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={signOut}>
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
