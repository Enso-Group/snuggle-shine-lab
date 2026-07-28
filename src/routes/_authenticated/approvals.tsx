import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Send,
  Trash2,
  Pencil,
  Check,
  X,
  Inbox,
  CheckCircle2,
  Paperclip,
  FileText,
  Loader2,
} from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import {
  listPendingApprovals,
  approvePending,
  rejectPending,
  updatePendingBody,
} from "@/lib/schedule.functions";
import { uploadMedia, setApprovalMedia } from "@/lib/media.functions";
import type { MediaAttachment } from "@/lib/media";
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
  media?: MediaAttachment | null;
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
  const uploadFn = useServerFn(uploadMedia);
  const setMediaFn = useServerFn(setApprovalMedia);

  const { data: realRows = [] } = useQuery({
    queryKey: ["scheduled-approvals"],
    queryFn: () => listFn() as Promise<Approval[]>,
    refetchInterval: 15000,
    enabled: !DEMO_MODE,
  });
  const rows = DEMO_MODE ? (demoApprovals as unknown as Approval[]) : realRows;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["scheduled-approvals"] });
    // Deciding an approval moves the linked planned post between the Command
    // Center's Upcoming and Recent panels — refresh those without a reload.
    qc.invalidateQueries({ queryKey: ["group-activity"] });
  };

  const approve = useMutation({
    mutationFn: async ({ id, body }: { id: string; body?: string }) => {
      if (DEMO_MODE) return;
      return approveFn({ data: { id, body } });
    },
    onSuccess: (res) => {
      invalidate();
      const warnings = (res as { warnings?: string[] } | undefined)?.warnings ?? [];
      if (warnings.length) {
        warnings.forEach((w) => toast.warning(w, { duration: 12000 }));
      } else {
        toast.success("Sent");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: async (id: string) => {
      if (DEMO_MODE) return;
      return rejectFn({ data: { id } });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const updateBody = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      if (DEMO_MODE) return;
      return updateFn({ data: { id, body } });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const attach = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      if (DEMO_MODE) return;
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read the file"));
        reader.readAsDataURL(file);
      });
      const media = await uploadFn({
        data: { filename: file.name, mime: file.type || "application/octet-stream", dataBase64 },
      });
      await setMediaFn({ data: { id, media } });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Attachment added — it will be sent with the message");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMedia = useMutation({
    mutationFn: async (id: string) => {
      if (DEMO_MODE) return;
      return setMediaFn({ data: { id, media: null } });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Attachment removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="min-h-full">
      <PageHeader
        icon={Inbox}
        title="Approvals"
        description='When "Require approval" is on, every message the bot wants to send appears here. You can send, edit and send, or delete.'
        actions={
          rows.length > 0 && (
            <Badge variant="secondary" className="font-normal">
              {rows.length} waiting
            </Badge>
          )
        }
      />

      <PageContent maxWidthClass="max-w-4xl" className="space-y-3">
        {rows.length === 0 && (
          <Card>
            <CardContent>
              <EmptyState
                icon={CheckCircle2}
                title="No messages waiting for approval 🎉"
                description="When the bot wants to send a message and approval is required, it will appear here."
              />
            </CardContent>
          </Card>
        )}

        {rows.map((r) => (
          <ApprovalCard
            key={r.id}
            row={r}
            onApprove={(body) => approve.mutate({ id: r.id, body })}
            onReject={() => reject.mutate(r.id)}
            onSaveEdit={(body) => updateBody.mutate({ id: r.id, body })}
            onAttach={(file) => attach.mutate({ id: r.id, file })}
            onRemoveMedia={() => removeMedia.mutate(r.id)}
            uploading={attach.isPending && attach.variables?.id === r.id}
            pending={approve.isPending || reject.isPending || updateBody.isPending}
          />
        ))}
      </PageContent>
    </div>
  );
}

function MediaPreview({ media, onRemove }: { media: MediaAttachment; onRemove?: () => void }) {
  return (
    <div className="rounded-md border bg-muted/20 p-2 space-y-2">
      {media.kind === "image" && (
        <img
          src={media.url}
          alt={media.filename ?? "attachment"}
          className="max-h-48 rounded-md object-contain"
        />
      )}
      {media.kind === "video" && (
        <video src={media.url} controls className="max-h-48 rounded-md" preload="metadata" />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          {media.kind === "document" && <FileText className="size-3.5 shrink-0" />}
          <span className="truncate">
            {media.filename ?? media.url.split("/").pop()} · sent as a WhatsApp {media.kind}
          </span>
        </span>
        {onRemove && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-destructive"
            onClick={onRemove}
          >
            <X className="size-3" />
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({
  row,
  onApprove,
  onReject,
  onSaveEdit,
  onAttach,
  onRemoveMedia,
  uploading,
  pending,
}: {
  row: Approval;
  onApprove: (body?: string) => void;
  onReject: () => void;
  onSaveEdit: (body: string) => void;
  onAttach: (file: File) => void;
  onRemoveMedia: () => void;
  uploading: boolean;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.body);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="truncate">{row.target_name ?? row.target_chat_id}</span>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-xs">
              {SOURCE_LABEL[row.source] ?? row.source}
            </Badge>
            <span className="text-xs text-muted-foreground font-normal">
              {new Date(row.created_at).toLocaleString("en-US")}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            className="text-sm"
          />
        ) : (
          <p className="text-sm whitespace-pre-wrap rounded-md border bg-muted/30 p-3" dir="auto">
            {row.body}
          </p>
        )}

        {(() => {
          const poll = (row as { poll?: { question?: string; options?: string[] } | null }).poll;
          if (!poll?.question || !Array.isArray(poll.options)) return null;
          return (
            <div
              className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
              dir="auto"
            >
              <p className="font-medium">📊 {poll.question}</p>
              <ul className="mt-1.5 space-y-1">
                {poll.options.map((o, i) => (
                  <li key={i} className="rounded border bg-background px-2 py-1 text-xs">
                    {o}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Sent as a native tappable WhatsApp poll on approval.
              </p>
            </div>
          );
        })()}

        {row.media && <MediaPreview media={row.media} onRemove={onRemoveMedia} />}

        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                onClick={() => onApprove(draft)}
                disabled={pending || !draft.trim()}
              >
                <Check className="size-3 ms-1" />
                Save and send
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onSaveEdit(draft);
                  setEditing(false);
                }}
                disabled={pending || !draft.trim()}
              >
                Save without sending
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(row.body);
                  setEditing(false);
                }}
              >
                <X className="size-3 ms-1" />
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => onApprove()} disabled={pending}>
                <Send className="size-3 ms-1" />
                Send
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(row.body);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3 ms-1" />
                Edit
              </Button>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept="image/*,video/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onAttach(f);
                  e.target.value = "";
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileInput.current?.click()}
                disabled={uploading || pending}
              >
                {uploading ? (
                  <Loader2 className="size-3 ms-1 animate-spin" />
                ) : (
                  <Paperclip className="size-3 ms-1" />
                )}
                {row.media ? "Replace attachment" : "Attach"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={onReject}
                disabled={pending}
              >
                <Trash2 className="size-3 ms-1" />
                Delete
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
