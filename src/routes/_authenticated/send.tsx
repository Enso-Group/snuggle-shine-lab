import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { listWhapiGroups, sendManualMessage } from "@/lib/bot.functions";

function normalizeChatId(input: string): string {
  const v = input.trim();
  if (!v) return "";
  if (v.endsWith("@g.us") || v.endsWith("@s.whatsapp.net") || v.endsWith("@c.us")) return v;
  const digits = v.replace(/[^\d]/g, "");
  if (!digits) return v;
  return `${digits}@s.whatsapp.net`;
}

export const Route = createFileRoute("/_authenticated/send")({
  head: () => ({ meta: [{ title: "שליחה — בוט WhatsApp" }] }),
  component: SendPage,
});

function SendPage() {
  const listFn = useServerFn(listWhapiGroups);
  const sendFn = useServerFn(sendManualMessage);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["whapi-targets"],
    queryFn: () => listFn(),
  });

  const [target, setTarget] = useState<string>("");
  const [manualMode, setManualMode] = useState(false);
  const [manualTarget, setManualTarget] = useState("");
  const [manualName, setManualName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"direct" | "ai">("ai");

  const allTargets = [
    ...(data?.groups ?? []).map((g) => ({ id: g.id, name: `👥 ${g.name}`, type: "group" as const })),
    ...(data?.chats ?? []).filter((c) => !c.id.endsWith("@g.us")).map((c) => ({ id: c.id, name: `👤 ${c.name}`, type: "chat" as const })),
  ];

  const send = useMutation({
    mutationFn: () => {
      if (manualMode) {
        const id = normalizeChatId(manualTarget);
        return sendFn({ data: { target_chat_id: id, target_name: manualName.trim() || id, prompt, mode } });
      }
      const tgt = allTargets.find((t) => t.id === target);
      return sendFn({ data: { target_chat_id: target, target_name: tgt?.name, prompt, mode } });
    },
    onSuccess: () => {
      toast.success("נשלח!");
      setPrompt("");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const canSend = (manualMode ? manualTarget.trim().length > 0 : !!target) && prompt.trim().length > 0 && !send.isPending;

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">שליחת הודעה</h1>
        <p className="text-muted-foreground mt-1">שלחי הודעה ישירה או בקשי מה-AI ליצור תוכן ולשלוח</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>הודעה חדשה</CardTitle>
          <CardDescription>
            {isLoading ? "טוען רשימת קבוצות..." : data ? `${data.groups.length} קבוצות, ${data.chats.length} צ'אטים` : "החיבור ל-Whapi לא פעיל — בדקי בהגדרות"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label className="cursor-pointer" htmlFor="manual-toggle">הזנה ידנית של יעד</Label>
              <p className="text-xs text-muted-foreground mt-0.5">במקום לחפש ברשימה — הקלידי מספר טלפון או chat id</p>
            </div>
            <Switch id="manual-toggle" checked={manualMode} onCheckedChange={setManualMode} />
          </div>

          {manualMode ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor="manual-target">מספר טלפון או Chat ID</Label>
                <Input
                  id="manual-target"
                  value={manualTarget}
                  onChange={(e) => setManualTarget(e.target.value)}
                  placeholder="לדוגמה: 972501234567 או 123@g.us"
                  dir="ltr"
                />
                {manualTarget && (
                  <p className="text-xs text-muted-foreground mt-1" dir="ltr">→ {normalizeChatId(manualTarget)}</p>
                )}
              </div>
              <div>
                <Label htmlFor="manual-name">שם תצוגה (אופציונלי)</Label>
                <Input
                  id="manual-name"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="למשל: דנה / קבוצת עבודה"
                />
              </div>
            </div>
          ) : (
            <div>
              <Label>בחרי יעד</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="בחרי קבוצה או איש קשר..." />
                </SelectTrigger>
                <SelectContent>
                  {allTargets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="link" size="sm" onClick={() => refetch()} className="p-0 h-auto mt-1">רענן רשימה</Button>
            </div>
          )}

          <div>
            <Label>מצב</Label>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as any)} className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <RadioGroupItem value="ai" />
                <span>🧠 AI — תני הוראה, ה-AI יכתוב וישלח</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <RadioGroupItem value="direct" />
                <span>✍️ ישיר — נשלח בדיוק מה שכתבת</span>
              </label>
            </RadioGroup>
          </div>

          <div>
            <Label htmlFor="msg">
              {mode === "ai" ? "הוראה ל-AI" : "טקסט ההודעה"}
            </Label>
            <Textarea
              id="msg"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              placeholder={
                mode === "ai"
                  ? "לדוגמה: חפש 10 כתבות חדשות על AI מהשבוע האחרון ותכתוב סיכום קצר עם קישורים"
                  : "ההודעה שתישלח כמו שהיא..."
              }
            />
          </div>

          <Button
            onClick={() => send.mutate()}
            disabled={!canSend}
            className="w-full"
          >
            {send.isPending ? "שולח..." : mode === "ai" ? "🧠 צור ושלח" : "📤 שלח"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
