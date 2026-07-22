import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Brain,
  MessageSquare,
  Search,
  Send,
  Sparkles,
  TrendingUp,
  User,
  Users2,
  X,
} from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import {
  askAboutPerson,
  deletePersonFact,
  getPersonDetail,
  listPeople,
} from "@/lib/people.functions";

export const Route = createFileRoute("/_authenticated/profiles")({
  head: () => ({ meta: [{ title: "Profiles — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAdmin?: boolean }).isAdmin) throw redirect({ to: "/approvals" });
  },
  component: ProfilesPage,
});

const STAGE_STYLES: Record<string, string> = {
  lead: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  customer: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  vip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  community: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  churned: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

type ChatMsg = { role: "user" | "assistant"; content: string };

function ProfilesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPeople);
  const detailFn = useServerFn(getPersonDetail);
  const askFn = useServerFn(askAboutPerson);
  const deleteFactFn = useServerFn(deletePersonFact);

  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data: people = [], isLoading: listLoading } = useQuery({
    queryKey: ["people-memory"],
    queryFn: () => listFn(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) => (p.display_name ?? "").toLowerCase().includes(q) || p.wa_id.includes(q),
    );
  }, [people, search]);

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["person-detail", selected],
    queryFn: () => detailFn({ data: { personId: selected! } }),
    enabled: !!selected,
    refetchInterval: 20000,
  });

  const ask = useMutation({
    mutationFn: (q: string) =>
      askFn({ data: { personId: selected!, question: q, history: chat.slice(-10) } }),
    onSuccess: (res, q) => {
      setChat((c) => [
        ...c,
        { role: "user", content: q },
        { role: "assistant", content: res.answer },
      ]);
      setQuestion("");
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeFact = useMutation({
    mutationFn: (factText: string) => deleteFactFn({ data: { personId: selected!, factText } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person-detail", selected] });
      qc.invalidateQueries({ queryKey: ["people-memory"] });
      toast.success("Fact removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function selectPerson(id: string) {
    setSelected(id);
    setChat([]);
    setQuestion("");
  }

  const p = detail?.person;

  return (
    <div className="min-h-full">
      <PageHeader
        icon={User}
        title="Profiles"
        description="The bot's full analysis of every contact — who they are, what they want, and everything it remembers."
        maxWidthClass="max-w-6xl"
        actions={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <Users2 className="size-3" />
            {people.length} contacts
          </Badge>
        }
      />

      <PageContent maxWidthClass="max-w-6xl">
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          {/* Contact list */}
          <Card className="h-fit lg:sticky lg:top-4">
            <CardContent className="p-0">
              <div className="border-b p-2">
                <div className="relative">
                  <Search className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search contacts…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 ps-8 text-sm"
                  />
                </div>
              </div>
              <div className="max-h-[70vh] divide-y overflow-y-auto">
                {listLoading && people.length === 0 && (
                  <div className="space-y-2 p-3">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div key={i} className="flex animate-pulse items-center gap-2">
                        <div className="size-8 rounded-full bg-muted" />
                        <div className="h-3 flex-1 rounded bg-muted" />
                      </div>
                    ))}
                  </div>
                )}
                {!listLoading && filtered.length === 0 && (
                  <p className="p-4 text-center text-xs text-muted-foreground">
                    {people.length === 0
                      ? "Profiles appear after the bot's first conversations."
                      : "No contacts match the search."}
                  </p>
                )}
                {filtered.map((person) => (
                  <button
                    key={person.id}
                    onClick={() => selectPerson(person.id)}
                    className={`flex w-full items-center gap-2.5 p-3 text-start transition-colors hover:bg-muted/60 ${selected === person.id ? "bg-muted" : ""}`}
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" dir="auto">
                        {person.display_name ?? person.wa_id}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {person.facts.length} facts · seen{" "}
                        {new Date(person.last_seen_at).toLocaleDateString("en-GB")}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={`shrink-0 text-[10px] ${STAGE_STYLES[person.funnel_stage] ?? "bg-muted text-muted-foreground"}`}
                    >
                      {person.funnel_stage}
                    </Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Detail */}
          {!selected ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={Brain}
                  title="Pick a contact"
                  description="Select someone to see the bot's full analysis — and ask it anything about them."
                />
              </CardContent>
            </Card>
          ) : detailLoading && !detail ? (
            <Card>
              <CardContent className="space-y-3 p-5">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-4 animate-pulse rounded bg-muted" />
                ))}
              </CardContent>
            </Card>
          ) : detail && p ? (
            <div className="space-y-4">
              {/* Header card */}
              <Card>
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-base font-semibold" dir="auto">
                        {p.display_name ?? p.wa_id}
                      </h2>
                      <p className="text-xs text-muted-foreground" dir="ltr">
                        {p.wa_id} · first seen{" "}
                        {new Date(p.first_seen_at).toLocaleDateString("en-GB")} · last seen{" "}
                        {new Date(p.last_seen_at).toLocaleString("en-GB")}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {p.language && (
                        <Badge variant="outline" className="text-xs uppercase">
                          {p.language}
                        </Badge>
                      )}
                      {p.sentiment && (
                        <Badge variant="outline" className="text-xs">
                          {p.sentiment}
                        </Badge>
                      )}
                      <Badge
                        variant="secondary"
                        className={`text-xs ${STAGE_STYLES[p.funnel_stage] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {p.funnel_stage}
                      </Badge>
                    </div>
                  </div>
                  {detail.groups.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Groups: <span dir="auto">{detail.groups.join(" · ")}</span>
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Ask the bot */}
              <Card className="border-primary/30">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">Ask the bot about this contact</h3>
                  </div>
                  {chat.length > 0 && (
                    <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
                      {chat.map((m, i) => (
                        <div
                          key={i}
                          className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                        >
                          <span
                            className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-sm ${m.role === "user" ? "bg-primary/10" : "bg-muted"}`}
                            dir="auto"
                          >
                            {m.content}
                          </span>
                        </div>
                      ))}
                      <div ref={chatEndRef} />
                    </div>
                  )}
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (question.trim() && !ask.isPending) ask.mutate(question.trim());
                    }}
                  >
                    <Input
                      placeholder='e.g. "What does he want?", "Is she close to buying?", "How should I approach him?"'
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      type="submit"
                      disabled={ask.isPending || !question.trim()}
                      className="gap-2"
                    >
                      <Send className="size-4" />
                      {ask.isPending ? "Thinking…" : "Ask"}
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <div className="grid gap-4 xl:grid-cols-2">
                {/* Facts + intent history */}
                <div className="space-y-4">
                  <Card>
                    <CardContent className="p-5">
                      <div className="mb-2 flex items-center gap-2">
                        <Brain className="size-4 text-primary" />
                        <h3 className="text-sm font-semibold">
                          What the bot knows ({p.facts.length})
                        </h3>
                      </div>
                      {p.facts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Facts are extracted automatically after each conversation.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {p.facts
                            .slice()
                            .reverse()
                            .map((f) => (
                              <li
                                key={f.at + f.text}
                                className="group flex items-start gap-2 text-xs"
                                dir="auto"
                              >
                                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/50" />
                                <span className="flex-1">{f.text}</span>
                                <span
                                  className="shrink-0 text-[10px] text-muted-foreground"
                                  dir="ltr"
                                >
                                  {f.at.slice(0, 10)}
                                </span>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                                  title="Remove this fact"
                                  onClick={() => removeFact.mutate(f.text)}
                                >
                                  <X className="size-3" />
                                </Button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-5">
                      <div className="mb-2 flex items-center gap-2">
                        <TrendingUp className="size-4 text-primary" />
                        <h3 className="text-sm font-semibold">Intent & sentiment history</h3>
                      </div>
                      {detail.intents.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Appears after the bot analyzes their messages.
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {detail.intents.map((i, idx) => (
                            <li key={idx} className="text-xs">
                              <span className="text-muted-foreground" dir="ltr">
                                {new Date(i.at).toLocaleDateString("en-GB")}
                              </span>{" "}
                              <span dir="auto">{i.intent}</span>
                              {i.sentiment && (
                                <Badge variant="outline" className="ms-1.5 text-[10px]">
                                  {i.sentiment}
                                </Badge>
                              )}
                              {i.urgency === "high" && (
                                <Badge variant="outline" className="ms-1 text-[10px] text-rose-500">
                                  urgent
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Conversation timeline */}
                <Card>
                  <CardContent className="p-5">
                    <div className="mb-2 flex items-center gap-2">
                      <MessageSquare className="size-4 text-primary" />
                      <h3 className="text-sm font-semibold">Conversation timeline</h3>
                    </div>
                    {detail.timeline.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No direct 1:1 conversation yet.
                      </p>
                    ) : (
                      <div className="max-h-[28rem] space-y-1.5 overflow-y-auto pe-1">
                        {detail.timeline.map((m, i) => (
                          <div
                            key={i}
                            className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${m.direction === "outbound" ? "bg-primary/10" : "bg-muted"}`}
                            >
                              <p className="whitespace-pre-wrap text-xs" dir="auto">
                                {m.body}
                              </p>
                              <p className="mt-0.5 text-[10px] text-muted-foreground" dir="ltr">
                                {new Date(m.created_at).toLocaleString("en-GB", {
                                  day: "2-digit",
                                  month: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : null}
        </div>
      </PageContent>
    </div>
  );
}
