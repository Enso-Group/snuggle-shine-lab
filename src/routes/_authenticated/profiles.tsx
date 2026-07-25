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

// Same preview pattern as the Command Center — lists stay short by default,
// with search and "Show all" covering everything past the preview.
const PREVIEW_ROWS = 5;
// The contact list is the page's navigation, so it gets a slightly deeper preview.
const CONTACT_PREVIEW_ROWS = 8;

function ShowAllToggle({
  total,
  expanded,
  onToggle,
  preview = PREVIEW_ROWS,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
  preview?: number;
}) {
  if (total <= preview) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 w-full text-[11px] text-muted-foreground"
      onClick={onToggle}
    >
      {expanded ? "Show less" : `Show all ${total}`}
    </Button>
  );
}

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

// Text size travels with className so callers can scale the initial along
// with the circle instead of fighting a baked-in font size.
function Avatar({ name, className = "size-8 text-sm" }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-primary ${className}`}
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
      className={`flex w-full items-center gap-2 border-s-2 px-3 py-1.5 text-start transition-colors hover:bg-muted/60 ${
        selected ? "border-primary bg-primary/10" : "border-transparent"
      }`}
    >
      <Avatar name={person.display_name ?? person.wa_id} className="size-6 text-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" dir="auto">
          {person.display_name ?? person.wa_id}
        </p>
        <p className="truncate text-[10px] text-muted-foreground">
          {/* Phone tail disambiguates same-name contacts (one person, two
              phones is a real case) — without it two identical rows are a
              coin flip. */}
          <span dir="ltr">…{person.wa_id.replace(/@.*$/, "").slice(-4)}</span> ·{" "}
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
      {/* Single compact band — identity is context, not the payload; the
          conversation below gets the space instead. */}
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
        <Avatar name={p.display_name ?? p.wa_id} className="size-10 text-base" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" dir="auto">
            {p.display_name ?? p.wa_id}
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" dir="ltr">
            {p.wa_id} · first seen {new Date(p.first_seen_at).toLocaleDateString("en-GB")} ·
            last seen {new Date(p.last_seen_at).toLocaleString("en-GB")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <FunnelStageBadge stage={p.funnel_stage} />
          {p.language && (
            <Badge variant="outline" className="text-[10px] uppercase">
              {p.language}
            </Badge>
          )}
          {p.sentiment && (
            <Badge variant="outline" className="text-[10px]">
              {p.sentiment}
            </Badge>
          )}
        </div>
        {detail.groups.length > 0 && (
          <div className="flex basis-full flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">Groups</span>
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

// Keyed by person id at the call site so preview expansion resets on every
// contact switch, whichever way the selection changed (click or URL).
function FactsCard({ personId, facts }: { personId: string; facts: PersonListItem["facts"] }) {
  const qc = useQueryClient();
  const deleteFactFn = useServerFn(deletePersonFact);
  const [expanded, setExpanded] = useState(false);
  const removeFact = useMutation({
    mutationFn: (factText: string) => deleteFactFn({ data: { personId, factText } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person-detail", personId] });
      qc.invalidateQueries({ queryKey: ["people-memory"] });
      toast.success("Fact removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Newest first, so the preview window shows what the bot learned last.
  const ordered = facts.slice().reverse();
  const shown = expanded ? ordered : ordered.slice(0, PREVIEW_ROWS);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0 p-4 pb-2">
        <Brain className="size-4 text-primary" />
        <CardTitle className="text-sm">What the bot knows</CardTitle>
        <Badge variant="secondary" className="ms-auto text-[10px]">
          {facts.length}
        </Badge>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {facts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Facts are extracted automatically after each conversation.
          </p>
        ) : (
          <>
            <ul className="space-y-1">
              {shown.map((f) => (
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
            <ShowAllToggle
              total={ordered.length}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Keyed by person id at the call site — same reset rule as FactsCard.
function IntentsCard({ intents }: { intents: PersonDetail["intents"] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? intents : intents.slice(0, PREVIEW_ROWS);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0 p-4 pb-2">
        <TrendingUp className="size-4 text-primary" />
        <CardTitle className="text-sm">Intent history</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {intents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Appears after the bot analyzes their messages.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {shown.map((i, idx) => (
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
            <ShowAllToggle
              total={intents.length}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
            />
          </>
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
      <CardHeader className="flex-row items-center gap-2 space-y-0 p-4 pb-2">
        <MessageSquare className="size-4 text-primary" />
        <CardTitle className="text-sm">Conversation</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {timeline.length === 0 ? (
          <p className="text-xs text-muted-foreground">No direct 1:1 conversation yet.</p>
        ) : (
          /* Deliberately the tallest thing on the page — the raw conversation
             is the payload the compacted cards make room for. */
          <div ref={scrollRef} className="max-h-[30rem] space-y-1.5 overflow-y-auto pe-1">
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
      <CardHeader className="flex-row items-center gap-2 space-y-0 p-4 pb-2">
        <Sparkles className="size-4 text-primary" />
        <CardTitle className="text-sm">Ask the AI about this contact</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
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
  const [allContacts, setAllContacts] = useState(false);

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

  const searching = search.trim().length > 0;
  // Search results always show every match — hiding matches behind the
  // toggle would make the search look broken. A deep-linked selection beyond
  // the preview is pinned in so the highlighted row is always visible.
  const visibleContacts = useMemo(() => {
    if (searching || allContacts) return filtered;
    const preview = filtered.slice(0, CONTACT_PREVIEW_ROWS);
    if (selected && !preview.some((p) => p.id === selected)) {
      const selectedRow = filtered.find((p) => p.id === selected);
      if (selectedRow) return [...preview, selectedRow];
    }
    return preview;
  }, [filtered, searching, allContacts, selected]);

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
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
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
              {/* ~45vh cap keeps the pane above the fold — search covers rows scrolled away */}
              <div className="max-h-[45vh] divide-y overflow-y-auto">
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
                {visibleContacts.map((person) => (
                  <ContactRow
                    key={person.id}
                    person={person}
                    selected={selected === person.id}
                    onSelect={() => selectPerson(person.id)}
                  />
                ))}
              </div>
              {!searching && filtered.length > CONTACT_PREVIEW_ROWS && (
                <div className="border-t p-1">
                  <ShowAllToggle
                    total={filtered.length}
                    preview={CONTACT_PREVIEW_ROWS}
                    expanded={allContacts}
                    onToggle={() => setAllContacts((v) => !v)}
                  />
                </div>
              )}
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
              <CardContent className="p-4">
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
            <div className="space-y-4">
              <IdentityCard detail={detail} />
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="space-y-4">
                  {/* person-id keys reset each card's preview expansion on contact switch */}
                  <FactsCard
                    key={`facts-${detail.person.id}`}
                    personId={detail.person.id}
                    facts={detail.person.facts}
                  />
                  <IntentsCard key={`intents-${detail.person.id}`} intents={detail.intents} />
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
