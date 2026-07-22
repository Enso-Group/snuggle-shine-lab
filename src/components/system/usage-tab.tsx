// Behind the Scenes → Usage & Costs: AI spend at a glance — totals, per-model
// breakdown and the most recent calls. Compact replacement for the former
// Usage page (the ai_usage_log keeps recording everything).
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Gauge } from "lucide-react";
import { getAiUsageSummary, listAiUsage } from "@/lib/usage.functions";

const RANGES: Record<string, number> = { day: 24, week: 24 * 7, month: 24 * 30 };

function fmtUSD(n: number) {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}
function fmtNum(n: number) {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

export function UsageTab() {
  const summaryFn = useServerFn(getAiUsageSummary);
  const listFn = useServerFn(listAiUsage);
  const [range, setRange] = useState<"day" | "week" | "month">("week");

  const { data: summary } = useQuery({
    queryKey: ["usage-summary", range],
    queryFn: () => summaryFn({ data: { rangeHours: RANGES[range] } }),
    refetchInterval: 30000,
  });
  const { data: recent } = useQuery({
    queryKey: ["usage-recent", range],
    queryFn: () => listFn({ data: { page: 1, pageSize: 25, rangeHours: RANGES[range] } }),
    refetchInterval: 30000,
  });

  const totals = summary?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Gauge className="size-4" /> AI usage and estimated cost (not exact billing).
        </p>
        <Tabs value={range} onValueChange={(v) => setRange(v as typeof range)}>
          <TabsList className="h-8">
            <TabsTrigger value="day" className="text-xs">
              Day
            </TabsTrigger>
            <TabsTrigger value="week" className="text-xs">
              Week
            </TabsTrigger>
            <TabsTrigger value="month" className="text-xs">
              Month
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Estimated cost", value: totals ? fmtUSD(totals.totalCostUsd) : "—" },
          { label: "LLM calls", value: totals ? fmtNum(totals.llmCalls) : "—" },
          { label: "Tokens", value: totals ? fmtNum(totals.totalTokens) : "—" },
          {
            label: "Errors",
            value: totals ? fmtNum(totals.errorCount) : "—",
            alert: (totals?.errorCount ?? 0) > 0,
          },
        ].map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`text-xl font-semibold ${c.alert ? "text-rose-500" : ""}`}>{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {summary && Object.keys(summary.byModel).length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto p-4">
            <h3 className="mb-2 text-sm font-semibold">By model</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="p-1 text-start font-normal">Model</th>
                  <th className="p-1 text-start font-normal">Calls</th>
                  <th className="p-1 text-start font-normal">Tokens</th>
                  <th className="p-1 text-start font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(summary.byModel)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([model, m]) => (
                    <tr key={model} className="border-t">
                      <td className="p-1 font-mono" dir="ltr">
                        {model}
                      </td>
                      <td className="p-1">{fmtNum(m.calls)}</td>
                      <td className="p-1">{fmtNum(m.totalTokens)}</td>
                      <td className="p-1">{fmtUSD(m.cost)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {recent && recent.rows.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto p-4">
            <h3 className="mb-2 text-sm font-semibold">Recent calls</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="p-1 text-start font-normal">Time</th>
                  <th className="p-1 text-start font-normal">Source</th>
                  <th className="p-1 text-start font-normal">Model / tool</th>
                  <th className="p-1 text-start font-normal">Tokens</th>
                  <th className="p-1 text-start font-normal">ms</th>
                  <th className="p-1 text-start font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-1" dir="ltr">
                      {new Date(r.created_at).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="p-1">{r.source ?? "—"}</td>
                    <td className="p-1 font-mono" dir="ltr">
                      {r.model ?? r.tool_name ?? "—"}
                    </td>
                    <td className="p-1">{r.total_tokens ?? "—"}</td>
                    <td className="p-1">{r.duration_ms ?? "—"}</td>
                    <td className="p-1">
                      <Badge
                        variant={r.status === "error" ? "destructive" : "secondary"}
                        className="text-[10px]"
                      >
                        {r.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
