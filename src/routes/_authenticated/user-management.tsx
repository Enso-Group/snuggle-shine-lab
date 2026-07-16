import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, ShieldCheck, Check, X, UserCheck, UserCog } from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import {
  listAllUsers,
  setUserRole,
  setUserPending,
  rejectUser,
  type ManagedUser,
} from "@/lib/users.functions";

export const Route = createFileRoute("/_authenticated/user-management")({
  head: () => ({ meta: [{ title: "User Management — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: UserManagementPage,
});

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  user: "User / Employee",
};

function UserManagementPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listAllUsers);
  const setRoleFn = useServerFn(setUserRole);
  const setPendingFn = useServerFn(setUserPending);
  const rejectFn = useServerFn(rejectUser);

  const { data: users = [] } = useQuery({
    queryKey: ["all-users"],
    queryFn: () => listFn() as Promise<ManagedUser[]>,
    refetchInterval: 15000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["all-users"] });

  const changeRole = useMutation({
    mutationFn: ({ userId, value }: { userId: string; value: string }) =>
      value === "pending"
        ? setPendingFn({ data: { userId } })
        : setRoleFn({ data: { userId, role: value as any } }),
    onSuccess: () => { invalidate(); toast.success("Saved"); },
    onError: (e: any) => toast.error(e.message),
  });

  const approve = useMutation({
    mutationFn: (userId: string) => setRoleFn({ data: { userId, role: "user" } }),
    onSuccess: () => { invalidate(); toast.success("User approved"); },
    onError: (e: any) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: (userId: string) => rejectFn({ data: { userId } }),
    onSuccess: () => { invalidate(); toast.success("User rejected"); },
    onError: (e: any) => toast.error(e.message),
  });

  const busy = changeRole.isPending || approve.isPending || reject.isPending;

  const pending = users.filter((u) => !u.isAdminEmail && !u.role);
  const active = users.filter((u) => u.isAdminEmail || u.role);

  return (
    <div className="min-h-full">
      <PageHeader
        icon={UserCog}
        title="User Management"
        description="Approve or reject new users, and set each user's role."
        actions={
          <>
            {pending.length > 0 && (
              <Badge variant="secondary" className="gap-1.5 font-normal text-amber-700 dark:text-amber-400">
                <UserCheck className="size-3" />
                {pending.length} pending
              </Badge>
            )}
            <Badge variant="secondary" className="font-normal">
              {active.length} users
            </Badge>
          </>
        }
      />

      <PageContent maxWidthClass="max-w-4xl">
      {/* Pending approvals */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <UserCheck className="size-4" />
          Pending approvals ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState icon={UserCheck} title="No pending requests 🎉" description="New sign-ups waiting for approval will appear here." />
            </CardContent>
          </Card>
        ) : (
          pending.map((u) => (
            <Card key={u.id} className="border-amber-500/40">
              <CardContent className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{u.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Registered {new Date(u.created_at).toLocaleString("en-US")}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" onClick={() => approve.mutate(u.id)} disabled={busy}>
                    <Check className="size-3 ms-1" />Approve
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => reject.mutate(u.id)} disabled={busy}>
                    <X className="size-3 ms-1" />Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* All users + roles */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          All users ({active.length})
        </h2>
        {active.map((u) => (
          <Card key={u.id}>
            <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate">{u.email}</p>
                  {u.isAdminEmail ? (
                    <Badge variant="default" className="gap-1 text-xs"><ShieldCheck className="size-3" />Administrator</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">Approved</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Registered {new Date(u.created_at).toLocaleString("en-US")}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {u.isAdminEmail ? (
                  <span className="text-sm text-muted-foreground">Admin (locked)</span>
                ) : (
                  <>
                    <Select
                      value={u.role ?? "pending"}
                      onValueChange={(value) => changeRole.mutate({ userId: u.id, value })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending (no access)</SelectItem>
                        <SelectItem value="admin">{ROLE_LABEL.admin}</SelectItem>
                        <SelectItem value="manager">{ROLE_LABEL.manager}</SelectItem>
                        <SelectItem value="user">{ROLE_LABEL.user}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive"
                      title="Reject / delete account"
                      onClick={() => {
                        if (window.confirm(`Reject and delete ${u.email}? This cannot be undone.`)) reject.mutate(u.id);
                      }}
                      disabled={busy}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      </PageContent>
    </div>
  );
}
