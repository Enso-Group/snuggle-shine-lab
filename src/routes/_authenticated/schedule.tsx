import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { mergeTargets } from "@/lib/targets";
import { DEMO_MODE, demoScheduledMessages, demoWhapiTargets, demoApprovals } from "@/lib/demo";
import { toast } from "sonner";
import { Plus, Trash2, Send, Pencil, Check, X, ShieldQuestion, ChevronsUpDown, Sparkles, CalendarClock } from "lucide-react";
import { PageHeader, PageContent } from "@/components/page-header";
import {
  listScheduledMessages,
  createScheduledMessage,
  updateScheduledMessage,
  deleteScheduledMessage,
  sendScheduledNow,
  listPendingApprovals,
  approvePending,
  rejectPending,
} from "@/lib/schedule.functions";
import { listWhapiGroups } from "@/lib/bot.functions";

export const Route = createFileRoute("/_authenticated/schedule")({
  head: () => ({ meta: [{ title: "Weekly Scheduler — WhatsApp Bot" }] }),
  component: SchedulePage,
});

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Row = {
  id: string;
  day_of_week: number;
  send_time: string;
  target_chat_id: string;
  target_name: string | null;
  body: string;
  mode: string;
  enabled: boolean;
  require_approval: boolean;
  last_sent_at: string | null;
};

type Approval = {
  id: string;
  target_chat_id: string;
  target_name: string | null;
  body: string;
  created_at: string;
};

