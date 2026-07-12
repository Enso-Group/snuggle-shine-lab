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
import { mergeTargets } from "@/lib/targets";
import { DEMO_MODE, demoWhapiTargets } from "@/lib/demo";

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
  head: () => ({ meta: [{ title: "Send — WhatsApp Bot" }] }),
  component: SendPage,
});

function SendPage() {
  const listFn = useServerFn(listWhapiGroups);
  const sendFn = useServerFn(sendManualMessage);

  const { data: realData, isLoading, refetch } = useQuery({
    queryKey: ["whapi-targets"],
    queryFn: () => listFn(),
    enabled: !DEMO_MODE,
  });
  const data = DEMO_MODE ? demoWhapiTargets : realData;

  const [target, setTarget] = useState<string>("");
  const [targetName, setTargetName] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"direct" | "ai">("ai");
  const [sendNotice, setSendNotice] = useState<{ type: "blocked" | "error" | "success"; title: string; message: string } | null>(null);

  const pendingText = mode === "ai" ? "The AI is preparing the message and checking sources..." : "Sending message...";

  const allTargets = useMemo(
    () =>
      mergeTargets(data ?? {}).map((t) => ({
        id: t.id,
        name: t.isGroup ? `👥 ${t.name}` : `👤 ${t.name}`,
        type: t.isGroup ? ("group" as const) : ("chat" as const),
      })),
    [data],
  );

  const trimmed = search.trim();
  const normalized = normalizeChatId(trimmed);
  const hasMatch = allTargets.some((t) => t.id === normalized || t.id === trimmed);
  const showManualOption = trimmed.length > 0 && !hasMatch;

  // Deterministic substring search (cmdk's built-in fuzzy filter is unreliable
  // for Hebrew + emoji-prefixed names, so we filter ourselves).
  const filteredTargets = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (!q) return allTargets;
    return allTargets.filter((t) => `${t.name} ${t.id}`.toLowerCase().includes(q));
  }, [allTargets, trimmed]);

  const send = useMutation({
    mutationFn: async () => {
      if (DEMO_MODE) {
        await new Promise((r) => setTimeout(r, 600));
        const body = mode === "ai" ? `${prompt}\n\n(Demo: this message was written by the AI)` : prompt;
        return { ok: true as const, body };
      }
      return sendFn({ data: { target_chat_id: target, target_name: targetName || target, prompt, mode } });
    },
    onSuccess: (result) => {
      if (!result.ok) {
        const title = result.blocked ? "Sending was blocked to protect the account" : "Sending failed";
        setSendNotice({ type: result.blocked ? "blocked" : "error", title, message: result.reason });
        toast[result.blocked ? "warning" : "error"](result.reason);
        return;
      }
      toast.success("Sent!");
      setSendNotice({ type: "success", title: "Sent successfully", message: result.body });
      setPrompt("");
    },
    onError: (e: any) => {
      const message = e.message || "Unexpected error while sending";
      setSendNotice({ type: "error", title: "Sending failed", message });
      toast.error(message);
    },
  });

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Send Message</h1>
        <p className="text-muted-foreground mt-1">Send a direct message, or ask the AI to create content and send it</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New message</CardTitle>
          <CardDescription>
            {isLoading ? "Loading groups list..." : data ? `${data.groups.length} groups, ${data.chats.length} chats` : "Choose a target and write your message"}
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
            <Label>Choose a target</Label>
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal"
                >
                  <span className={cn("truncate", !target && "text-muted-foreground")}>
                    {target ? (targetName || target) : "Choose or type a number/Chat ID..."}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search by name, or type a phone number/Chat ID..."
                    value={search}
                    onValueChange={setSearch}
                  />
                  <CommandList>
                    {showManualOption && (
                      <CommandGroup heading="Use the typed value">
                        <CommandItem
                          value={`__manual__${trimmed}`}
                          onSelect={() => {
                            setTarget(normalized);
                            setTargetName(trimmed);
                            setOpen(false);
                            setSearch("");
                          }}
                        >
                          <span dir="ltr">Send to: {normalized}</span>
                        </CommandItem>
                      </CommandGroup>
                    )}
                    {filteredTargets.length === 0 && <CommandEmpty>No results found</CommandEmpty>}
                    <CommandGroup heading="Groups and contacts">
                      {filteredTargets.map((t) => (
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
            <Button variant="link" size="sm" onClick={() => refetch()} className="p-0 h-auto mt-1">Refresh list</Button>
          </div>

          <div>
            <Label>Mode</Label>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as any)} className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <RadioGroupItem value="ai" />
                <span>🧠 AI — give an instruction, the AI writes and sends</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <RadioGroupItem value="direct" />
                <span>✍️ Direct — sends exactly what you wrote</span>
              </label>
            </RadioGroup>
          </div>

          <div>
            <Label htmlFor="msg">
              {mode === "ai" ? "Instruction for the AI" : "Message text"}
            </Label>
            <Textarea
              id="msg"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              placeholder={
                mode === "ai"
                  ? "For example: find 10 recent AI news articles from the past week and write a short summary with links"
                  : "The message that will be sent as-is..."
              }
            />
          </div>

          <Button
            onClick={() => send.mutate()}
            disabled={!target || !prompt.trim() || send.isPending}
            className="w-full"
          >
            {send.isPending ? pendingText : mode === "ai" ? "🧠 Create and send" : "📤 Send"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
