import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Activity, BrainCircuit, Eraser, FlaskConical, Save, Send, Settings2 } from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import {
  getAgentConfig,
  listDecisions,
  saveAgentConfig,
  type DecisionRow,
} from "@/lib/brain.functions";
import { runSimulation, cleanupSimulations } from "@/lib/simulate.functions";

export const Route = createFileRoute("/_authenticated/brain")({
  head: () => ({ meta: [{ title: "Bot Brain — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAdmin?: boolean }).isAdmin) throw redirect({ to: "/" });
  },
  component: BrainPage,
});

const STAGE_LABELS: Record<string, { label: string; cls: string }> = {
  received: { label: "התקבלה", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  reply_gate: { label: "שער תגובה", cls: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400" },
  context: { label: "הקשר", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  intent: { label: "כוונה", cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
  draft: { label: "טיוטה", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  critique: { label: "ביקורת", cls: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400" },
  deliver: { label: "נשלח", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  queued_approval: {
    label: "ממתין לאישור",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  memory: { label: "זיכרון", cls: "bg-teal-500/15 text-teal-600 dark:text-teal-400" },
  follow_up: { label: "מעקב", cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  moderation: { label: "מודרציה", cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  welcome: { label: "ברכה", cls: "bg-lime-500/15 text-lime-600 dark:text-lime-400" },
  post: { label: "פוסט", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  insight: { label: "תובנה", cls: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  skipped: { label: "דולג", cls: "bg-muted text-muted-foreground" },
  error: { label: "שגיאה", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
};

function StageBadge({ stage }: { stage: string }) {
  const s = STAGE_LABELS[stage] ?? { label: stage, cls: "bg-muted text-muted-foreground" };
  return (
    <Badge variant="secondary" className={`shrink-0 text-[10px] ${s.cls}`}>
      {s.label}
    </Badge>
  );
}

type SimExchange = {
  userMessage: string;
  action: string;
  botParts: string[];
  reactions: string[];
  trace: Array<{ stage: string; summary: string | null; duration_ms: number | null }>;
};

function BrainPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listDecisions);
  const getCfgFn = useServerFn(getAgentConfig);
  const saveCfgFn = useServerFn(saveAgentConfig);
  const simulateFn = useServerFn(runSimulation);
  const cleanupFn = useServerFn(cleanupSimulations);

  // ---- Live decision feed ----
  const [group, setGroup] = useState<"all" | "replies" | "memory" | "groups" | "errors">("all");
  const { data: decisions = [] } = useQuery({
    queryKey: ["bot-decisions", group],
    queryFn: () => listFn({ data: { group, limit: 60 } }),
    refetchInterval: 5000,
  });

  // ---- Agent config ----
  const { data: cfg } = useQuery({ queryKey: ["agent-config"], queryFn: () => getCfgFn() });
  const [cfgForm, setCfgForm] = useState<typeof cfg | null>(null);
  useEffect(() => {
    if (cfg && !cfgForm) setCfgForm(cfg);
  }, [cfg, cfgForm]);
  const saveCfg = useMutation({
    mutationFn: () => saveCfgFn({ data: cfgForm! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-config"] });
      toast.success("Agent configuration saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---- Simulator ----
  const [simChatId, setSimChatId] = useState<string | null>(null);
  const [simInput, setSimInput] = useState("");
  const [simLog, setSimLog] = useState<SimExchange[]>([]);
  const simulate = useMutation({
    mutationFn: (message: string) =>
      simulateFn({ data: { messages: [message], chatId: simChatId ?? undefined } }),
    onSuccess: (res, message) => {
      setSimChatId(res.chatId);
      setSimLog((log) => [
        ...log,
        {
          userMessage: message,
          action: res.outcomes[0]?.action ?? "?",
          botParts: res.sent.map((s) => s.body),
          reactions: res.reactions.map((r) => r.emoji),
          trace: res.decisions.map((d) => ({
            stage: d.stage,
            summary: d.summary,
            duration_ms: d.duration_ms,
          })),
        },
      ]);
      setSimInput("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cleanup = useMutation({
    mutationFn: () => cleanupFn(),
    onSuccess: (r) => {
      setSimChatId(null);
      setSimLog([]);
      toast.success(`Removed ${r.removed} simulation chats`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-full">
      <PageHeader
        icon={BrainCircuit}
        title="Bot Brain"
        description="Every decision the bot makes, with its reasoning — plus a safe simulator and the agent's global configuration."
        maxWidthClass="max-w-5xl"
        actions={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <Activity className="size-3" />
            live
          </Badge>
        }
      />

      <PageContent maxWidthClass="max-w-5xl">
        {/* Simulator */}
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FlaskConical className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Simulator — test the bot without WhatsApp</h2>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                onClick={() => cleanup.mutate()}
                disabled={cleanup.isPending}
              >
                <Eraser className="size-3.5" /> Clear simulations
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Messages run through the full real pipeline (intent → draft → critique → memory) with
              real AI but zero WhatsApp traffic. Multi-turn: keep typing to test its memory.
            </p>

            {simLog.length > 0 && (
              <div className="space-y-3 rounded-md border p-3">
                {simLog.map((ex, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex justify-end">
                      <span
                        className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-1.5 text-sm"
                        dir="auto"
                      >
                        {ex.userMessage}
                      </span>
                    </div>
                    {ex.botParts.map((p, j) => (
                      <div key={j} className="flex justify-start">
                        <span
                          className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-1.5 text-sm"
                          dir="auto"
                        >
                          {p}
                        </span>
                      </div>
                    ))}
                    {ex.reactions.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        הבוט הגיב עם {ex.reactions.join(" ")}
                      </p>
                    )}
                    {ex.botParts.length === 0 && ex.reactions.length === 0 && (
                      <p className="text-xs text-muted-foreground">({ex.action})</p>
                    )}
                    {ex.trace.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">
                          Decision trace ({ex.trace.length} stages)
                        </summary>
                        <div className="mt-1.5 space-y-1 border-s-2 border-primary/30 ps-3">
                          {ex.trace.map((t, k) => (
                            <div key={k} className="flex items-start gap-2" dir="auto">
                              <StageBadge stage={t.stage} />
                              <span className="flex-1">{t.summary}</span>
                              {t.duration_ms != null && (
                                <span className="shrink-0 text-muted-foreground">
                                  {t.duration_ms}ms
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}

            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (simInput.trim() && !simulate.isPending) simulate.mutate(simInput.trim());
              }}
            >
              <Input
                placeholder="כתוב הודעה כאילו אתה לקוח..."
                value={simInput}
                onChange={(e) => setSimInput(e.target.value)}
                dir="auto"
                className="flex-1"
              />
              <Button
                type="submit"
                disabled={simulate.isPending || !simInput.trim()}
                className="gap-2"
              >
                <Send className="size-4" />
                {simulate.isPending ? "Thinking…" : "Send"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Agent configuration */}
        {cfgForm && (
          <Card>
            <CardContent className="space-y-3 p-5">
              <div className="flex items-center gap-2">
                <Settings2 className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Agent configuration</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium">
                    Strong model (reasoning/drafts)
                  </label>
                  <Input
                    placeholder="default: google/gemini-3.1-pro-preview"
                    value={cfgForm.model_strong ?? ""}
                    onChange={(e) =>
                      setCfgForm({ ...cfgForm, model_strong: e.target.value || null })
                    }
                    dir="ltr"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">
                    Fast model (classification)
                  </label>
                  <Input
                    placeholder="default: google/gemini-3-flash-preview"
                    value={cfgForm.model_fast ?? ""}
                    onChange={(e) => setCfgForm({ ...cfgForm, model_fast: e.target.value || null })}
                    dir="ltr"
                  />
                </div>
                <label className="flex items-center justify-between gap-2 text-xs">
                  השהיית תגובה (שניות, לאיחוד הודעות רצופות)
                  <Input
                    type="number"
                    min={0}
                    max={30}
                    className="w-16"
                    value={cfgForm.reply_delay_seconds}
                    onChange={(e) =>
                      setCfgForm({ ...cfgForm, reply_delay_seconds: Number(e.target.value) || 0 })
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  מקסימום הודעות בתשובה אחת
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    className="w-16"
                    value={cfgForm.max_reply_parts}
                    onChange={(e) =>
                      setCfgForm({ ...cfgForm, max_reply_parts: Number(e.target.value) || 3 })
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  ביקורת עצמית לפני שליחה (איכות מקסימלית)
                  <Switch
                    checked={cfgForm.critique_enabled}
                    onCheckedChange={(v) => setCfgForm({ ...cfgForm, critique_enabled: v })}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  ריאקציה 👍 להודעות קצרות (תודה וכו')
                  <Switch
                    checked={cfgForm.react_to_trivial}
                    onCheckedChange={(v) => setCfgForm({ ...cfgForm, react_to_trivial: v })}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  מעקבים אוטומטיים (follow-ups)
                  <Switch
                    checked={cfgForm.follow_ups_enabled}
                    onCheckedChange={(v) => setCfgForm({ ...cfgForm, follow_ups_enabled: v })}
                  />
                </label>
              </div>
              <Button
                onClick={() => saveCfg.mutate()}
                disabled={saveCfg.isPending}
                className="gap-2"
              >
                <Save className="size-4" /> Save configuration
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Live decision feed */}
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Live decision log</h2>
              </div>
              <Select value={group} onValueChange={(v) => setGroup(v as typeof group)}>
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All activity</SelectItem>
                  <SelectItem value="replies">Replies</SelectItem>
                  <SelectItem value="memory">Memory & follow-ups</SelectItem>
                  <SelectItem value="groups">Group management</SelectItem>
                  <SelectItem value="errors">Errors</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {decisions.length === 0 ? (
              <EmptyState
                icon={BrainCircuit}
                title="No decisions yet"
                description="Every message the bot handles will appear here with its full reasoning."
              />
            ) : (
              <div className="divide-y">
                {decisions.map((d: DecisionRow) => (
                  <div key={d.id} className="flex items-start gap-2 py-2 text-xs" dir="auto">
                    <span className="w-14 shrink-0 pt-0.5 text-muted-foreground" dir="ltr">
                      {new Date(d.created_at).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <StageBadge stage={d.stage} />
                    <div className="min-w-0 flex-1">
                      <span className="me-2 font-medium">{d.chat_name ?? d.chat_id ?? ""}</span>
                      <span className={d.status === "error" ? "text-rose-500" : ""}>
                        {d.summary}
                      </span>
                      {d.data != null && Object.keys(d.data as object).length > 0 && (
                        <details className="mt-0.5">
                          <summary className="cursor-pointer text-muted-foreground">
                            details
                          </summary>
                          <pre
                            className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[10px]"
                            dir="ltr"
                          >
                            {JSON.stringify(d.data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                    {d.duration_ms != null && (
                      <span className="shrink-0 text-muted-foreground">{d.duration_ms}ms</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </PageContent>
    </div>
  );
}