function SchedulePage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listScheduledMessages);
  const createFn = useServerFn(createScheduledMessage);
  const updateFn = useServerFn(updateScheduledMessage);
  const deleteFn = useServerFn(deleteScheduledMessage);
  const sendNowFn = useServerFn(sendScheduledNow);
  const targetsFn = useServerFn(listWhapiGroups);
  const pendingFn = useServerFn(listPendingApprovals);
  const approveFn = useServerFn(approvePending);
  const rejectFn = useServerFn(rejectPending);

  const { data: realRows = [] } = useQuery({
    queryKey: ["scheduled-messages"],
    queryFn: () => listFn() as unknown as Promise<Row[]>,
    enabled: !DEMO_MODE,
  });
  const rows = DEMO_MODE ? (demoScheduledMessages as unknown as Row[]) : realRows;
  const { data: realTargets } = useQuery({
    queryKey: ["whapi-targets"],
    queryFn: () => targetsFn(),
    enabled: !DEMO_MODE,
  });
  const targets = DEMO_MODE ? demoWhapiTargets : realTargets;
  const allTargets = mergeTargets(targets ?? {}).map((t) => ({
    id: t.id,
    name: t.isGroup ? `👥 ${t.name}` : `👤 ${t.name}`,
  }));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["scheduled-messages"] });

  const remove = useMutation({
    mutationFn: async (id: string) => { if (DEMO_MODE) return; return deleteFn({ data: { id } }); },
    onSuccess: () => { invalidate(); toast.success("Deleted"); },
    onError: (e: any) => toast.error(e.message),
  });
  const sendNow = useMutation({
    mutationFn: async (id: string) => { if (DEMO_MODE) return; return sendNowFn({ data: { id } }); },
    onSuccess: () => { invalidate(); toast.success("Sent"); },
    onError: (e: any) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      if (DEMO_MODE) return;
      return updateFn({ data: { id, enabled } });
    },
    onSuccess: invalidate,
  });

  const { data: realPending = [] } = useQuery({
    queryKey: ["scheduled-approvals"],
    queryFn: () => pendingFn() as Promise<Approval[]>,
    refetchInterval: 30000,
    enabled: !DEMO_MODE,
  });
  const pending = DEMO_MODE ? (demoApprovals as unknown as Approval[]) : realPending;
  const invalidateApprovals = () => qc.invalidateQueries({ queryKey: ["scheduled-approvals"] });
  const approve = useMutation({
    mutationFn: async (id: string) => { if (DEMO_MODE) return; return approveFn({ data: { id } }); },
    onSuccess: () => { invalidateApprovals(); toast.success("Sent"); },
    onError: (e: any) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: async (id: string) => { if (DEMO_MODE) return; return rejectFn({ data: { id } }); },
    onSuccess: () => { invalidateApprovals(); toast.success("Rejected"); },
    onError: (e: any) => toast.error(e.message),
  });

  const byDay = DAYS.map((_, i) => rows.filter((r) => r.day_of_week === i).sort((a, b) => a.send_time.localeCompare(b.send_time)));

  return (
    <div className="min-h-full">
      <PageHeader
        icon={CalendarClock}
        title="Weekly Scheduler"
        description="Set messages to send automatically by day and time (Israel time)"
        maxWidthClass="max-w-none"
        actions={
          <>
            {rows.length > 0 && (
              <Badge variant="secondary" className="font-normal">
                {rows.length} scheduled
              </Badge>
            )}
            <ScheduleDialog targets={allTargets} onSaved={invalidate}>
              <Button className="gap-2">
                <Plus className="size-4" />
                New message
              </Button>
            </ScheduleDialog>
          </>
        }
      />

      <PageContent maxWidthClass="max-w-none">
      {pending.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-50/30 dark:bg-amber-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldQuestion className="size-4 text-amber-600" />
              Waiting for approval ({pending.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="rounded-md border bg-background p-3 space-y-2">
                <div className="text-xs text-muted-foreground">
                  {p.target_name ?? p.target_chat_id} · {new Date(p.created_at).toLocaleString("en-US")}
                </div>
                <p className="text-sm whitespace-pre-wrap">{p.body}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => approve.mutate(p.id)} disabled={approve.isPending}>
                    <Check className="size-3 ms-1" />Approve and send
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => reject.mutate(p.id)} disabled={reject.isPending}>
                    <X className="size-3 ms-1" />Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3">
        {DAYS.map((day, i) => (
          <Card key={i} className="min-h-[200px]">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between">
                <span>{day}</span>
                <Badge variant="outline" className="text-xs">{byDay[i].length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {byDay[i].length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No messages</p>
              )}
              {byDay[i].map((r) => (
                <div key={r.id} className={`rounded-md border p-2 text-xs space-y-1 ${r.enabled ? "" : "opacity-50"}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{r.send_time.slice(0, 5)}</span>
                    <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} />
                  </div>
                  <p className="text-muted-foreground truncate" title={r.target_name ?? r.target_chat_id}>
                    {r.target_name ?? r.target_chat_id}
                  </p>
                  <p className="line-clamp-2 whitespace-pre-wrap" title={r.body}>{r.body}</p>
                  <div className="flex flex-wrap gap-1">
                    {r.mode === "ai" && (
                      <Badge variant="outline" className="text-[10px] gap-1 border-primary/40 text-primary">
                        <Sparkles className="size-3" />AI message
                      </Badge>
                    )}
                    {r.require_approval && (
                      <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400">
                        <ShieldQuestion className="size-3" />Requires approval
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-1 pt-1">
                    <ScheduleDialog targets={allTargets} onSaved={invalidate} existing={r}>
                      <Button size="icon" variant="ghost" className="h-6 w-6"><Pencil className="size-3" /></Button>
                    </ScheduleDialog>
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => sendNow.mutate(r.id)} title="Send now">
                      <Send className="size-3" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => remove.mutate(r.id)}>
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              ))}
              <ScheduleDialog targets={allTargets} onSaved={invalidate} defaultDay={i}>
                <Button size="sm" variant="ghost" className="w-full text-xs"><Plus className="size-3 ms-1" />Add</Button>
              </ScheduleDialog>
            </CardContent>
          </Card>
        ))}
      </div>
      </PageContent>
    </div>
  );
}

function ScheduleDialog({
  children,
  targets,
  onSaved,
  existing,
  defaultDay,
}: {
  children: React.ReactNode;
  targets: { id: string; name: string }[];
  onSaved: () => void;
  existing?: Row;
  defaultDay?: number;
}) {
  const createFn = useServerFn(createScheduledMessage);
  const updateFn = useServerFn(updateScheduledMessage);
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<number>(existing?.day_of_week ?? defaultDay ?? 0);
  const [time, setTime] = useState(existing?.send_time?.slice(0, 5) ?? "09:00");
  const [target, setTarget] = useState(existing?.target_chat_id ?? "");
  const [targetName, setTargetName] = useState(existing?.target_name ?? "");
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetSearch, setTargetSearch] = useState("");
  const [body, setBody] = useState(existing?.body ?? "");
  const [mode, setMode] = useState<"direct" | "ai">((existing?.mode as "direct" | "ai") ?? "direct");
  const [requireApproval, setRequireApproval] = useState(existing?.require_approval ?? false);

  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Choose a target");
      if (!body.trim()) throw new Error(mode === "ai" ? "Add a prompt" : "Add content");
      const payload = {
        day_of_week: day,
        send_time: time.length === 5 ? `${time}:00` : time,
        target_chat_id: target,
        target_name: targetName || targets.find((t) => t.id === target)?.name || null,
        body,
        mode,
        require_approval: requireApproval,
      };
      if (DEMO_MODE) return;
      if (existing) await updateFn({ data: { id: existing.id, ...payload } });
      else await createFn({ data: payload });
    },
    onSuccess: () => {
      toast.success(existing ? "Updated" : "Created");
      setOpen(false);
      onSaved();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit schedule" : "New schedule"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Day</Label>
              <Select value={String(day)} onValueChange={(v) => setDay(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Time</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Target</Label>
            <Popover open={targetOpen} onOpenChange={setTargetOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                  <span className={cn("truncate", !target && "text-muted-foreground")}>
                    {target ? (targetName || target) : "Choose or search a group / contact..."}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search by name..."
                    value={targetSearch}
                    onValueChange={setTargetSearch}
                  />
                  <CommandList>
                    {(() => {
                      const q = targetSearch.trim().toLowerCase();
                      const filtered = q
                        ? targets.filter((t) => `${t.name} ${t.id}`.toLowerCase().includes(q))
                        : targets;
                      return (
                        <>
                          {filtered.length === 0 && <CommandEmpty>No results found</CommandEmpty>}
                          <CommandGroup heading="Groups and contacts">
                            {filtered.map((t) => (
                        <CommandItem
                          key={t.id}
                          value={`${t.name} ${t.id}`}
                          onSelect={() => {
                            setTarget(t.id);
                            setTargetName(t.name);
                            setTargetOpen(false);
                            setTargetSearch("");
                          }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", target === t.id ? "opacity-100" : "opacity-0")} />
                          <span className="truncate">{t.name}</span>
                        </CommandItem>
                            ))}
                          </CommandGroup>
                        </>
                      );
                    })()}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <Label>Message type</Label>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as "direct" | "ai")}
              className="flex gap-4 mt-2"
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <RadioGroupItem value="direct" />
                <span className="text-sm">Fixed message</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <RadioGroupItem value="ai" />
                <span className="text-sm">AI message</span>
              </label>
            </RadioGroup>
          </div>
          <div>
            <Label>{mode === "ai" ? "Prompt for the AI" : "Message content"}</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder={
                mode === "ai"
                  ? 'For example: write a short, warm good-morning greeting for the group, with one tip for the day'
                  : ""
              }
            />
            {mode === "ai" && (
              <p className="text-xs text-muted-foreground mt-1">
                The message is regenerated by the AI on every scheduled send, so it's different each time.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium flex items-center gap-2">
                <ShieldQuestion className="size-4" />Require approval before sending
              </Label>
              <p className="text-xs text-muted-foreground">
                When on, the bot will ask you for approval on this screen instead of sending automatically.
              </p>
            </div>
            <Switch checked={requireApproval} onCheckedChange={setRequireApproval} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
