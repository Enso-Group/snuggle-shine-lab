import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Send, Trash2, Pencil, Check, X, Inbox } from "lucide-react";
import {
  listPendingApprovals,
  approvePending,
  rejectPending,
  updatePendingBody,
} from "@/lib/schedule.functions";
import { DEMO_MODE, demoApprovals } from "@/lib/demo";

export const Route = createFileRoute("/_authenticated/approvals")({
  head: () => ({ meta: [{ title: "Approvals — WhatsApp Bot" }] }),
  component: ApprovalsPage,
});

type Approval = {
  id: string;
  target_chat_id: string;
  target_name: string | null;
  body: string;
  source: string;
  created_at: string;
};

const SOURCE_LABEL: Record<string, string> = {
  ai_reply: "AI reply",
  schedule: "Scheduled",
  manual: "Manual",
};

function ApprovalsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPendingApprovals);
  const approveFn = useServerFn(approvePending);
  const rejectFn = useServerFn(rejectPending);
  const updateFn = useServerFn(updatePendingBody);

  const { data: realRows = [] } = useQuery({
    queryKey: ["scheduled-approvals"],
    queryFn: () => listFn() as Promise<Approval[]>,
    refetchInterval: 15000,
    enabled: !DEMO_MODE,
  });
  const rows = DEMO_MODE ? (demoApprovals as unknown as Approval[]) : realRows;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["scheduled-approvals"] });

  const approve = useMutation({
    mutationFn: async ({ id, body }: { id: string; body?: string }) => { if (DEMO_MODE) return; return approveFn({ data: { id, body } }); },
    onSuccess: () => { invalidate(); toast.success("Sent"); },
    onError: (e: any) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: async (id: string) => { if (DEMO_MODE) return; return rejectFn({ data: { id } }); },
    onSuccess: () => { invalidate(); toast.success("Deleted"); },
    onError: (e: any) => toast.error(e.message),
  });
  const updateBody = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => { if (DEMO_MODE) return; return updateFn({ data: { id, body } }); },
    onSuccess: () => { invalidate(); toast.success("Updated"); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Inbox className="size-7" />
          Approvals
        </h1>
        <p className="text-muted-foreground mt-1">
          When "Require approval" is on, every message the bot wants to send appears here. You can send, edit and send, or delete.
        </p>
      </div>

      {rows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No messages waiting for approval 🎉
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((r) => (
          <ApprovalCard
            key={r.id}
            row={r}
            onApprove={(body) => approve.mutate({ id: r.id, body })}
            onReject={() => reject.mutate(r.id)}
            onSaveEdit={(body) => updateBody.mutate({ id: r.id, body })}
            pending={approve.isPending || reject.isPending || updateBody.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({
  row,
  onApprove,
  onReject,
  onSaveEdit,
  pending,
}: {
  row: Approval;
  onApprove: (body?: string) => void;
  onReject: () => void;
  onSaveEdit: (body: string) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.body);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="truncate">{row.target_name ?? row.target_chat_id}</span>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-xs">{SOURCE_LABEL[row.source] ?? row.source}</Badge>
            <span className="text-xs text-muted-foreground font-normal">
              {new Date(row.created_at).toLocaleString("en-US")}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} className="text-sm" />
        ) : (
          <p className="text-sm whitespace-pre-wrap rounded-md border bg-muted/30 p-3">{row.body}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button size="sm" onClick={() => onApprove(draft)} disabled={pending || !draft.trim()}>
                <Check className="size-3 ms-1" />Save and send
              </Button>
              <Button size="sm" variant="outline" onClick={() => { onSaveEdit(draft); setEditing(false); }} disabled={pending || !draft.trim()}>
                Save without sending
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(row.body); setEditing(false); }}>
                <X className="size-3 ms-1" />Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => onApprove()} disabled={pending}>
                <Send className="size-3 ms-1" />Send
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setDraft(row.body); setEditing(true); }}>
                <Pencil className="size-3 ms-1" />Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={onReject} disabled={pending}>
                <Trash2 className="size-3 ms-1" />Delete
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
