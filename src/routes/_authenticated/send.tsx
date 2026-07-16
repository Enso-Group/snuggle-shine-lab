import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "sonner";
import {
  ChevronsUpDown,
  Check,
  AlertTriangle,
  Sparkles,
  PenLine,
  Send,
  RefreshCw,
  Users,
  User,
  X,
  CheckCircle2,
  ShieldCheck,
  MessageSquareText,
  Loader2,
  Hash,
} from "lucide-react";
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

/** Small numbered circle used as a step marker in the compose form. */
function StepBadge({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors",
        done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {done ? <Check className="size-3.5" /> : n}
    </span>
  );
}

function SendPage() {
  const listFn = useServerFn(listWhapiGroups);
  const sendFn = useServerFn(sendManualMessage);

  const { data: realData, isLoading, isRefetching, refetch } = useQuery({
    queryKey: ["whapi-targets"],
    queryFn: () => listFn(),
    enabled: !DEMO_MODE,
  });
  const data = DEMO_MODE ? demoWhapiTargets : realData;

  const [target, setTarget] = useState<string>("");
  const [targetName, setTargetName] = useState<string>("");
  const [targetType, setTargetType] = useState<"group" | "chat" | "manual">("chat");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"direct" | "ai">("ai");
  const [sendNotice, setSendNotice] = useState<{ type: "blocked" | "error" | "success"; title: string; message: string } | null>(null);

  const allTargets = useMemo(
    () =>
      mergeTargets(data ?? {}).map((t) => ({
        id: t.id,
        name: t.name,
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

  const groups = filteredTargets.filter((t) => t.type === "group");
  const chats = filteredTargets.filter((t) => t.type === "chat");

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

  const canSend = !!target && !!prompt.trim() && !send.isPending;

  function selectTarget(id: string, name: string, type: "group" | "chat" | "manual") {
    setTarget(id);
    setTargetName(name);
    setTargetType(type);
    setOpen(false);
    setSearch("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSend) {
      e.preventDefault();
      send.mutate();
    }
  }

  const TargetIcon = targetType === "group" ? Users : targetType === "manual" ? Hash : User;

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-8 py-6">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Send className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">Send Message</h1>
            <p className="text-sm text-muted-foreground">
              Send a direct message, or ask the AI to create content and send it
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isLoading ? (
              <Skeleton className="h-6 w-36 rounded-full" />
            ) : data ? (
              <>
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <Users className="size-3" />
                  {data.groups.length} groups
                </Badge>
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <User className="size-3" />
                  {data.chats.length} chats
                </Badge>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => refetch()}
              className="size-8 text-muted-foreground"
              title="Refresh recipients list"
            >
              <RefreshCw className={cn("size-4", (isLoading || isRefetching) && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-5xl gap-6 px-8 py-8 lg:grid-cols-[1fr_280px]">
        {/* Compose card */}
        <Card className="h-fit overflow-hidden">
          <CardContent className="space-y-6 p-6">
            {sendNotice && (
              <div
                className={cn(
                  "rounded-lg border p-4",
                  sendNotice.type === "success" && "border-emerald-500/30 bg-emerald-500/5",
                  sendNotice.type === "blocked" && "border-amber-500/30 bg-amber-500/5",
                  sendNotice.type === "error" && "border-destructive/30 bg-destructive/5",
                )}
              >
                <div className="flex items-start gap-3">
                  {sendNotice.type === "success" ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertTriangle
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        sendNotice.type === "blocked" ? "text-amber-600 dark:text-amber-400" : "text-destructive",
                      )}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{sendNotice.title}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {sendNotice.message}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSendNotice(null)}
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 1 — recipient */}
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <StepBadge n={1} done={!!target} />
                <span className="text-sm font-medium">Choose a recipient</span>
              </div>
              {target ? (
                <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <TargetIcon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{targetName || target}</p>
                    <p className="truncate text-xs text-muted-foreground" dir="ltr">
                      {target}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 font-normal capitalize">
                    {targetType === "manual" ? "Manual ID" : targetType}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    onClick={() => {
                      setTarget("");
                      setTargetName("");
                    }}
                    title="Clear recipient"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <Popover open={open} onOpenChange={setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="h-11 w-full justify-between font-normal text-muted-foreground"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Users className="size-4 shrink-0 opacity-60" />
                        Choose a group or contact, or type a number...
                      </span>
                      <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
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
                              onSelect={() => selectTarget(normalized, trimmed, "manual")}
                            >
                              <Hash className="mr-2 size-4 shrink-0 text-muted-foreground" />
                              <span dir="ltr">Send to: {normalized}</span>
                            </CommandItem>
                          </CommandGroup>
                        )}
                        {filteredTargets.length === 0 && !showManualOption && (
                          <CommandEmpty>No results found</CommandEmpty>
                        )}
                        {groups.length > 0 && (
                          <CommandGroup heading="Groups">
                            {groups.map((t) => (
                              <CommandItem
                                key={t.id}
                                value={`${t.name} ${t.id}`}
                                onSelect={() => selectTarget(t.id, t.name, "group")}
                              >
                                <Users className="mr-2 size-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">{t.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {chats.length > 0 && (
                          <CommandGroup heading="Contacts">
                            {chats.map((t) => (
                              <CommandItem
                                key={t.id}
                                value={`${t.name} ${t.id}`}
                                onSelect={() => selectTarget(t.id, t.name, "chat")}
                              >
                                <User className="mr-2 size-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">{t.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </div>

            <Separator />

            {/* Step 2 — mode */}
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <StepBadge n={2} done />
                <span className="text-sm font-medium">Message type</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(
                  [
                    {
                      value: "ai" as const,
                      icon: Sparkles,
                      title: "AI message",
                      desc: "Give an instruction — the AI writes and sends it.",
                    },
                    {
                      value: "direct" as const,
                      icon: PenLine,
                      title: "Direct message",
                      desc: "Sends exactly what you write, word for word.",
                    },
                  ]
                ).map((opt) => {
                  const Icon = opt.icon;
                  const active = mode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setMode(opt.value)}
                      className={cn(
                        "relative rounded-xl border p-4 text-left transition-all",
                        active
                          ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary"
                          : "hover:border-muted-foreground/30 hover:bg-accent/50",
                      )}
                    >
                      <div
                        className={cn(
                          "absolute right-3 top-3 flex size-4 items-center justify-center rounded-full border transition-colors",
                          active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
                        )}
                      >
                        {active && <Check className="size-2.5" />}
                      </div>
                      <div
                        className={cn(
                          "mb-2.5 flex size-8 items-center justify-center rounded-lg transition-colors",
                          active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                        )}
                      >
                        <Icon className="size-4" />
                      </div>
                      <p className="text-sm font-medium">{opt.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* Step 3 — content */}
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <StepBadge n={3} done={!!prompt.trim()} />
                <span className="text-sm font-medium">
                  {mode === "ai" ? "Instruction for the AI" : "Message text"}
                </span>
              </div>
              <div className="overflow-hidden rounded-lg border bg-background transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
                <Textarea
                  id="msg"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={6}
                  className="resize-none border-0 shadow-none focus-visible:ring-0"
                  placeholder={
                    mode === "ai"
                      ? "For example: find 10 recent AI news articles from the past week and write a short summary with links"
                      : "The message that will be sent as-is..."
                  }
                />
                <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {prompt.length > 0 ? `${prompt.length.toLocaleString()} characters` : " "}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    <kbd className="rounded border bg-background px-1 py-px font-sans text-[10px]">⌘</kbd>
                    {" + "}
                    <kbd className="rounded border bg-background px-1 py-px font-sans text-[10px]">↵</kbd>
                    {" to send"}
                  </span>
                </div>
              </div>
            </div>

            <Button
              onClick={() => send.mutate()}
              disabled={!canSend}
              size="lg"
              className="w-full gap-2 shadow-md shadow-primary/20"
            >
              {send.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {mode === "ai" ? "The AI is preparing the message and checking sources..." : "Sending message..."}
                </>
              ) : (
                <>
                  {mode === "ai" ? <Sparkles className="size-4" /> : <Send className="size-4" />}
                  {mode === "ai" ? "Create and send" : "Send message"}
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Side panel */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <MessageSquareText className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">How it works</h2>
              </div>
              <ol className="space-y-3">
                {[
                  "Pick a group or contact, or type any phone number / Chat ID.",
                  "Choose AI mode to have the message written for you, or Direct to send your exact words.",
                  "Review the result here after sending — AI messages are logged with their final text.",
                ].map((tip, i) => (
                  <li key={i} className="flex gap-2.5 text-xs leading-relaxed text-muted-foreground">
                    <span className="flex size-4.5 shrink-0 select-none items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
                      {i + 1}
                    </span>
                    {tip}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="mb-2 flex items-center gap-2">
                <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                <h2 className="text-sm font-semibold">Account protection</h2>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Every message passes anti-ban safety checks before it goes out. If sending looks risky
                for the WhatsApp account, it will be blocked and you'll see the reason here.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
