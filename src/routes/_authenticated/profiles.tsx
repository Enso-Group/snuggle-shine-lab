import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { FunnelStageBadge } from "@/components/funnel-badge";
import {
  askAboutPerson,
  deletePersonFact,
  getPersonDetail,
  listPeople,
  type PersonDetail,
  type PersonListItem,
} from "@/lib/people.functions";

export const Route = createFileRoute("/_authenticated/profiles")({
  head: () => ({ meta: [{ title: "Profiles — WhatsApp Bot" }] }),
  // Selection lives in the URL so a profile can be deep-linked and survives
  // refresh; anything non-string is dropped rather than crashing the route.
  validateSearch: (s: Record<string, unknown>) => ({
    person: typeof s.person === "string" ? s.person : undefined,
  }),
  component: ProfilesPage,
});

/** The one skeleton used everywhere on this page. */
function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted" />
      ))}
    </div>
  );
}

function Avatar({ name, className = "size-8" }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary ${className}`}
    >
      {initial}
    </div>
  );
}

function ContactRow({
  person,
  selected,
  onSelect,
}: {
  person: PersonListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 border-s-2 p-3 text-start transition-colors hover:bg-muted/60 ${
        selected ? "border-primary bg-primary/10" : "border-transparent"
      }`}
    >
      <Avatar name={person.display_name ?? person.wa_id} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" dir="auto">
          {person.display_name ?? person.wa_id}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {person.facts.length} facts · last seen{" "}
          <span dir="ltr">{new Date(person.last_seen_at).toLocaleDateString("en-GB")}</span>
        </p>
      </div>
      <FunnelStageBadge stage={person.funnel_stage} />
    </button>
  );
}

