import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Bot, CalendarClock, Plus, Save, Shield, Trash2, Users2, Activity } from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import {
  getGroupActivity,
  listManagedGroups,
  saveGroupProfile,
  type GroupProfileRow,
  type ManagedGroup,
} from "@/lib/groups.functions";

export const Route = createFileRoute("/_authenticated/groups")({
  head: () => ({ meta: [{ title: "Group Manager — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAdmin?: boolean }).isAdmin) throw redirect({ to: "/" });
  },
  component: GroupsPage,
});

const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

type Slot = { day: number | null; time: string; pillar?: string; prompt?: string };

type FormState = {
  enabled: boolean;
  instructions: string;
  purpose: string;
  audience: string;
  tone: string;
  language: string;
  pillarsText: string;
  rulesText: string;
  forbiddenText: string;
  schedule: Slot[];
  modEnabled: boolean;
  modDelete: boolean;
  warnLimit: number;
  removeLimit: number;
  welcomeEnabled: boolean;
  welcomeHint: string;
  replyWhenMentioned: boolean;
  replyToQuestions: boolean;
  allowReactive: boolean;
  escalationRules: string;
  kpis: string;
  ownerDm: string;
};

function profileToForm(p: GroupProfileRow | null): FormState {
  return {
    enabled: p?.enabled ?? false,
    instructions: p?.instructions ?? "",
    purpose: p?.purpose ?? "",
    audience: p?.audience ?? "",
    tone: p?.tone ?? "",
    language: p?.language ?? "he",
    pillarsText: (p?.content_pillars ?? []).join(", "),
    rulesText: (p?.rules ?? []).join("\n"),
    forbiddenText: (p?.forbidden_topics ?? []).join(", "),
    schedule: p?.posting_schedule ?? [],
    modEnabled: p?.moderation?.enabled ?? false,
    modDelete: p?.moderation?.delete_violations ?? false,
    warnLimit: p?.moderation?.warn_limit ?? 2,
    removeLimit: p?.moderation?.remove_limit ?? 4,
    welcomeEnabled: p?.welcome?.enabled ?? false,
    welcomeHint: p?.welcome?.hint ?? "",
    replyWhenMentioned: p?.reply_when_mentioned ?? true,
    replyToQuestions: p?.reply_to_questions ?? false,
    allowReactive: p?.allow_reactive_posts ?? false,
    escalationRules: p?.escalation_rules ?? "",
    kpis: p?.kpis ?? "",
    ownerDm: p?.owner_dm ?? "",
  };
}

function splitList(text: string, sep: RegExp): string[] {
  return text
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

function GroupsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listManagedGroups);
  const saveFn = useServerFn(saveGroupProfile);
  const activityFn = useServerFn(getGroupActivity);

  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(profileToForm(null));

  const { data: groups = [] } = useQuery({
    queryKey: ["managed-groups"],
    queryFn: () => listFn(),
    refetchInterval: 60000,
  });

  const current: ManagedGroup | undefined = groups.find((g) => g.chat_id === selected);

  useEffect(() => {
    if (current) setForm(profileToForm(current.profile));
  }, [selected, current?.profile?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: activity } = useQuery({
    queryKey: ["group-activity", selected],
    queryFn: () => activityFn({ data: { chat_id: selected! } }),
    enabled: !!selected && !!current?.profile,
    refetchInterval: 30000,
  });

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          chat_id: selected!,
          name: current?.whatsapp_name,
          enabled: form.enabled,
          instructions: form.instructions,
          purpose: form.purpose,
          audience: form.audience,
          tone: form.tone,
          language: form.language,
          content_pillars: splitList(form.pillarsText, /,/),
          posting_schedule: form.schedule.filter((s) => /^\d{1,2}:\d{2}$/.test(s.time)),
          rules: splitList(form.rulesText, /\n/),
          forbidden_topics: splitList(form.forbiddenText, /,/),
          moderation: {
            enabled: form.modEnabled,
            delete_violations: form.modDelete,
            warn_limit: form.warnLimit,
            remove_limit: form.removeLimit,
          },
          welcome: { enabled: form.welcomeEnabled, hint: form.welcomeHint || undefined },
          reply_when_mentioned: form.replyWhenMentioned,
          reply_to_questions: form.replyToQuestions,
          allow_reactive_posts: form.allowReactive,
          escalation_rules: form.escalationRules,
          kpis: form.kpis,
          owner_dm: form.ownerDm,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["managed-groups"] });
      toast.success("Group profile saved — the bot follows it from now on");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="min-h-full">
      <PageHeader
        icon={Users2}
        title="Group Manager"
        description="Teach the bot to run each group on its own: what to post, which rules to enforce, when to escalate."
        maxWidthClass="max-w-6xl"
        actions={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <Bot className="size-3" />
            {groups.filter((g) => g.profile?.enabled).length} autonomous
          </Badge>
        }
      />

      <PageContent maxWidthClass="max-w-6xl">
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Group list */}
          <Card className="h-fit">
            <CardContent className="divide-y p-0">
              {groups.length === 0 && (
                <EmptyState
                  icon={Users2}
                  title="No groups found"
                  description="Connect WhatsApp and join groups first."
                />
              )}
              {groups.map((g) => (
                <button
                  key={g.chat_id}
                  onClick={() => setSelected(g.chat_id)}
                  className={`flex w-full items-center gap-2 p-3 text-start transition-colors hover:bg-muted/60 ${selected === g.chat_id ? "bg-muted" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" dir="auto">
                      {g.whatsapp_name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" dir="ltr">
                      {g.chat_id}
                    </p>
                  </div>
                  {g.profile?.enabled ? (
                    <Badge
                      className="shrink-0 bg-emerald-500/15 text-xs text-emerald-600 dark:text-emerald-400"
                      variant="secondary"
                    >
                      autonomous
                    </Badge>
                  ) : g.profile ? (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      off
                    </Badge>
                  ) : null}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Editor */}
          {!selected ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={Bot}
                  title="Pick a group"
                  description="Select a group on the right to teach the bot how to manage it."
                />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <Card>
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-semibold" dir="auto">
                        {current?.whatsapp_name}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        Autonomous management{" "}
                        {form.enabled ? "ON — the bot runs this group" : "OFF"}
                      </p>
                    </div>
                    <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium">
                      הוראות למנהל־הבוט (טקסט חופשי — כאן מלמדים אותו איך לנהל)
                    </label>
                    <Textarea
                      value={form.instructions}
                      onChange={(e) => set("instructions", e.target.value)}
                      dir="auto"
                      rows={5}
                      placeholder="למשל: זו קבוצת לקוחות של המותג. תפקידך לשמור על אווירה חיובית, לענות על שאלות על המוצרים לפי מאגר הידע, לפרסם טיפ יומי בבוקר, ולהעביר אליי כל תלונה חריפה..."
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input
                      placeholder="מטרת הקבוצה"
                      value={form.purpose}
                      onChange={(e) => set("purpose", e.target.value)}
                      dir="auto"
                    />
                    <Input
                      placeholder="קהל היעד"
                      value={form.audience}
                      onChange={(e) => set("audience", e.target.value)}
                      dir="auto"
                    />
                    <Input
                      placeholder="טון (למשל: חם ומקצועי)"
                      value={form.tone}
                      onChange={(e) => set("tone", e.target.value)}
                      dir="auto"
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      placeholder="עמודי תוכן, מופרדים בפסיק"
                      value={form.pillarsText}
                      onChange={(e) => set("pillarsText", e.target.value)}
                      dir="auto"
                    />
                    <Input
                      placeholder="נושאים אסורים, מופרדים בפסיק"
                      value={form.forbiddenText}
                      onChange={(e) => set("forbiddenText", e.target.value)}
                      dir="auto"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium">
                      חוקי הקבוצה (חוק בכל שורה)
                    </label>
                    <Textarea
                      value={form.rulesText}
                      onChange={(e) => set("rulesText", e.target.value)}
                      dir="auto"
                      rows={3}
                      placeholder={"בלי פרסומות וקישורים חיצוניים\nשיח מכבד בלבד"}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Posting schedule */}
              <Card>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2">
                    <CalendarClock className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">Posting schedule (autonomous)</h3>
                  </div>
                  {form.schedule.map((slot, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select
                        value={slot.day === null ? "daily" : String(slot.day)}
                        onValueChange={(v) =>
                          set(
                            "schedule",
                            form.schedule.map((s, j) =>
                              j === i ? { ...s, day: v === "daily" ? null : Number(v) } : s,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">כל יום</SelectItem>
                          {DAYS.map((d, di) => (
                            <SelectItem key={di} value={String(di)}>
                              יום {d}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        className="w-24"
                        placeholder="09:00"
                        dir="ltr"
                        value={slot.time}
                        onChange={(e) =>
                          set(
                            "schedule",
                            form.schedule.map((s, j) =>
                              j === i ? { ...s, time: e.target.value } : s,
                            ),
                          )
                        }
                      />
                      <Input
                        className="min-w-32 flex-1"
                        placeholder="עמוד תוכן / הנחיה לפוסט (אופציונלי)"
                        dir="auto"
                        value={slot.pillar ?? ""}
                        onChange={(e) =>
                          set(
                            "schedule",
                            form.schedule.map((s, j) =>
                              j === i ? { ...s, pillar: e.target.value } : s,
                            ),
                          )
                        }
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-destructive"
                        onClick={() =>
                          set(
                            "schedule",
                            form.schedule.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() =>
                      set("schedule", [...form.schedule, { day: null, time: "09:00" }])
                    }
                  >
                    <Plus className="size-3.5" /> Add slot
                  </Button>
                  <div className="flex items-center justify-between border-t pt-3">
                    <div>
                      <p className="text-xs font-medium">Reactive posts</p>
                      <p className="text-xs text-muted-foreground">
                        Join hot discussions on its own (max once per 12h)
                      </p>
                    </div>
                    <Switch
                      checked={form.allowReactive}
                      onCheckedChange={(v) => set("allowReactive", v)}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Moderation + replies */}
              <Card>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2">
                    <Shield className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">Moderation & replies</h3>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex items-center justify-between gap-2 text-xs">
                      אכיפת חוקים (מודרציה)
                      <Switch
                        checked={form.modEnabled}
                        onCheckedChange={(v) => set("modEnabled", v)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs">
                      מחיקת הודעות מפרות (דורש מנהל)
                      <Switch
                        checked={form.modDelete}
                        onCheckedChange={(v) => set("modDelete", v)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs">
                      אזהרה פומבית אחרי (הפרות)
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        className="w-16"
                        value={form.warnLimit}
                        onChange={(e) => set("warnLimit", Number(e.target.value) || 2)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs">
                      הסרה מהקבוצה אחרי (הפרות)
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        className="w-16"
                        value={form.removeLimit}
                        onChange={(e) => set("removeLimit", Number(e.target.value) || 4)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs">
                      לענות כשמזכירים את הבוט
                      <Switch
                        checked={form.replyWhenMentioned}
                        onCheckedChange={(v) => set("replyWhenMentioned", v)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs">
                      לענות על שאלות פתוחות בקבוצה
                      <Switch
                        checked={form.replyToQuestions}
                        onCheckedChange={(v) => set("replyToQuestions", v)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs">
                      ברכת הצטרפות לחברים חדשים
                      <Switch
                        checked={form.welcomeEnabled}
                        onCheckedChange={(v) => set("welcomeEnabled", v)}
                      />
                    </label>
                    <Input
                      placeholder="הנחיה לברכה (אופציונלי)"
                      value={form.welcomeHint}
                      onChange={(e) => set("welcomeHint", e.target.value)}
                      dir="auto"
                    />
                  </div>
                  <div className="grid gap-2 border-t pt-3 sm:grid-cols-2">
                    <Textarea
                      rows={2}
                      placeholder="מתי להסלים אליי (טקסט חופשי)"
                      value={form.escalationRules}
                      onChange={(e) => set("escalationRules", e.target.value)}
                      dir="auto"
                    />
                    <div className="space-y-2">
                      <Input
                        placeholder="מספר וואטסאפ להתראות (למשל 9725...)"
                        value={form.ownerDm}
                        onChange={(e) => set("ownerDm", e.target.value)}
                        dir="ltr"
                      />
                      <Input
                        placeholder="KPIs (אופציונלי)"
                        value={form.kpis}
                        onChange={(e) => set("kpis", e.target.value)}
                        dir="auto"
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => save.mutate()}
                    disabled={save.isPending}
                    className="w-full gap-2"
                  >
                    <Save className="size-4" />
                    Save group profile
                  </Button>
                </CardContent>
              </Card>

              {/* Autonomous activity */}
              {activity && (
                <Card>
                  <CardContent className="space-y-3 p-5">
                    <div className="flex items-center gap-2">
                      <Activity className="size-4 text-primary" />
                      <h3 className="text-sm font-semibold">Recent autonomous activity</h3>
                    </div>
                    {activity.posts.length === 0 &&
                      activity.actions.length === 0 &&
                      activity.insights.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Nothing yet — activity appears once the bot starts managing.
                        </p>
                      )}
                    {activity.posts.map((p) => (
                      <div key={p.id} className="rounded-md border p-2 text-xs" dir="auto">
                        <div className="mb-1 flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">
                            post / {p.source}
                          </Badge>
                          <span className="text-muted-foreground">
                            {p.status}
                            {p.sent_at ? ` · ${new Date(p.sent_at).toLocaleString("en-GB")}` : ""}
                          </span>
                          {(p.engagement as { replies_24h?: number })?.replies_24h !==
                            undefined && (
                            <span className="text-muted-foreground">
                              · {(p.engagement as { replies_24h?: number }).replies_24h} replies/24h
                            </span>
                          )}
                        </div>
                        <p className="line-clamp-3 whitespace-pre-wrap">{p.body}</p>
                      </div>
                    ))}
                    {activity.actions.map((a) => (
                      <div key={a.id} className="rounded-md border p-2 text-xs" dir="auto">
                        <Badge variant="outline" className="me-2 text-[10px]">
                          {a.action}
                        </Badge>
                        {a.target_name ?? ""} — {a.reasoning ?? a.rule_violated ?? ""}
                        <span className="ms-2 text-muted-foreground">
                          {new Date(a.created_at).toLocaleString("en-GB")}
                        </span>
                      </div>
                    ))}
                    {activity.insights.map((i) => (
                      <div
                        key={i.id}
                        className="rounded-md border border-dashed p-2 text-xs text-muted-foreground"
                        dir="auto"
                      >
                        [{i.kind}] {i.content}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </PageContent>
    </div>
  );
}
