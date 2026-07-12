import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Users, Trash2, ShieldCheck } from "lucide-react";
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

  const reject = useMutation({
    mutationFn: (userId: string) => rejectFn({ data: { userId } }),
    onSuccess: () => { invalidate(); toast.success("User rejected"); },
    onError: (e: any) => toast.error(e.message),
  });

  const busy = changeRole.isPending || reject.isPending;

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Users className="size-7" />
          User Management
        </h1>
        <p className="text-muted-foreground mt-1">
          View all registered users, approve or reject them, and set each user's role.
        </p>
      </div>

      <div className="space-y-3">
        {users.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">No users yet.</CardContent>
          </Card>
        )}

        {users.map((u) => (
          <Card key={u.id}>
            <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate">{u.email}</p>
                  {u.isAdminEmail ? (
                    <Badge variant="default" className="gap-1 text-xs"><ShieldCheck className="size-3" />Administrator</Badge>
                  ) : u.role ? (
                    <Badge variant="secondary" className="text-xs">Approved</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-700 dark:text-amber-400">Pending</Badge>
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
    </div>
  );
}
