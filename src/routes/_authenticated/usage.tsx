import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getUsageStats } from "@/lib/usage.functions";
import {
  MessageSquare,
  Send,
  Users,
  CalendarClock,
  Inbox,
  ShieldAlert,
  Bot,
  Clock,
  TrendingUp,
  ExternalLink,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/usage")({
  head: () => ({ meta: [{ title: "שימוש ועלויות — בוט WhatsApp" }] }),
  component: UsagePage,
});

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString("he-IL");
}

function UsagePage() {
  const fn = useServerFn(getUsageStats);
  const q = useQuery({ queryKey: ["usage-stats"], queryFn: () => fn(), refetchInterval: 30000 });

  if (q.isLoading) return <div className="p-8">טוען נתוני שימוש...</div>;
  if (q.error) return <div className="p-8 text-destructive">שגיאה: {String((q.error as any).message)}</div>;
  const s = q.data!;

  const hourPct = Math.min(100, (s.antiBan.distinctChatsLastHour / s.antiBan.maxDistinctChatsPerHour) * 100);

  return (
    <div className="p-8 space-y-8 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold">שימוש ועלויות</h1>
        <p className="text-muted-foreground mt-1">כל המכסות, השימוש בפועל והעלויות במקום אחד</p>
      </div>

      {/* Quick stats */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">סקירה מהירה</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={Users} label="שיחות פעילות" value={s.conversations.total} sub={`${s.conversations.blocked} חסומות`} />
          <StatCard icon={MessageSquare} label="סך הודעות" value={s.messages.total} />
          <StatCard icon={Inbox} label="ממתינות לאישור" value={s.pendingApprovals} />
          <StatCard icon={CalendarClock} label="תזמונים פעילים" value={`${s.scheduled.enabled}/${s.scheduled.total}`} />
        </div>
      </section>

      {/* Message traffic */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold flex items-center gap-2"><TrendingUp className="size-5" /> תעבורת הודעות</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <TrafficCard period="24 שעות אחרונות" inbound={s.messages.inbound24h} outbound={s.messages.outbound24h} />
          <TrafficCard period="7 ימים אחרונים" inbound={s.messages.inbound7d} outbound={s.messages.outbound7d} />
          <TrafficCard period="30 ימים אחרונים" inbound={s.messages.inbound30d} outbound={s.messages.outbound30d} />
        </div>
        <Card>
          <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /> הודעה נכנסת אחרונה: <strong>{fmtDate(s.messages.lastInboundAt)}</strong></div>
            <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /> הודעה יוצאת אחרונה: <strong>{fmtDate(s.messages.lastOutboundAt)}</strong></div>
          </CardContent>
        </Card>
      </section>

      {/* Anti-ban quotas */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold flex items-center gap-2"><ShieldAlert className="size-5" /> מכסות הגנה מחסימה (Anti-Ban)</h2>
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>צ'אטים שונים בשעה האחרונה</span>
                <strong>{s.antiBan.distinctChatsLastHour} / {s.antiBan.maxDistinctChatsPerHour}</strong>
              </div>
              <Progress value={hourPct} />
              {hourPct >= 80 && (
                <p className="text-xs text-amber-600 mt-1">מתקרבים לתקרה — שליחה לאיש קשר חדש תיחסם זמנית.</p>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <LimitItem label="מקסימום הודעות רצופות לאותו צ'אט ללא תשובה" value={s.antiBan.maxConsecutiveOutbound} />
              <LimitItem label="זמן מינימלי בין הודעות לאותו צ'אט" value={`${s.antiBan.minGapMinutes} דק׳`} />
              <LimitItem label="תקרת אנשי קשר חדשים בשעה" value={s.antiBan.maxDistinctChatsPerHour} />
            </div>
            <Alert>
              <AlertDescription className="text-xs space-y-1">
                <div>• אסור לשלוח הודעה ראשונה למי שלא יזם שיחה (Cold contact).</div>
                <div>• מילות "תפסיק/הסר/unsubscribe" חוסמות את איש הקשר אוטומטית.</div>
                <div>• אסור לשלוח את אותו טקסט פעמיים ברצף.</div>
                <div>• שגיאת הגבלה מ-Whapi מפסיקה שליחה ושולחת התראה למנהל.</div>
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </section>

      {/* External services costs */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">שירותים חיצוניים ועלויות</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ServiceCard
            icon={MessageSquare}
            name="Whapi.Cloud"
            desc="חיבור ל-WhatsApp (קבלה ושליחת הודעות)"
            pricing={[
              "Trial: 5 ימים חינם",
              "Sandbox: ~$19/חודש (מוגבל)",
              "Pro: ~$39/חודש (לא מוגבל)",
            ]}
            link="https://whapi.cloud/pricing"
          />
          <ServiceCard
            icon={Bot}
            name="Lovable AI Gateway"
            desc="מודל השפה שעונה אוטומטית (Gemini 2.5 Flash)"
            pricing={[
              "מכסה חודשית חינם בכל workspace",
              "מעבר למכסה נחתך מהקרדיטים",
              "חיפוש אינטרנט: חינם (DuckDuckGo)",
            ]}
            link="https://docs.lovable.dev/integrations/cloud"
          />
          <ServiceCard
            icon={Send}
            name="Lovable Cloud"
            desc="מסד נתונים, אחסון ופונקציות שרת"
            pricing={[
              "40 קרדיטים חינם בחודש (Free/Pro)",
              "20 קרדיטים חינם (Business)",
              "מעבר נחתך מיתרת הקרדיטים",
            ]}
            link="https://docs.lovable.dev/integrations/cloud"
          />
        </div>
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            <strong className="text-foreground">איפה רואים את היתרה?</strong> לחצי על שם ה-workspace בפינה השמאלית-עליונה של Lovable, או היכנסי ל-Settings → Plans & credits.
          </CardContent>
        </Card>
      </section>

      {/* Activity */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">פעילות נוספת (30 ימים)</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StatCard icon={Send} label="פקודות ידניות שנשלחו" value={s.commands30d} />
          <StatCard icon={Inbox} label="בתור אישור כרגע" value={s.pendingApprovals} />
        </div>
      </section>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: any; label: string; value: number | string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-5 flex items-center gap-4">
        <div className="size-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="size-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold leading-tight">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function TrafficCard({ period, inbound, outbound }: { period: string; inbound: number; outbound: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{period}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-between items-center">
          <Badge variant="secondary">נכנסות</Badge>
          <span className="text-xl font-bold">{inbound}</span>
        </div>
        <div className="flex justify-between items-center">
          <Badge>יוצאות</Badge>
          <span className="text-xl font-bold">{outbound}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function LimitItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function ServiceCard({ icon: Icon, name, desc, pricing, link }: { icon: any; name: string; desc: string; pricing: string[]; link: string }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-5 text-primary" /> {name}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="text-sm space-y-1">
          {pricing.map((p, i) => (
            <li key={i} className="flex items-start gap-2"><span className="text-primary">•</span> {p}</li>
          ))}
        </ul>
        <a href={link} target="_blank" rel="noreferrer" className="text-xs text-primary inline-flex items-center gap-1 hover:underline mt-2">
          פרטים <ExternalLink className="size-3" />
        </a>
      </CardContent>
    </Card>
  );
}
