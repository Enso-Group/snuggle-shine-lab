import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Check, X, UserCheck } from "lucide-react";
import { listPendingUsers, approveUser, rejectUser } from "@/lib/users.functions";

export const Route = createFileRoute("/_authenticated/approval-requests")({
  head: () => ({ meta: [{ title: "Approval Requests — WhatsApp Bot" }] }),
  // Admin-only: non-admins are redirected to the dashboard.
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: ApprovalRequestsPage,
});

type PendingUser = { id: string; email: string; created_at: string };

function ApprovalRequestsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPendingUsers);
  const approveFn = useServerFn(approveUser);
  const rejectFn = useServerFn(rejectUser);

  const { data: rows = [] } = useQuery({
    queryKey: ["pending-users"],
    queryFn: () => listFn() as Promise<PendingUser[]>,
    refetchInterval: 15000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["pending-users"] });

  const approve = useMutation({
    mutationFn: (userId: string) => approveFn({ data: { userId } }),
    onSuccess: () => { invalidate(); toast.success("User approved"); },
    onError: (e: any) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: (userId: string) => rejectFn({ data: { userId } }),
    onSuccess: () => { invalidate(); toast.success("User rejected"); },
    onError: (e: any) => toast.error(e.message),
  });

  const pending = approve.isPending || reject.isPending;

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <UserCheck className="size-7" />
          Approval Requests
        </h1>
        <p className="text-muted-foreground mt-1">
          New users appear here after signing up. Approve to grant access, or reject to remove the account.
        </p>
      </div>

      {rows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No pending requests 🎉
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((u) => (
          <Card key={u.id}>
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium truncate">{u.email}</p>
                <p className="text-xs text-muted-foreground">
                  Registered {new Date(u.created_at).toLocaleString("en-US")}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button size="sm" onClick={() => approve.mutate(u.id)} disabled={pending}>
                  <Check className="size-3 ms-1" />Approve
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => reject.mutate(u.id)} disabled={pending}>
                  <X className="size-3 ms-1" />Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
