// Behind the Scenes → Users & Access: invite-only Google sign-in management.
// Ported from the former User Management page.
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Mail, MailPlus, MessageCircle, Plus, ShieldCheck, Smartphone, Trash2, Users } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { listInvitedEmails, addInvitedEmail, removeInvitedEmail } from "@/lib/invites.functions";
import { listAllUsers, type ManagedUser } from "@/lib/users.functions";
import { listWaAdmins, addWaAdmin, removeWaAdmin } from "@/lib/wa-admins.functions";
import type { WaAdmin } from "@/lib/agent/wa-admins";
import { isAdminEmail } from "@/lib/admin";

export function AccessTab() {
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
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (email: string) => removeInviteFn({ data: { email } }),
    onSuccess: () => {
      invalidate();
      toast.success("Invite removed");
    },
    onError: (e: Error) => toast.error(e.message),
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
    <div className="space-y-4">
      <WhatsAppAdminsCard />
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <MailPlus className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Invite an email</h3>
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
            Access is invite-only via Google sign-in — no passwords.
          </p>
        </CardContent>
      </Card>

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
                            `Remove ${inv.email} from the invite list? They lose access on their next visit; their data is kept.`,
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

      {users.length > 0 && (
        <Card>
          <CardContent className="divide-y p-0">
            <div className="flex items-center gap-2 p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="size-4" /> Registered accounts ({users.length})
            </div>
            {users.map((u) => {
              const invited = invitedSet.has(u.email.toLowerCase()) || u.isAdminEmail;
              return (
                <div key={u.id} className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" dir="ltr">
                      {u.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Registered {new Date(u.created_at).toLocaleString("en-GB")}
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
      )}
    </div>
  );
}

/**
 * WhatsApp admins: phone numbers that get MANAGEMENT MODE when they DM the
 * bot (operate it in natural language — posts, approvals, settings, status)
 * plus proactive updates (pending approvals, errors, activity digests).
 * Verified by phone number only — display names are never trusted.
 */
function WhatsAppAdminsCard() {
  const qc = useQueryClient();
  const listFn = useServerFn(listWaAdmins);
  const addFn = useServerFn(addWaAdmin);
  const removeFn = useServerFn(removeWaAdmin);

  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");

  const { data: admins = [] } = useQuery({
    queryKey: ["wa-admins"],
    queryFn: () => listFn() as Promise<WaAdmin[]>,
    refetchInterval: 30000,
  });

  const add = useMutation({
    mutationFn: () => addFn({ data: { phone, label } }),
    onSuccess: (next) => {
      qc.setQueryData(["wa-admins"], next);
      setPhone("");
      setLabel("");
      toast.success("WhatsApp admin added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (p: string) => removeFn({ data: { phone: p } }),
    onSuccess: (next) => {
      qc.setQueryData(["wa-admins"], next);
      toast.success("WhatsApp admin removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busy = add.isPending || remove.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() || !label.trim()) return;
    add.mutate();
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <MessageCircle className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">WhatsApp admins</h3>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          These numbers can operate the bot by chatting with it on WhatsApp (create posts,
          approve or reject pending items, change settings, ask for status) and receive
          proactive updates. Identity is verified by phone number — everyone else gets the
          regular bot.
        </p>
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="tel"
            placeholder="Phone (05… or 9725…)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            dir="ltr"
            className="sm:w-48"
          />
          <Input
            placeholder="Name / label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="sm:flex-1"
          />
          <Button type="submit" disabled={busy || !phone.trim() || !label.trim()} className="gap-2">
            <Plus className="size-4" />
            Add admin
          </Button>
        </form>

        {admins.length > 0 && (
          <div className="mt-4 divide-y rounded-lg border">
            {admins.map((a) => (
              <div key={a.phone} className="flex items-center gap-3 p-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Smartphone className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.label}</p>
                  <p className="text-xs text-muted-foreground" dir="ltr">
                    +{a.phone}
                    {a.added_at ? ` · added ${new Date(a.added_at).toLocaleDateString("en-GB")}` : ""}
                  </p>
                </div>
                <Badge variant="default" className="gap-1 text-xs">
                  <ShieldCheck className="size-3" />
                  WhatsApp admin
                </Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0 text-destructive"
                  title="Remove WhatsApp admin"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${a.label} (+${a.phone}) from the WhatsApp admins? They immediately lose management access and stop receiving updates.`,
                      )
                    )
                      remove.mutate(a.phone);
                  }}
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
