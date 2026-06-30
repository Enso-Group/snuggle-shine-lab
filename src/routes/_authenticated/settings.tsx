import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getBotSettings, updateBotSettings, checkWhapiConnection } from "@/lib/bot.functions";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "הגדרות — בוט WhatsApp" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getBotSettings);
  const upFn = useServerFn(updateBotSettings);
  const checkFn = useServerFn(checkWhapiConnection);

  const { data: settings, isLoading } = useQuery({ queryKey: ["botSettings"], queryFn: () => getFn() });

  const [systemPrompt, setSystemPrompt] = useState("");
  const [botName, setBotName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [requireApprovalAll, setRequireApprovalAll] = useState(false);

  useEffect(() => {
    if (settings) {
      setSystemPrompt(settings.system_prompt);
      setBotName(settings.bot_name);
      setEnabled(settings.enabled);
      setRequireApprovalAll((settings as any).require_approval_all ?? false);
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      upFn({ data: { id: settings!.id, system_prompt: systemPrompt, bot_name: botName, enabled, require_approval_all: requireApprovalAll } }),
    onSuccess: () => {
      toast.success("נשמר!");
      qc.invalidateQueries({ queryKey: ["botSettings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const check = useMutation({
    mutationFn: () => checkFn(),
    onSuccess: (r) => {
      if (r.ok) toast.success(`חיבור תקין! סטטוס: ${r.status ?? "אונליין"}`);
      else toast.error(`חיבור נכשל: ${r.error}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/public/whapi-webhook` : "";

  if (isLoading) return <div className="p-8">טוען...</div>;

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold">הגדרות</h1>
        <p className="text-muted-foreground mt-1">הגדרות הבוט והחיבור ל-Whapi</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>חיבור ל-Whapi</CardTitle>
          <CardDescription>הטוקן נשמר בצורה מאובטחת בשרת (לא ניתן לראות אותו דרך הדפדפן)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="space-y-2">
              <p><strong>שלבים להגדרה:</strong></p>
              <ol className="list-decimal pr-5 space-y-1">
                <li>היכנסי ל-<a href="https://whapi.cloud" target="_blank" className="text-primary underline">whapi.cloud</a> וצרי Channel חדש</li>
                <li>סרקי QR עם המספר החדש שלך</li>
                <li>העתיקי את ה-API Token והוסיפי אותו כסוד בשם <code className="bg-muted px-1 rounded">WHAPI_TOKEN</code> דרך כפתור "הוסף סוד" למטה</li>
                <li>ב-Whapi → Settings → Webhook הזיני את הכתובת הזו:</li>
              </ol>
              <div className="mt-2 p-2 bg-muted rounded text-xs font-mono break-all" dir="ltr">{webhookUrl}</div>
              <p className="text-xs">בחרי events: <code>messages</code></p>
            </AlertDescription>
          </Alert>
          <Button onClick={() => check.mutate()} disabled={check.isPending} variant="outline">
            {check.isPending ? "בודק..." : "בדוק חיבור"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>אישיות הבוט</CardTitle>
          <CardDescription>איך הבוט ידבר וענה. שינוי משפיע מיד על הודעות חדשות.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 border rounded-md">
            <div>
              <Label>הבוט פעיל</Label>
              <p className="text-xs text-muted-foreground">כשמכובה — הוא לא יענה אבל ימשיך לשמור הודעות</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between p-3 border rounded-md border-amber-500/50 bg-amber-50/30 dark:bg-amber-950/10">
            <div>
              <Label>דרוש אישור לכל הודעה יוצאת</Label>
              <p className="text-xs text-muted-foreground">
                כשמופעל, כל הודעה שהבוט רוצה לשלוח (תשובה, תזמון או ידנית) תיכנס לעמוד "אישור הודעות" עם שלח / ערוך / מחק.
              </p>
            </div>
            <Switch checked={requireApprovalAll} onCheckedChange={setRequireApprovalAll} />
          </div>
          <div>
            <Label htmlFor="botName">שם הבוט (לזיהוי בקבוצות)</Label>
            <Input id="botName" value={botName} onChange={(e) => setBotName(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">בקבוצות, הבוט יענה רק אם מישהו מזכיר את השם הזה או מתייג אותו</p>
          </div>
          <div>
            <Label htmlFor="prompt">סגנון ואישיות (system prompt)</Label>
            <Textarea
              id="prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              טיפ נגד חסימה: בקשי מהבוט לכתוב קצר, טבעי, עם וריאציות, ולא להגיב לכל הודעה.
            </p>
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "שומר..." : "שמירה"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
