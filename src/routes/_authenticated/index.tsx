import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Bot,
  GraduationCap,
  LayoutDashboard,
  Newspaper,
  RefreshCw,
  Send,
  Shield,
  Sparkles,
  Users2,
} from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { GroupProfileEditor } from "@/components/group-profile-editor";
import { commandChat, type CommandAction } from "@/lib/command.functions";
import {
  getGroupActivity,
  listManagedGroups,
  retryPlannedPost,
  type ManagedGroup,
} from "@/lib/groups.functions";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "Command Center — WhatsApp Bot" }] }),
  component: CommandCenter,
});

type ChatMsg = { role: "user" | "assistant"; content: string; actions?: CommandAction[] };

// Failed/cancelled posts must always surface with their 'reasoning' (error or
// supersede reason) — a post may never vanish from the page without explanation.
type NotSentPost = {
  id: string;
  source: string;
  pillar: string | null;
  prompt: string | null;
  body: string | null;
  status: string;
  created_at: string;
  reasoning: string | null;
};

function CommandCenter() {
  const listFn = useServerFn(listManagedGroups);
  const activityFn = useServerFn(getGroupActivity);
  const chatFn = useServerFn(commandChat);
  const retryFn = useServerFn(retryPlannedPost);
  const qc = useQueryClient();

  const [selected, setSelected] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["managed-groups"],
    queryFn: () => listFn(),
    // listManagedGroups calls the external Whapi API — don't refetch eagerly.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const current: ManagedGroup | undefined = groups.find((g) => g.chat_id === selected);

  const { data: activity } = useQuery({
    queryKey: ["group-activity", selected],
    queryFn: () => activityFn({ data: { chat_id: selected! } }),
    enabled: !!selected,
    refetchInterval: 20000,
  });

  const sendChat = useMutation({
    mutationFn: (message: string) =>
      chatFn({
        data: {
          groupChatId: selected!,
          groupName: current?.whatsapp_name,
          messages: [
            ...chat.slice(-12).map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content: message },
          ],
        },
      }),
    onSuccess: (res, message) => {
      setChat((c) => [
        ...c,
        { role: "user", content: message },
        { role: "assistant", content: res.reply, actions: res.actions },
      ]);
      setInput("");
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const retryPost = useMutation({
    mutationFn: (postId: string) => retryFn({ data: { post_id: postId } }),
    onSuccess: () => {
      toast.success("Post re-queued — the engine will generate it within a minute");
      qc.invalidateQueries({ queryKey: ["group-activity", selected] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function selectGroup(chatId: string) {
    setSelected(chatId);
    setChat([]);
    setInput("");
  }

  const upcomingPosts = (activity?.posts ?? []).filter(
    (p) => p.status === "planned" || p.status === "queued_approval",
  );
  const recentPosts = (activity?.posts ?? []).filter((p) => p.status === "sent").slice(0, 4);
  const notSentPosts: NotSentPost[] = (activity?.posts ?? []).filter(
    (p) => p.status === "failed" || p.status === "cancelled",
  );

  return (
    <div className="min-h-full">
      <PageHeader
        icon={LayoutDashboard}
        title="Command Center"
        description="How the bot runs each group — and a direct line to steer it in plain language."
        maxWidthClass="max-w-6xl"
        actions={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <Bot className="size-3" />
            {groups.filter((g) => g.profile?.enabled).length} autonomous groups
          </Badge>
        }
      />

      <PageContent maxWidthClass="max-w-6xl">
        <div className="grid gap-4 lg:grid-cols-[290px_1fr]">
          {/* Group list */}
          <Card className="h-fit lg:sticky lg:top-4">
            <CardContent className="divide-y p-0">
              {isLoading && groups.length === 0 && (
                <div className="space-y-2 p-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-9 animate-pulse rounded bg-muted" />
                  ))}
                </div>
              )}
              {!isLoading && groups.length === 0 && (
                <EmptyState
                  icon={Users2}
                  title="No groups found"
                  description="Connect WhatsApp and join groups first."
                />
              )}
              {groups.map((g) => (
                <button
                  key={g.chat_id}
                  onClick={() => selectGroup(g.chat_id)}
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

          {/* Detail */}
          {!selected ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={Bot}
                  title="Pick a group"
                  description="See how the bot manages it, steer it with plain-language instructions, or teach it from scratch."
                />
              </CardContent>
            </Card>
          ) : (
            <Tabs defaultValue="overview" className="space-y-4">
              <TabsList>
                <TabsTrigger value="overview" className="gap-1.5 text-xs">
                  <ActivityIcon className="size-3.5" /> Overview
                </TabsTrigger>
                <TabsTrigger value="teach" className="gap-1.5 text-xs">
                  <GraduationCap className="size-3.5" /> Teach & Configure
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                {/* Steering chat */}
                <Card className="border-primary/30">
                  <CardContent className="space-y-3 p-5">
                    <div className="flex items-center gap-2">
                      <Sparkles className="size-4 text-primary" />
                      <h3 className="text-sm font-semibold">Talk to the bot about this group</h3>
                    </div>
                    {chat.length > 0 && (
                      <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
                        {chat.map((m, i) => (
                          <div key={i}>
                            <div
                              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                            >
                              <span
                                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-sm ${m.role === "user" ? "bg-primary/10" : "bg-muted"}`}
                                dir="auto"
                              >
                                {m.content}
                              </span>
                            </div>
                            {m.actions && m.actions.length > 0 && (
                              <div className="mt-1 space-y-0.5">
                                {m.actions.map((a, j) => (
                                  <p
                                    key={j}
                                    className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400"
                                  >
                                    <Shield className="size-3" /> {a.summary}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                        <div ref={chatEndRef} />
                      </div>
                    )}
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (input.trim() && !sendChat.isPending) sendChat.mutate(input.trim());
                      }}
                    >
                      <Input
                        placeholder='e.g. "post more about pricing tips", "be stricter about spam", "how did this week go?"'
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="submit"
                        disabled={sendChat.isPending || !input.trim()}
                        className="gap-2"
                      >
                        <Send className="size-4" />
                        {sendChat.isPending ? "Working…" : "Send"}
                      </Button>
                    </form>
                    <p className="text-[11px] text-muted-foreground">
                      The bot applies approved changes to the group profile immediately and confirms
                      exactly what changed.
                    </p>
                  </CardContent>
                </Card>

                {/* Strategy + stats */}
                {activity?.memo && (
                  <Card>
                    <CardContent className="p-4 text-xs" dir="auto">
                      <p className="mb-1 font-semibold">
                        📋 Current strategy (week of {activity.memo.week_start})
                      </p>
                      <p className="whitespace-pre-wrap">{activity.memo.memo}</p>
                    </CardContent>
                  </Card>
                )}

                {activity && activity.stats.length > 1 && (
                  <Card>
                    <CardContent className="p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <h3 className="text-sm font-semibold">Engagement, last 7 days</h3>
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <span className="h-2 w-3 rounded-sm bg-[var(--chart-2)]" aria-hidden />
                            Messages
                          </span>
                          <span className="flex items-center gap-1.5">
                            <svg width="14" height="6" aria-hidden>
                              <line
                                x1="0"
                                y1="3"
                                x2="14"
                                y2="3"
                                stroke="var(--chart-1)"
                                strokeWidth="2"
                                strokeDasharray="4 3"
                              />
                            </svg>
                            Active members
                          </span>
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={150}>
                        <AreaChart
                          data={activity.stats}
                          margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
                        >
                          <defs>
                            <linearGradient id="ccMsgs" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.25} />
                              <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--border)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="date"
                            tickFormatter={(d: string) => d.slice(5)}
                            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                            axisLine={false}
                            tickLine={false}
                            allowDecimals={false}
                          />
                          <Tooltip
                            contentStyle={{
                              background: "var(--popover)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              fontSize: 12,
                              color: "var(--popover-foreground)",
                            }}
                            labelStyle={{ color: "var(--muted-foreground)" }}
                          />
                          <Area
                            type="monotone"
                            dataKey="messages"
                            name="Messages"
                            stroke="var(--chart-2)"
                            strokeWidth={2}
                            fill="url(#ccMsgs)"
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                          <Area
                            type="monotone"
                            dataKey="active_members"
                            name="Active members"
                            stroke="var(--chart-1)"
                            strokeWidth={2}
                            strokeDasharray="5 4"
                            fill="transparent"
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                )}

                {activity && activity.stats.length > 0 && (
                  <Card>
                    <CardContent className="overflow-x-auto p-4">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="p-1 text-start font-normal">Day</th>
                            <th className="p-1 text-start font-normal">Msgs</th>
                            <th className="p-1 text-start font-normal">Active</th>
                            <th className="p-1 text-start font-normal">Posts</th>
                            <th className="p-1 text-start font-normal">Replies</th>
                            <th className="p-1 text-start font-normal">±Members</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activity.stats.map((s) => (
                            <tr key={s.date} className="border-t">
                              <td className="p-1" dir="ltr">
                                {s.date.slice(5)}
                              </td>
                              <td className="p-1">{s.messages}</td>
                              <td className="p-1">{s.active_members}</td>
                              <td className="p-1">{s.bot_posts}</td>
                              <td className="p-1">{s.post_replies}</td>
                              <td className="p-1">
                                +{s.new_members}/-{s.left_members}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                )}

                {/* Failed/cancelled posts stay visible with their reason — never silently dropped */}
                {notSentPosts.length > 0 && (
                  <Card>
                    <CardContent className="space-y-2 p-4">
                      <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <AlertTriangle className="size-4 text-destructive" /> Not sent
                      </h3>
                      {notSentPosts.map((p) => (
                        <div key={p.id} className="rounded-md border p-2 text-xs">
                          <div className="mb-1 flex flex-wrap items-center gap-1.5">
                            {p.status === "failed" ? (
                              <Badge
                                variant="secondary"
                                className="bg-destructive/15 text-[10px] text-destructive"
                              >
                                failed
                              </Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className="bg-muted text-[10px] text-muted-foreground"
                              >
                                cancelled
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-[10px]">
                              {p.source}
                              {p.pillar ? ` · ${p.pillar}` : ""}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground" dir="ltr">
                              {new Date(p.created_at).toLocaleString("en-GB")}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              className="ms-auto h-6 gap-1 px-2 text-[10px]"
                              disabled={retryPost.isPending}
                              onClick={() => retryPost.mutate(p.id)}
                            >
                              <RefreshCw
                                className={`size-3 ${retryPost.isPending && retryPost.variables === p.id ? "animate-spin" : ""}`}
                              />
                              Retry
                            </Button>
                          </div>
                          <p className="line-clamp-2" dir="auto">
                            {p.prompt ?? p.body ?? ""}
                          </p>
                          {p.reasoning && (
                            <p
                              className={`mt-1 text-[11px] ${p.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                              dir="auto"
                            >
                              {p.reasoning}
                            </p>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {/* Upcoming + recent posts */}
                {(upcomingPosts.length > 0 || recentPosts.length > 0) && (
                  <div className="grid gap-4 xl:grid-cols-2">
                    <Card>
                      <CardContent className="space-y-2 p-4">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <Newspaper className="size-4 text-primary" /> Upcoming posts
                        </h3>
                        {upcomingPosts.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            Nothing queued — schedule slots or ask the bot to plan a post.
                          </p>
                        ) : (
                          upcomingPosts.map((p) => (
                            <div key={p.id} className="rounded-md border p-2 text-xs" dir="auto">
                              <Badge variant="outline" className="mb-1 text-[10px]">
                                {p.status === "queued_approval"
                                  ? "awaiting approval"
                                  : "generating"}
                                {p.pillar ? ` · ${p.pillar}` : ""}
                              </Badge>
                              <p className="line-clamp-2">
                                {p.body ?? p.prompt ?? "(engine will draft this)"}
                              </p>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="space-y-2 p-4">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <ActivityIcon className="size-4 text-primary" /> Recent posts & engagement
                        </h3>
                        {recentPosts.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No posts sent yet.</p>
                        ) : (
                          recentPosts.map((p) => (
                            <div key={p.id} className="rounded-md border p-2 text-xs" dir="auto">
                              <p className="mb-1 text-[10px] text-muted-foreground" dir="ltr">
                                {p.sent_at ? new Date(p.sent_at).toLocaleString("en-GB") : ""}
                                {(p.engagement as { replies_24h?: number })?.replies_24h !==
                                undefined
                                  ? ` · ${(p.engagement as { replies_24h?: number }).replies_24h} replies in 24h`
                                  : ""}
                              </p>
                              <p className="line-clamp-2 whitespace-pre-wrap">{p.body}</p>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Recent actions with reasoning */}
                {activity && activity.actions.length > 0 && (
                  <Card>
                    <CardContent className="space-y-2 p-4">
                      <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <Shield className="size-4 text-primary" /> Recent actions
                      </h3>
                      {activity.actions.map((a) => (
                        <div key={a.id} className="rounded-md border p-2 text-xs" dir="auto">
                          <Badge variant="outline" className="me-2 text-[10px]">
                            {a.action}
                          </Badge>
                          {a.target_name ?? ""} — {a.reasoning ?? a.rule_violated ?? ""}
                          <span className="ms-2 text-muted-foreground" dir="ltr">
                            {new Date(a.created_at).toLocaleString("en-GB")}
                          </span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {activity &&
                  !activity.memo &&
                  activity.stats.length === 0 &&
                  activity.posts.length === 0 &&
                  activity.actions.length === 0 && (
                    <Card>
                      <CardContent>
                        <EmptyState
                          icon={Bot}
                          title={current?.profile?.enabled ? "Warming up" : "Not managed yet"}
                          description={
                            current?.profile?.enabled
                              ? "Stats, posts and strategy appear here as the bot starts working this group."
                              : "Open Teach & Configure to write instructions and switch this group to autonomous."
                          }
                        />
                      </CardContent>
                    </Card>
                  )}
              </TabsContent>

              <TabsContent value="teach">
                <GroupProfileEditor
                  chatId={selected}
                  whatsappName={current?.whatsapp_name ?? selected}
                  profile={current?.profile ?? null}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </PageContent>
    </div>
  );
}
