import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  listGroupConversations,
  listGroupParticipants,
  getParticipantMessages,
} from "@/lib/participants.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Users, MessageSquare } from "lucide-react";

export const Route = createFileRoute("/_authenticated/participants")({
  ssr: false,
  component: ParticipantsPage,
});

type Group = { id: string; name: string | null; whapi_chat_id: string; last_message_at: string | null; inbound_count: number | null };
type Participant = { sender_id: string; sender_name: string; message_count: number; last_message_at: string; last_body: string };
type Msg = { id: string; body: string | null; created_at: string; sender_name: string | null; sender_id: string | null };

function ParticipantsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string>("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingParts, setLoadingParts] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Participant | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  useEffect(() => {
    listGroupConversations()
      .then((r) => setGroups(r as Group[]))
      .finally(() => setLoadingGroups(false));
  }, []);

  useEffect(() => {
    if (!groupId) return;
    setLoadingParts(true);
    setParticipants([]);
    listGroupParticipants({ data: { conversationId: groupId } })
      .then((r) => setParticipants(r as Participant[]))
      .finally(() => setLoadingParts(false));
  }, [groupId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter(
      (p) =>
        p.sender_name.toLowerCase().includes(q) ||
        p.sender_id.toLowerCase().includes(q),
    );
  }, [filter, participants]);

  async function openParticipant(p: Participant) {
    setSelected(p);
    setMsgs(null);
    setLoadingMsgs(true);
    try {
      const r = await getParticipantMessages({
        data: { conversationId: groupId, senderId: p.sender_id || p.sender_name },
      });
      setMsgs(r as Msg[]);
    } finally {
      setLoadingMsgs(false);
    }
  }

  const selectedGroup = groups.find((g) => g.id === groupId);

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="size-6" /> משתתפים בקבוצה
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          בחר קבוצה כדי לראות את כל המשתתפים. לחיצה על משתתף תפתח את כל ההודעות שלו בקבוצה.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <Select value={groupId} onValueChange={setGroupId} disabled={loadingGroups}>
            <SelectTrigger>
              <SelectValue placeholder={loadingGroups ? "טוען קבוצות…" : "בחר קבוצה"} />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name ?? g.whapi_chat_id}
                </SelectItem>
              ))}
              {!loadingGroups && groups.length === 0 && (
                <div className="px-2 py-3 text-sm text-muted-foreground">אין קבוצות שמורות עדיין</div>
              )}
            </SelectContent>
          </Select>
        </div>
        <Input
          placeholder="סנן משתתפים…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="sm:max-w-xs"
          disabled={!groupId}
        />
      </div>

      {groupId && (
        <div className="border rounded-lg overflow-hidden bg-card">
          {loadingParts ? (
            <div className="p-6 text-sm text-muted-foreground">טוען משתתפים…</div>
          ) : participants.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              אין הודעות נכנסות שמורות עבור הקבוצה הזו.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">משתתף</TableHead>
                  <TableHead className="text-right">מזהה</TableHead>
                  <TableHead className="text-right">מס׳ הודעות</TableHead>
                  <TableHead className="text-right">הודעה אחרונה</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow
                    key={p.sender_id || p.sender_name}
                    className="cursor-pointer"
                    onClick={() => openParticipant(p)}
                  >
                    <TableCell className="font-medium">{p.sender_name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" dir="ltr">
                      {p.sender_id}
                    </TableCell>
                    <TableCell>{p.message_count}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(p.last_message_at).toLocaleString("he-IL")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="left" className="w-full sm:max-w-xl flex flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              {selected?.sender_name}
            </SheetTitle>
            <SheetDescription>
              הודעות בקבוצה {selectedGroup?.name ?? ""} ({msgs?.length ?? 0})
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-auto mt-4 space-y-2 pl-1">
            {loadingMsgs && <div className="text-sm text-muted-foreground">טוען הודעות…</div>}
            {!loadingMsgs && msgs?.length === 0 && (
              <div className="text-sm text-muted-foreground">אין הודעות שמורות.</div>
            )}
            {msgs?.map((m) => (
              <div key={m.id} className="rounded-lg border bg-muted/30 px-3 py-2">
                <div className="text-[11px] text-muted-foreground mb-1">
                  {new Date(m.created_at).toLocaleString("he-IL")}
                </div>
                <div className="text-sm whitespace-pre-wrap break-words">{m.body || "—"}</div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
