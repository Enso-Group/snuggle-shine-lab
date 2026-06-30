import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listAiUsage, getAiUsageSummary, getAiUsageFilters } from "@/lib/usage.functions";
import {
  Activity,
  Coins,
  AlertCircle,
  Clock,
  Cpu,
  Wrench,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Eye,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/_authenticated/usage")({
  head: () => ({ meta: [{ title: "שימוש ועלויות — מעקב AI" }] }),
  component: UsagePage,
});

const RANGES = [
  { label: "24 שעות", hours: 24 },
  { label: "7 ימים", hours: 24 * 7 },
  { label: "30 ימים", hours: 24 * 30 },
  { label: "90 ימים", hours: 24 * 90 },
];

function fmtNum(n: number) {
  return new Intl.NumberFormat("he-IL").format(n);
}
function fmtUSD(n: number) {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
function fmtTime(s: string) {
  return new Date(s).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "medium" });
}

function UsagePage() {
  const [rangeHours, setRangeHours] = useState(24 * 7);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [kind, setKind] = useState<"all" | "llm" | "tool">("all");
  const [status, setStatus] = useState<"all" | "success" | "error">("all");
  const [model, setModel] = useState<string>("all");
  const [tool, setTool] = useState<string>("all");
  const [selected, setSelected] = useState<any | null>(null);

  const summaryFn = useServerFn(getAiUsageSummary);
  const listFn = useServerFn(listAiUsage);
  const filtersFn = useServerFn(getAiUsageFilters);

  const summary = useQuery({
    queryKey: ["ai-usage-summary", rangeHours],
    queryFn: () => summaryFn({ data: { rangeHours } }),
    refetchInterval: 30_000,
  });

  const filters = useQuery({
    queryKey: ["ai-usage-filters"],
    queryFn: () => filtersFn(),
  });

  const list = useQuery({
    queryKey: ["ai-usage-list", rangeHours, page, pageSize, kind, status, model, tool],
    queryFn: () =>
      listFn({
        data: {
          rangeHours,
          page,
          pageSize,
          kind,
          status,
          model: model === "all" ? undefined : model,
          tool: tool === "all" ? undefined : tool,
        },
      }),
    refetchInterval: 30_000,
  });

  const totalPages = useMemo(() => {
    if (!list.data) return 1;
    return Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
  }, [list.data]);

  const modelEntries = useMemo(
    () => Object.entries(summary.data?.byModel ?? {}).sort((a, b) => b[1].cost - a[1].cost),
    [summary.data],
  );
  const toolEntries = useMemo(
    () => Object.entries(summary.data?.byTool ?? {}).sort((a, b) => b[1].calls - a[1].calls),
    [summary.data],
  );

  return (
    <div className="p-8 space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">מעקב שימוש AI</h1>
          <p className="text-muted-foreground mt-1">כל קריאת מודל וכלי — טוקנים, עלות, זמן, סטטוס.</p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={String(rangeHours)} onValueChange={(v) => { setRangeHours(Number(v)); setPage(1); }}>
            <TabsList>
              {RANGES.map((r) => (
                <TabsTrigger key={r.hours} value={String(r.hours)}>{r.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button variant="outline" size="icon" onClick={() => { summary.refetch(); list.refetch(); filters.refetch(); }}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          icon={Activity}
          label="סך קריאות"
          value={fmtNum(summary.data?.totals.calls ?? 0)}
          sub={`${fmtNum(summary.data?.totals.llmCalls ?? 0)} LLM · ${fmtNum(summary.data?.totals.toolCalls ?? 0)} כלים`}
        />
        <SummaryCard
          icon={Coins}
          label="עלות משוערת"
          value={fmtUSD(summary.data?.totals.totalCostUsd ?? 0)}
          sub={`${fmtNum(summary.data?.totals.totalTokens ?? 0)} טוקנים`}
          accent="primary"
        />
        <SummaryCard
          icon={AlertCircle}
          label="שגיאות"
          value={fmtNum(summary.data?.totals.errorCount ?? 0)}
          sub={summary.data?.totals.calls ? `${(((summary.data.totals.errorCount) / summary.data.totals.calls) * 100).toFixed(1)}% מכלל הקריאות` : "—"}
          accent={summary.data && summary.data.totals.errorCount > 0 ? "destructive" : undefined}
        />
        <SummaryCard
          icon={Clock}
          label="זמן ממוצע לקריאה"
          value={`${fmtNum(summary.data?.totals.avgLatencyMs ?? 0)}ms`}
        />
      </div>

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">פעילות יומית</CardTitle>
        </CardHeader>
        <CardContent className="h-64">
          {summary.data?.series.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={summary.data.series}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.6} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: any, k: string) => (k === "cost" ? fmtUSD(Number(v)) : fmtNum(Number(v)))}
                />
                <Area type="monotone" dataKey="calls" stroke="hsl(var(--primary))" fill="url(#g1)" name="קריאות" />
                <Area type="monotone" dataKey="tokens" stroke="hsl(var(--muted-foreground))" fill="transparent" name="טוקנים" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">אין נתונים בטווח הנבחר</div>
          )}
        </CardContent>
      </Card>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Cpu className="size-4" /> פילוח לפי מודל</CardTitle>
          </CardHeader>
          <CardContent>
            {modelEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">אין קריאות LLM בטווח.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>מודל</TableHead>
                    <TableHead className="text-right">קריאות</TableHead>
                    <TableHead className="text-right">טוקנים</TableHead>
                    <TableHead className="text-right">עלות</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelEntries.map(([m, v]) => (
                    <TableRow key={m}>
                      <TableCell className="font-mono text-xs">{m}</TableCell>
                      <TableCell className="text-right">{fmtNum(v.calls)}</TableCell>
                      <TableCell className="text-right">
                        <div>{fmtNum(v.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground">{fmtNum(v.promptTokens)}↗ · {fmtNum(v.completionTokens)}↙</div>
                      </TableCell>
                      <TableCell className="text-right font-semibold">{fmtUSD(v.cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Wrench className="size-4" /> פילוח לפי כלי</CardTitle>
          </CardHeader>
          <CardContent>
            {toolEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">אין קריאות כלים בטווח.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>כלי</TableHead>
                    <TableHead className="text-right">קריאות</TableHead>
                    <TableHead className="text-right">שגיאות</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {toolEntries.map(([t, v]) => (
                    <TableRow key={t}>
                      <TableCell className="font-mono text-xs">{t}</TableCell>
                      <TableCell className="text-right">{fmtNum(v.calls)}</TableCell>
                      <TableCell className="text-right">
                        {v.errors > 0 ? <Badge variant="destructive">{v.errors}</Badge> : <span className="text-muted-foreground">0</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Detail log */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <CardTitle className="text-base">יומן מפורט</CardTitle>
            <div className="flex flex-wrap gap-2">
              <FilterSelect label="סוג" value={kind} onChange={(v) => { setKind(v as any); setPage(1); }} options={[["all","הכל"],["llm","LLM"],["tool","כלי"]]} />
              <FilterSelect label="סטטוס" value={status} onChange={(v) => { setStatus(v as any); setPage(1); }} options={[["all","הכל"],["success","הצלחה"],["error","שגיאה"]]} />
              <FilterSelect
                label="מודל"
                value={model}
                onChange={(v) => { setModel(v); setPage(1); }}
                options={[["all","הכל"], ...(filters.data?.models ?? []).map((m) => [m, m] as [string,string])]}
              />
              <FilterSelect
                label="כלי"
                value={tool}
                onChange={(v) => { setTool(v); setPage(1); }}
                options={[["all","הכל"], ...(filters.data?.tools ?? []).map((m) => [m, m] as [string,string])]}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>זמן</TableHead>
                  <TableHead>סוג</TableHead>
                  <TableHead>מודל / כלי</TableHead>
                  <TableHead>מקור</TableHead>
                  <TableHead className="text-right">טוקנים</TableHead>
                  <TableHead className="text-right">עלות</TableHead>
                  <TableHead className="text-right">זמן</TableHead>
                  <TableHead>סטטוס</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.isLoading ? (
                  <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">טוען...</TableCell></TableRow>
                ) : list.data?.rows.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">אין רשומות בטווח/בפילטר הנבחר.</TableCell></TableRow>
                ) : list.data?.rows.map((r: any) => (
                  <TableRow key={r.id} className="hover:bg-muted/50">
                    <TableCell className="text-xs whitespace-nowrap">{fmtTime(r.created_at)}</TableCell>
                    <TableCell>
                      <Badge variant={r.kind === "llm" ? "default" : "secondary"} className="font-mono text-[10px]">{r.kind}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-[220px] truncate">
                      {r.model ?? r.tool_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.source ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs">{r.total_tokens ? fmtNum(r.total_tokens) : "—"}</TableCell>
                    <TableCell className="text-right text-xs font-semibold">{r.cost_usd ? fmtUSD(Number(r.cost_usd)) : "—"}</TableCell>
                    <TableCell className="text-right text-xs">{r.duration_ms ? `${fmtNum(r.duration_ms)}ms` : "—"}</TableCell>
                    <TableCell>
                      {r.status === "success" ? (
                        <Badge variant="outline" className="text-emerald-600 border-emerald-600/30">ok</Badge>
                      ) : (
                        <Badge variant="destructive">{r.http_status ?? "err"}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => setSelected(r)}>
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 text-sm">
            <div className="text-muted-foreground">
              {list.data ? `${fmtNum(list.data.total)} רשומות · עמוד ${list.data.page} מתוך ${totalPages}` : ""}
            </div>
            <div className="flex items-center gap-2">
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                <SelectTrigger className="w-24 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n} / עמוד</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronRight className="size-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <ChevronLeft className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>פרטי קריאה</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <Detail k="זמן" v={fmtTime(selected.created_at)} />
              <Detail k="סוג" v={selected.kind} />
              <Detail k="מודל" v={selected.model ?? "—"} />
              <Detail k="כלי" v={selected.tool_name ?? "—"} />
              <Detail k="ספק" v={selected.provider ?? "—"} />
              <Detail k="מקור" v={selected.source ?? "—"} />
              <Detail k="סטטוס" v={`${selected.status}${selected.http_status ? ` (${selected.http_status})` : ""}`} />
              <Detail k="טוקנים (prompt/completion/total)" v={`${selected.prompt_tokens ?? 0} / ${selected.completion_tokens ?? 0} / ${selected.total_tokens ?? 0}`} />
              <Detail k="עלות" v={selected.cost_usd ? fmtUSD(Number(selected.cost_usd)) : "—"} />
              <Detail k="זמן ביצוע" v={selected.duration_ms ? `${selected.duration_ms}ms` : "—"} />
              {selected.error_message && <Detail k="שגיאה" v={selected.error_message} mono />}
              {selected.meta && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Metadata</div>
                  <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-60">{JSON.stringify(selected.meta, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, sub, accent }: { icon: any; label: string; value: string; sub?: string; accent?: "primary" | "destructive" }) {
  const tone =
    accent === "primary" ? "text-primary"
      : accent === "destructive" ? "text-destructive"
      : "text-foreground";
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="size-4" /> {label}
        </div>
        <div className={`text-3xl font-bold mt-2 ${tone}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}:</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function Detail({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b pb-1">
      <span className="text-muted-foreground text-xs">{k}</span>
      <span className={`text-right ${mono ? "font-mono text-xs" : ""}`}>{v}</span>
    </div>
  );
}
