import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, PageContent } from "@/components/page-header";
import { Settings as SettingsIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getBotSettings, updateBotSettings, checkWhapiConnection } from "@/lib/bot.functions";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getBotSettings);
  const upFn = useServerFn(updateBotSettings);
  const checkFn = useServerFn(checkWhapiConnection);

  const { data: settings, isLoading } = useQuery({ queryKey: ["botSettings"], queryFn: () => getFn() });

  const [systemPrompt, setSystemPrompt] = useState("");
  const [botName, setBotName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [requireApprovalAll, setRequireApprovalAll] = useState(false);

  useEffect(() => {
    if (settings) {
      setSystemPrompt(settings.system_prompt);
      setBotName(settings.bot_name);
      setEnabled(settings.enabled);
      setRequireApprovalAll((settings as any).require_approval_all ?? false);
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      upFn({ data: { id: settings!.id, system_prompt: systemPrompt, bot_name: botName, enabled, require_approval_all: requireApprovalAll } }),
    onSuccess: () => {
      toast.success("Saved!");
      qc.invalidateQueries({ queryKey: ["botSettings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const check = useMutation({
    mutationFn: () => checkFn(),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Connection OK! Status: ${r.status ?? "online"}`);
      else toast.error(`Connection failed: ${r.error}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading)
    return (
      <div className="min-h-full">
        <PageHeader icon={SettingsIcon} title="Settings" description="Bot settings and Whapi connection" />
        <PageContent maxWidthClass="max-w-3xl">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </PageContent>
      </div>
    );

  return (
    <div className="min-h-full">
      <PageHeader icon={SettingsIcon} title="Settings" description="Bot settings and Whapi connection" />

      <PageContent maxWidthClass="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Whapi connection</CardTitle>
          <CardDescription>The token is stored securely on the server (it can't be viewed from the browser)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Setup and connection instructions moved to the <strong>Instructions</strong> page in the menu.
          </p>
          <Button onClick={() => check.mutate()} disabled={check.isPending} variant="outline">
            {check.isPending ? "Checking..." : "Check connection"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bot personality</CardTitle>
          <CardDescription>How the bot talks and responds. Changes take effect immediately on new messages.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 border rounded-md">
            <div>
              <Label>Bot active</Label>
              <p className="text-xs text-muted-foreground">When off, it won't reply but will keep saving messages</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between p-3 border rounded-md border-amber-500/50 bg-amber-50/30 dark:bg-amber-950/10">
            <div>
              <Label>Require approval for every outgoing message</Label>
              <p className="text-xs text-muted-foreground">
                When on, every message the bot wants to send (reply, scheduled, or manual) goes to the "Approvals" page with send / edit / delete.
              </p>
            </div>
            <Switch checked={requireApprovalAll} onCheckedChange={setRequireApprovalAll} />
          </div>
          <div>
            <Label htmlFor="botName">Bot name (for recognition in groups)</Label>
            <Input id="botName" value={botName} onChange={(e) => setBotName(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">In groups, the bot replies only if someone mentions this name or tags it</p>
          </div>
          <div>
            <Label htmlFor="prompt">Style and personality (system prompt)</Label>
            <Textarea
              id="prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Anti-ban tip: ask the bot to write short, natural messages with variety, and not to reply to every message.
            </p>
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending} className="gap-2">
            {save.isPending && <Loader2 className="size-4 animate-spin" />}
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </CardContent>
      </Card>
      </PageContent>
    </div>
  );
}