function IdentityCard({ detail }: { detail: PersonDetail }) {
  const p = detail.person;
  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={p.display_name ?? p.wa_id} className="size-12 text-lg" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold" dir="auto">
              {p.display_name ?? p.wa_id}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground" dir="ltr">
              {p.wa_id} · first seen {new Date(p.first_seen_at).toLocaleDateString("en-GB")} ·
              last seen {new Date(p.last_seen_at).toLocaleString("en-GB")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <FunnelStageBadge stage={p.funnel_stage} size="md" />
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
          </div>
        </div>
        {detail.groups.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Groups</span>
            {detail.groups.map((g) => (
              <Badge key={g} variant="outline" className="text-[10px] font-normal" dir="auto">
                {g}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FactsCard({ personId, facts }: { personId: string; facts: PersonListItem["facts"] }) {
  const qc = useQueryClient();
  const deleteFactFn = useServerFn(deletePersonFact);
  const removeFact = useMutation({
    mutationFn: (factText: string) => deleteFactFn({ data: { personId, factText } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person-detail", personId] });
      qc.invalidateQueries({ queryKey: ["people-memory"] });
      toast.success("Fact removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Brain className="size-4 text-primary" />
        <CardTitle className="text-sm">What the bot knows</CardTitle>
        <Badge variant="secondary" className="ms-auto text-[10px]">
          {facts.length}
        </Badge>
      </CardHeader>
      <CardContent>
        {facts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Facts are extracted automatically after each conversation.
          </p>
        ) : (
          <ul className="space-y-1">
            {facts
              .slice()
              .reverse()
              .map((f) => (
                <li key={f.at + f.text} className="group flex items-start gap-2 text-xs" dir="auto">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/50" />
                  <span className="flex-1">{f.text}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground" dir="ltr">
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
  );
}

function IntentsCard({ intents }: { intents: PersonDetail["intents"] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <TrendingUp className="size-4 text-primary" />
        <CardTitle className="text-sm">Intent history</CardTitle>
      </CardHeader>
      <CardContent>
        {intents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Appears after the bot analyzes their messages.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {intents.map((i, idx) => (
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
                {i.urgency && (
                  <Badge
                    variant="outline"
                    className={`ms-1 text-[10px] ${
                      i.urgency === "high"
                        ? "border-red-500/40 text-red-600 dark:text-red-400"
                        : ""
                    }`}
                  >
                    {i.urgency}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ConversationCard({
  personId,
  timeline,
}: {
  personId: string;
  timeline: PersonDetail["timeline"];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Timeline arrives oldest-first; keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [personId, timeline.length]);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <MessageSquare className="size-4 text-primary" />
        <CardTitle className="text-sm">Conversation</CardTitle>
      </CardHeader>
      <CardContent>
        {timeline.length === 0 ? (
          <p className="text-xs text-muted-foreground">No direct 1:1 conversation yet.</p>
        ) : (
          <div ref={scrollRef} className="max-h-[32rem] space-y-1.5 overflow-y-auto pe-1">
            {timeline.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${
                    m.direction === "outbound" ? "bg-primary/10" : "bg-muted"
                  }`}
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
  );
}

type ChatMsg = { role: "user" | "assistant"; content: string };

// Keyed by person id from the parent, so chat history resets on every
// contact switch without any effect-based cleanup.
function AskCard({ personId }: { personId: string }) {
  const askFn = useServerFn(askAboutPerson);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (q: string) =>
      askFn({ data: { personId, question: q, history: chat.slice(-10) } }),
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

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Sparkles className="size-4 text-primary" />
        <CardTitle className="text-sm">Ask the AI about this contact</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {chat.length > 0 && (
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
            {chat.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <span
                  className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-sm ${
                    m.role === "user" ? "bg-primary/10" : "bg-muted"
                  }`}
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
          <Button type="submit" disabled={ask.isPending || !question.trim()} className="gap-2">
            <Send className="size-4" />
            {ask.isPending ? "Thinking…" : "Ask"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ProfilesPage() {
  const listFn = useServerFn(listPeople);
  const detailFn = useServerFn(getPersonDetail);
  const { person: selected } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [search, setSearch] = useState("");

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

  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
  } = useQuery({
    queryKey: ["person-detail", selected],
    queryFn: () => detailFn({ data: { personId: selected! } }),
    enabled: !!selected,
    refetchInterval: 20000,
  });

  function selectPerson(id: string) {
    navigate({ search: { person: id }, replace: true });
  }

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
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          {/* Contact list */}
          <Card className="h-fit overflow-hidden lg:sticky lg:top-4">
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
                  <div className="p-4">
                    <SkeletonRows rows={5} />
                  </div>
                )}
                {!listLoading && filtered.length === 0 && (
                  <EmptyState
                    icon={people.length === 0 ? Users2 : Search}
                    title={people.length === 0 ? "No contacts yet" : "No matches"}
                    description={
                      people.length === 0
                        ? "Profiles appear after the bot's first conversations."
                        : "No contacts match the search."
                    }
                  />
                )}
                {filtered.map((person) => (
                  <ContactRow
                    key={person.id}
                    person={person}
                    selected={selected === person.id}
                    onSelect={() => selectPerson(person.id)}
                  />
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
              <CardContent className="p-6">
                <SkeletonRows rows={5} />
              </CardContent>
            </Card>
          ) : detailError ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={User}
                  title="Contact not found"
                  description="This profile may have been removed. Pick another contact from the list."
                />
              </CardContent>
            </Card>
          ) : detail ? (
            <div className="space-y-6">
              <IdentityCard detail={detail} />
              <div className="grid gap-6 xl:grid-cols-2">
                <div className="space-y-6">
                  <FactsCard personId={detail.person.id} facts={detail.person.facts} />
                  <IntentsCard intents={detail.intents} />
                </div>
                <ConversationCard personId={detail.person.id} timeline={detail.timeline} />
              </div>
              <AskCard key={detail.person.id} personId={detail.person.id} />
            </div>
          ) : null}
        </div>
      </PageContent>
    </div>
  );
}
