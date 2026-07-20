import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Brain, User, X } from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import { deletePersonFact, listPeople } from "@/lib/people.functions";

export const Route = createFileRoute("/_authenticated/people")({
  head: () => ({ meta: [{ title: "People Memory — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAdmin?: boolean }).isAdmin) throw redirect({ to: "/" });
  },
  component: PeoplePage,
});

const STAGE_STYLES: Record<string, string> = {
  lead: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  customer: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  vip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  community: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  churned: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

function PeoplePage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPeople);
  const deleteFactFn = useServerFn(deletePersonFact);

  const { data: people = [] } = useQuery({
    queryKey: ["people-memory"],
    queryFn: () => listFn(),
    refetchInterval: 30000,
  });

  const removeFact = useMutation({
    mutationFn: (args: { personId: string; factText: string }) => deleteFactFn({ data: args }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["people-memory"] });
      toast.success("Fact removed from memory");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-full">
      <PageHeader
        icon={Brain}
        title="People Memory"
        description="What the bot has learned about each contact — it uses this to make every conversation feel remembered."
        maxWidthClass="max-w-4xl"
        actions={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <User className="size-3" />
            {people.length} people
          </Badge>
        }
      />

      <PageContent maxWidthClass="max-w-4xl">
        {people.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                icon={Brain}
                title="No memory yet"
                description="Profiles appear here automatically after the bot's first conversation with each person."
              />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {people.map((p) => (
              <Card key={p.id}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" dir="auto">
                        {p.display_name ?? p.wa_id}
                      </p>
                      <p className="truncate text-xs text-muted-foreground" dir="ltr">
                        {p.wa_id} · seen {new Date(p.last_seen_at).toLocaleString("en-GB")}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {p.language && (
                        <Badge variant="outline" className="text-xs uppercase">
                          {p.language}
                        </Badge>
                      )}
                      <Badge
                        className={`text-xs ${STAGE_STYLES[p.funnel_stage] ?? "bg-muted text-muted-foreground"}`}
                        variant="secondary"
                      >
                        {p.funnel_stage}
                      </Badge>
                    </div>
                  </div>
                  {p.facts.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t pt-3">
                      {p.facts
                        .slice()
                        .reverse()
                        .map((f) => (
                          <li
                            key={f.at + f.text}
                            className="group flex items-start gap-2 text-xs"
                            dir="auto"
                          >
                            <span className="mt-1 size-1 shrink-0 rounded-full bg-primary/50" />
                            <span className="flex-1 text-muted-foreground">{f.text}</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                              title="Remove this fact"
                              onClick={() =>
                                removeFact.mutate({ personId: p.id, factText: f.text })
                              }
                            >
                              <X className="size-3" />
                            </Button>
                          </li>
                        ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </PageContent>
    </div>
  );
}
