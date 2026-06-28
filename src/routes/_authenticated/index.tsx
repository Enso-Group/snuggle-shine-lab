import { createFileRoute, useServerFn } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardStats, checkIsAdmin } from "@/lib/bot.functions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MessageSquare, Users, Send } from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "סקירה — בוט WhatsApp" }] }),
  component: Dashboard,
});

function Dashboard() {
  const statsFn = useServerFn(getDashboardStats);
  const adminFn = useServerFn(checkIsAdmin);

  const admin = useQuery({ queryKey: ["isAdmin"], queryFn: () => adminFn() });
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => statsFn(),
    enabled: admin.data?.isAdmin === true,
    refetchInterval: 10000,
  });

  if (admin.isLoading) return <div className="p-8">טוען...</div>;
  if (!admin.data?.isAdmin) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertDescription>
            אין לך הרשאת מנהל. רק המשתמש הראשון שנרשם הופך למנהל. אם זה לא את — צרי קשר עם המנהל הקיים.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">סקירה</h1>
        <p className="text-muted-foreground mt-1">סטטוס הבוט שלך במבט אחד</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard icon={Users} label="שיחות" value={stats.data?.conversations ?? 0} />
        <StatCard icon={MessageSquare} label="הודעות" value={stats.data?.messages ?? 0} />
        <StatCard icon={Send} label="פקודות שנשלחו" value={stats.data?.commands ?? 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>איך להתחיל?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>1. גשי ל-<a href="https://whapi.cloud" target="_blank" className="text-primary underline">whapi.cloud</a> ופתחי trial חינמי (5 ימים)</p>
          <p>2. סרקי QR עם המספר החדש שלך</p>
          <p>3. העתיקי את ה-API Token והכניסי אותו בעמוד <strong>הגדרות</strong></p>
          <p>4. הגדירי את ה-Webhook URL ב-Whapi (תמצאי אותו בהגדרות)</p>
          <p>5. הבוט יתחיל לענות אוטומטית 🚀</p>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-6 flex items-center gap-4">
        <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon className="size-6 text-primary" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
