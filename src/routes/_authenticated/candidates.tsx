import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Loader2, User, Mail, Phone, Building2, Search, Users, Linkedin,
  ChevronDown, ChevronUp, CheckSquare, Square,
} from "lucide-react";
import {
  scanGroupsForCandidates,
  enrichCandidate,
  listGroupsForSourcing,
} from "@/lib/sourcing.functions";
import type { EnrichedCandidate } from "@/lib/sourcing.functions";

export const Route = createFileRoute("/_authenticated/candidates")({
  head: () => ({ meta: [{ title: "Candidates — Talent Sourcing" }] }),
  component: CandidatesPage,
});

type CandidateState = EnrichedCandidate & { enriching?: boolean; enrichError?: string };

function CandidatesPage() {
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<"idle" | "scanning" | "enriching" | "done">("idle");
  const [candidates, setCandidates] = useState<CandidateState[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);

  // Group picker
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [groupsExpanded, setGroupsExpanded] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [groupSearch, setGroupSearch] = useState("");

  const listGroupsFn = useServerFn(listGroupsForSourcing);
  const scanFn = useServerFn(scanGroupsForCandidates);
  const enrichFn = useServerFn(enrichCandidate);

  // Load groups on mount
  useEffect(() => {
    listGroupsFn()
      .then((gs) => {
        setGroups(gs);
        setSelectedGroups(new Set(gs.map((g) => g.id)));
      })
      .catch(() => {})
      .finally(() => setLoadingGroups(false));
  }, []);

  function toggleGroup(id: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedGroups(new Set(groups.map((g) => g.id)));
  }

  function selectNone() {
    setSelectedGroups(new Set());
  }

  async function handleSearch() {
    if (!description.trim() || phase !== "idle") return;
    if (selectedGroups.size === 0) return;

    setPhase("scanning");
    setScanError(null);
    setCandidates([]);

    let rawCandidates: any[] = [];
    try {
      rawCandidates = await scanFn({
        data: {
          description,
          groupIds: [...selectedGroups],
        },
      });
    } catch (e: any) {
      setScanError(e.message || "Scan failed");
      setPhase("idle");
      return;
    }

    if (!rawCandidates.length) {
      setPhase("done");
      return;
    }

    // Show basic cards immediately
    setCandidates(rawCandidates.map((c) => ({ ...c, enriching: true })));
    setPhase("enriching");

    // Enrich each candidate in parallel
    await Promise.allSettled(
      rawCandidates.map(async (c) => {
        try {
          const enriched = await enrichFn({ data: c });
          setCandidates((prev) =>
            prev.map((x) => (x.id === c.id ? { ...enriched, enriching: false } : x)),
          );
        } catch {
          setCandidates((prev) =>
            prev.map((x) =>
              x.id === c.id ? { ...x, enriching: false, enrichError: "Enrichment failed" } : x,
            ),
          );
        }
      }),
    );

    setPhase("done");
  }

  function reset() {
    setPhase("idle");
    setCandidates([]);
    setScanError(null);
  }

  const allSelected = selectedGroups.size === groups.length && groups.length > 0;
  const noneSelected = selectedGroups.size === 0;

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Users className="size-7" />
          Talent Sourcing
        </h1>
        <p className="text-muted-foreground mt-1">
          Scan WhatsApp groups with AI, then enrich matches via Apollo & Apify
        </p>
      </div>

      {/* Search + group picker */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <Textarea
            placeholder={`Describe who you're looking for... e.g. "Senior React developer, startup background, based in Tel Aviv"`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="resize-none text-sm"
            disabled={phase !== "idle"}
            dir="auto"
          />

          {/* Group picker */}
          <div className="border rounded-md">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium hover:bg-accent transition-colors rounded-md"
              onClick={() => setGroupsExpanded((v) => !v)}
            >
              <span className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground" />
                {loadingGroups
                  ? "Loading groups…"
                  : `${selectedGroups.size} / ${groups.length} groups selected`}
              </span>
              {groupsExpanded ? (
                <ChevronUp className="size-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-4 text-muted-foreground" />
              )}
            </button>

            {groupsExpanded && (
              <div className="border-t px-4 py-3 space-y-3">
                {/* Select all / none */}
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-primary hover:underline"
                    onClick={selectAll}
                  >
                    <CheckSquare className="size-3" />
                    Select all
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted-foreground hover:underline"
                    onClick={selectNone}
                  >
                    <Square className="size-3" />
                    None
                  </button>
                </div>

                {!loadingGroups && groups.length > 0 && (
                  <div className="relative">
                    <Search className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <Input
                      value={groupSearch}
                      onChange={(e) => setGroupSearch(e.target.value)}
                      placeholder="חיפוש קבוצה לפי שם..."
                      className="h-8 pr-8 text-sm"
                      dir="rtl"
                    />
                  </div>
                )}

                {loadingGroups ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="size-3 animate-spin" />
                    Loading groups…
                  </p>
                ) : groups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No WhatsApp groups found. Make sure the bot is connected.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-1">
                    {groups
                      .filter((g) =>
                        g.name.toLowerCase().includes(groupSearch.trim().toLowerCase()),
                      )
                      .map((g) => (
                      <div key={g.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`group-${g.id}`}
                          checked={selectedGroups.has(g.id)}
                          onCheckedChange={() => toggleGroup(g.id)}
                          disabled={phase !== "idle"}
                        />
                        <Label
                          htmlFor={`group-${g.id}`}
                          className="text-sm font-normal cursor-pointer truncate"
                        >
                          {g.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <Button
              onClick={handleSearch}
              disabled={!description.trim() || phase !== "idle" || noneSelected || loadingGroups}
              className="gap-2"
            >
              {phase === "scanning" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Scanning {selectedGroups.size} groups…
                </>
              ) : phase === "enriching" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Enriching {candidates.length} candidates…
                </>
              ) : (
                <>
                  <Search className="size-4" />
                  Scan Groups
                </>
              )}
            </Button>

            {(phase === "enriching" || phase === "done") && (
              <Button variant="outline" onClick={reset}>
                New Search
              </Button>
            )}

            {candidates.length > 0 && (
              <span className="text-sm text-muted-foreground">
                {candidates.length} candidate{candidates.length !== 1 ? "s" : ""} found
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {scanError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="pt-4 text-sm text-destructive">{scanError}</CardContent>
        </Card>
      )}

      {/* Candidate cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {candidates.map((c) => (
          <CandidateCard key={c.id} candidate={c} />
        ))}
      </div>

      {/* Empty state */}
      {phase === "done" && candidates.length === 0 && !scanError && (
        <Card>
          <CardContent className="py-14 text-center space-y-2">
            <Users className="size-10 mx-auto text-muted-foreground/30" />
            <p className="text-muted-foreground">
              No matching candidates found in the selected groups.
            </p>
            <p className="text-xs text-muted-foreground">
              Try a different description or select more groups.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CandidateCard({ candidate: c }: { candidate: CandidateState }) {
  return (
    <Card
      className={`transition-opacity ${c.enriching ? "opacity-75" : ""}`}
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="size-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="size-4 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold truncate">{c.name}</div>
              {(c.title || c.role) && (
                <div className="text-xs text-muted-foreground font-normal truncate">
                  {c.title || c.role}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0 mt-0.5">
            {c.enriching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            {c.enrichedVia?.map((v) => (
              <Badge key={v} variant="secondary" className="text-xs capitalize">
                {v}
              </Badge>
            ))}
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-2.5 text-sm">
        {/* Company */}
        {(c.companyFull || c.company) && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Building2 className="size-3.5 shrink-0" />
            <span className="truncate">{c.companyFull || c.company}</span>
          </div>
        )}

        {/* Email */}
        {c.email && (
          <div className="flex items-center gap-2">
            <Mail className="size-3.5 text-muted-foreground shrink-0" />
            <a
              href={`mailto:${c.email}`}
              className="text-primary hover:underline truncate"
            >
              {c.email}
            </a>
          </div>
        )}

        {/* Phone */}
        {c.phone && (
          <div className="flex items-center gap-2">
            <Phone className="size-3.5 text-muted-foreground shrink-0" />
            <span>{c.phone}</span>
          </div>
        )}

        {/* LinkedIn */}
        {c.linkedinUrl && (
          <div className="flex items-center gap-2">
            <Linkedin className="size-3.5 text-muted-foreground shrink-0" />
            <a
              href={c.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline truncate"
            >
              {c.linkedinUrl
                .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, "")
                .replace(/\/$/, "")}
            </a>
          </div>
        )}

        {/* Match reason */}
        <div className="rounded-md bg-muted/50 px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground mb-1">Why they match</p>
          <p className="text-xs leading-relaxed">{c.matchReason}</p>
        </div>

        {/* Source */}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 shrink-0">
            <Users className="size-3" />
            {c.groupName || c.groupId}
          </span>
          {c.sourceMessage && (
            <span
              className="italic truncate"
              title={c.sourceMessage}
            >
              "{c.sourceMessage.slice(0, 70)}
              {c.sourceMessage.length > 70 ? "…" : ""}"
            </span>
          )}
        </div>

        {c.enrichError && (
          <p className="text-xs text-destructive">{c.enrichError}</p>
        )}
      </CardContent>
    </Card>
  );
}
