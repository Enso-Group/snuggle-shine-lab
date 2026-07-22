import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Trash2, ShieldCheck, Plus, Mail, UserCog, MailPlus, Users } from "lucide-react";
import { PageHeader, PageContent, EmptyState } from "@/components/page-header";
import { listInvitedEmails, addInvitedEmail, removeInvitedEmail } from "@/lib/invites.functions";
import { listAllUsers, type ManagedUser } from "@/lib/users.functions";
import { isAdminEmail } from "@/lib/admin";

export const Route = createFileRoute("/_authenticated/user-management")({
  head: () => ({ meta: [{ title: "User Management — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: UserManagementPage,
});

function UserManagementPage() {
  const qc = useQueryClient();
  const listInvitesFn = useServerFn(listInvitedEmails);
  const addInviteFn = useServerFn(addInvitedEmail);
  const removeInviteFn = useServerFn(removeInvitedEmail);
  const listUsersFn = useServerFn(listAllUsers);

  const [newEmail, setNewEmail] = useState("");

  const { data: invites = [] } = useQuery({
    queryKey: ["invited-emails"],
    queryFn: () => listInvitesFn(),
    refetchInterval: 30000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ["all-users"],
    queryFn: () => listUsersFn() as Promise<ManagedUser[]>,
    refetchInterval: 30000,
  });

  const invitedSet = useMemo(() => new Set(invites.map((i) => i.email.toLowerCase())), [invites]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["invited-emails"] });
    qc.invalidateQueries({ queryKey: ["all-users"] });
  };

  const add = useMutation({
    mutationFn: (email: string) => addInviteFn({ data: { email } }),
    onSuccess: () => {
      invalidate();
      setNewEmail("");
      toast.success("Email invited");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (email: string) => removeInviteFn({ data: { email } }),
    onSuccess: () => {
      invalidate();
      toast.success("Invite removed");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const busy = add.isPending || remove.isPending;

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (invitedSet.has(email)) {
      toast.info("That email is already invited");
      return;
    }
    add.mutate(email);
  }

  return (
    <div className="min-h-full">
      <PageHeader
        icon={UserCog}
        title="User Management"
        description="Invite-only access — only emails on this list can sign in with Google."
        maxWidthClass="max-w-4xl"
        actions={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <Mail className="size-3" />
            {invites.length} invited
          </Badge>
        }
      />

      <PageContent maxWidthClass="max-w-4xl">
        {/* Add an invite */}
        <Card>
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <MailPlus className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Invite an email</h2>
            </div>
            <form onSubmit={submitAdd} className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                placeholder="name@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                dir="ltr"
                className="sm:flex-1"
              />
              <Button type="submit" disabled={busy || !newEmail.trim()} className="gap-2">
                <Plus className="size-4" />
                Add to invite list
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              They can sign in as soon as they're added — no password needed, just their Google
              account.
            </p>
          </CardContent>
        </Card>

        {/* Invited emails */}
        <div className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Mail className="size-4" />
            Invited emails ({invites.length})
          </h2>
          {invites.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={Mail}
                  title="No one is invited yet"
                  description="Add an email above to let someone sign in."
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="divide-y p-0">
                {invites.map((inv) => {
                  const admin = isAdminEmail(inv.email);
                  const hasAccount = users.some(
                    (u) => u.email.toLowerCase() === inv.email.toLowerCase(),
                  );
                  return (
                    <div key={inv.email} className="flex items-center gap-3 p-4">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Mail className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" dir="ltr">
                          {inv.email}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {admin
                            ? "Administrator"
                            : hasAccount
                              ? "Signed in at least once"
                              : "Invited — hasn't signed in yet"}
                        </p>
                      </div>
                      {admin ? (
                        <Badge variant="default" className="gap-1 text-xs">
                          <ShieldCheck className="size-3" />
                          Admin
                        </Badge>
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 shrink-0 text-destructive"
                          title="Remove from invite list"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${inv.email} from the invite list? They'll lose access on their next visit. Their existing data is kept.`,
                              )
                            )
                              remove.mutate(inv.email);
                          }}
                          disabled={busy}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Registered accounts (read-only overview) */}
        {users.length > 0 && (
          <div className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="size-4" />
              Registered accounts ({users.length})
            </h2>
            <Card>
              <CardContent className="divide-y p-0">
                {users.map((u) => {
                  const invited = invitedSet.has(u.email.toLowerCase()) || u.isAdminEmail;
                  return (
                    <div key={u.id} className="flex items-center gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" dir="ltr">
                          {u.email}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Registered {new Date(u.created_at).toLocaleString("en-US")}
                        </p>
                      </div>
                      {invited ? (
                        <Badge variant="secondary" className="text-xs">
                          {u.isAdminEmail ? "Admin" : "Invited"}
                        </Badge>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            Not invited
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5"
                            onClick={() => add.mutate(u.email.toLowerCase())}
                            disabled={busy}
                          >
                            <Plus className="size-3.5" />
                            Invite
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        )}
      </PageContent>
    </div>
  );
}
