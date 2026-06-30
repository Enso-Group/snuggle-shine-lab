import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { ChevronsUpDown, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { listWhapiGroups, sendManualMessage } from "@/lib/bot.functions";

function normalizeChatId(input: string): string {
  const v = input.trim();
  if (!v) return "";
  if (v.endsWith("@g.us") || v.endsWith("@s.whatsapp.net") || v.endsWith("@c.us")) return v;
  const digits = v.replace(/[^\d]/g, "");
  if (!digits) return v;
  const phone = /^0\d{9}$/.test(digits) ? `972${digits.slice(1)}` : digits;
  return `${phone}@s.whatsapp.net`;
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
  const [targetName, setTargetName] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"direct" | "ai">("ai");
  const [sendNotice, setSendNotice] = useState<{ type: "blocked" | "error" | "success"; title: string; message: string } | null>(null);

  const pendingText = mode === "ai" ? "ה-AI מכין את ההודעה ובודק מקורות..." : "שולח הודעה...";

  const allTargets = useMemo(() => [
    ...(data?.groups ?? []).map((g) => ({ id: g.id, name: `👥 ${g.name}`, type: "group" as const })),
    ...(data?.chats ?? []).filter((c) => !c.id.endsWith("@g.us")).map((c) => ({ id: c.id, name: `👤 ${c.name}`, type: "chat" as const })),
  ], [data]);

  const trimmed = search.trim();
  const normalized = normalizeChatId(trimmed);
  const hasMatch = allTargets.some((t) => t.id === normalized || t.id === trimmed);
  const showManualOption = trimmed.length > 0 && !hasMatch;

  const send = useMutation({
    mutationFn: () => sendFn({ data: { target_chat_id: target, target_name: targetName || target, prompt, mode } }),
    onSuccess: (result) => {
      if (!result.ok) {
        const title = result.blocked ? "השליחה נחסמה להגנה על החשבון" : "השליחה נכשלה";
        setSendNotice({ type: result.blocked ? "blocked" : "error", title, message: result.reason });
        toast[result.blocked ? "warning" : "error"](result.reason);
        return;
      }
      toast.success("נשלח!");
      setSendNotice({ type: "success", title: "נשלח בהצלחה", message: result.body });
      setPrompt("");
    },
    onError: (e: any) => {
      const message = e.message || "שגיאה לא צפויה בשליחה";
      setSendNotice({ type: "error", title: "השליחה נכשלה", message });
      toast.error(message);
    },
  });

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
          {sendNotice && (
            <Alert variant={sendNotice.type === "error" ? "destructive" : "default"}>
              {sendNotice.type !== "success" && <AlertTriangle className="size-4" />}
              <AlertTitle>{sendNotice.title}</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap break-words">
                {sendNotice.message}
              </AlertDescription>
            </Alert>
          )}

          <div>
            <Label>בחרי יעד</Label>
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal"
                >
                  <span className={cn("truncate", !target && "text-muted-foreground")}>
                    {target ? (targetName || target) : "בחרי או הקלידי מספר/Chat ID..."}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command shouldFilter>
                  <CommandInput
                    placeholder="חיפוש לפי שם, או הקלידי מספר טלפון/Chat ID..."
                    value={search}
                    onValueChange={setSearch}
                  />
                  <CommandList>
                    {showManualOption && (
                      <CommandGroup heading="שימוש בערך שהוקלד">
                        <CommandItem
                          value={`__manual__${trimmed}`}
                          onSelect={() => {
                            setTarget(normalized);
                            setTargetName(trimmed);
                            setOpen(false);
                            setSearch("");
                          }}
                        >
                          <span dir="ltr">שלח אל: {normalized}</span>
                        </CommandItem>
                      </CommandGroup>
                    )}
                    <CommandEmpty>לא נמצאו תוצאות</CommandEmpty>
                    <CommandGroup heading="קבוצות ואנשי קשר">
                      {allTargets.map((t) => (
                        <CommandItem
                          key={t.id}
                          value={`${t.name} ${t.id}`}
                          onSelect={() => {
                            setTarget(t.id);
                            setTargetName(t.name);
                            setOpen(false);
                            setSearch("");
                          }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", target === t.id ? "opacity-100" : "opacity-0")} />
                          <span className="truncate">{t.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Button variant="link" size="sm" onClick={() => refetch()} className="p-0 h-auto mt-1">רענן רשימה</Button>
          </div>

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
            disabled={!target || !prompt.trim() || send.isPending}
            className="w-full"
          >
            {send.isPending ? pendingText : mode === "ai" ? "🧠 צור ושלח" : "📤 שלח"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
