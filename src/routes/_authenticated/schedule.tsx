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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Plus, Trash2, Send, Pencil, Check, X, ShieldQuestion, ChevronsUpDown } from "lucide-react";
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
  head: () => ({ meta: [{ title: "תזמון שבועי — בוט WhatsApp" }] }),
  component: SchedulePage,
});

const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

type Row = {
  id: string;
  day_of_week: number;
  send_time: string;
  target_chat_id: string;
  target_name: string | null;
  body: string;
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

  const { data: rows = [] } = useQuery({
    queryKey: ["scheduled-messages"],
    queryFn: () => listFn() as Promise<Row[]>,
  });
  const { data: targets } = useQuery({
    queryKey: ["whapi-targets"],
    queryFn: () => targetsFn(),
  });
  const allTargets = [
    ...((targets?.groups ?? []).map((g: any) => ({ id: g.id, name: `👥 ${g.name}` }))),
    ...((targets?.chats ?? []).filter((c: any) => !c.id.endsWith("@g.us")).map((c: any) => ({ id: c.id, name: `👤 ${c.name}` }))),
  ];

  const invalidate = () => qc.invalidateQueries({ queryKey: ["scheduled-messages"] });

  const remove = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => { invalidate(); toast.success("נמחק"); },
    onError: (e: any) => toast.error(e.message),
  });
  const sendNow = useMutation({
    mutationFn: (id: string) => sendNowFn({ data: { id } }),
    onSuccess: () => { invalidate(); toast.success("נשלח"); },
    onError: (e: any) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateFn({ data: { id, enabled } }),
    onSuccess: invalidate,
  });

  const { data: pending = [] } = useQuery({
    queryKey: ["scheduled-approvals"],
    queryFn: () => pendingFn() as Promise<Approval[]>,
    refetchInterval: 30000,
  });
  const invalidateApprovals = () => qc.invalidateQueries({ queryKey: ["scheduled-approvals"] });
  const approve = useMutation({
    mutationFn: (id: string) => approveFn({ data: { id } }),
    onSuccess: () => { invalidateApprovals(); toast.success("נשלח"); },
    onError: (e: any) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: string) => rejectFn({ data: { id } }),
    onSuccess: () => { invalidateApprovals(); toast.success("נדחה"); },
    onError: (e: any) => toast.error(e.message),
  });

  const byDay = DAYS.map((_, i) => rows.filter((r) => r.day_of_week === i).sort((a, b) => a.send_time.localeCompare(b.send_time)));

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold">תזמון שבועי</h1>
          <p className="text-muted-foreground mt-1">קבעי הודעות שיישלחו אוטומטית לפי יום ושעה (שעון ישראל)</p>
        </div>
        <ScheduleDialog targets={allTargets} onSaved={invalidate}>
          <Button><Plus className="size-4 ms-2" />הודעה חדשה</Button>
        </ScheduleDialog>
      </div>

      {pending.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-50/30 dark:bg-amber-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldQuestion className="size-4 text-amber-600" />
              ממתינות לאישור ({pending.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="rounded-md border bg-background p-3 space-y-2">
                <div className="text-xs text-muted-foreground">
                  {p.target_name ?? p.target_chat_id} · {new Date(p.created_at).toLocaleString("he-IL")}
                </div>
                <p className="text-sm whitespace-pre-wrap">{p.body}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => approve.mutate(p.id)} disabled={approve.isPending}>
                    <Check className="size-3 ms-1" />אשר ושלח
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => reject.mutate(p.id)} disabled={reject.isPending}>
                    <X className="size-3 ms-1" />דחה
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
                <p className="text-xs text-muted-foreground text-center py-4">אין הודעות</p>
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
                  {r.require_approval && (
                    <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400">
                      <ShieldQuestion className="size-3" />דורש אישור
                    </Badge>
                  )}
                  <div className="flex gap-1 pt-1">
                    <ScheduleDialog targets={allTargets} onSaved={invalidate} existing={r}>
                      <Button size="icon" variant="ghost" className="h-6 w-6"><Pencil className="size-3" /></Button>
                    </ScheduleDialog>
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => sendNow.mutate(r.id)} title="שלח עכשיו">
                      <Send className="size-3" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => remove.mutate(r.id)}>
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              ))}
              <ScheduleDialog targets={allTargets} onSaved={invalidate} defaultDay={i}>
                <Button size="sm" variant="ghost" className="w-full text-xs"><Plus className="size-3 ms-1" />הוסף</Button>
              </ScheduleDialog>
            </CardContent>
          </Card>
        ))}
      </div>
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
  const [requireApproval, setRequireApproval] = useState(existing?.require_approval ?? false);

  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("בחר יעד");
      if (!body.trim()) throw new Error("הוסף תוכן");
      const payload = {
        day_of_week: day,
        send_time: time.length === 5 ? `${time}:00` : time,
        target_chat_id: target,
        target_name: targetName || targets.find((t) => t.id === target)?.name || null,
        body,
        require_approval: requireApproval,
      };
      if (existing) await updateFn({ data: { id: existing.id, ...payload } });
      else await createFn({ data: payload });
    },
    onSuccess: () => {
      toast.success(existing ? "עודכן" : "נוצר");
      setOpen(false);
      onSaved();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>{existing ? "עריכת תזמון" : "תזמון חדש"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>יום</Label>
              <Select value={String(day)} onValueChange={(v) => setDay(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>שעה</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>יעד</Label>
            <Popover open={targetOpen} onOpenChange={setTargetOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                  <span className={cn("truncate", !target && "text-muted-foreground")}>
                    {target ? (targetName || target) : "בחר או חפש קבוצה / איש קשר..."}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="חיפוש לפי שם..."
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
                          {filtered.length === 0 && <CommandEmpty>לא נמצאו תוצאות</CommandEmpty>}
                          <CommandGroup heading="קבוצות ואנשי קשר">
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
            <Label>תוכן ההודעה</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium flex items-center gap-2">
                <ShieldQuestion className="size-4" />דרוש אישור לפני שליחה
              </Label>
              <p className="text-xs text-muted-foreground">
                כשמופעל, הבוט יבקש ממך אישור במסך זה במקום לשלוח אוטומטית.
              </p>
            </div>
            <Switch checked={requireApproval} onCheckedChange={setRequireApproval} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "שומר..." : "שמור"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
