// Behind the Scenes → Personality & Models: the bot's global identity
// (bot_settings) and the agent's model/behavior configuration.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Bot, Cpu, Save } from "lucide-react";
import { getBotSettings, updateBotSettings } from "@/lib/bot.functions";
import { getAgentConfig, saveAgentConfig, type AgentConfigView } from "@/lib/brain.functions";

export function PersonalityTab() {
  const qc = useQueryClient();
  const getFn = useServerFn(getBotSettings);
  const upFn = useServerFn(updateBotSettings);
  const getCfgFn = useServerFn(getAgentConfig);
  const saveCfgFn = useServerFn(saveAgentConfig);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["botSettings"],
    queryFn: () => getFn(),
  });
  const { data: cfg } = useQuery({ queryKey: ["agent-config"], queryFn: () => getCfgFn() });

  const [systemPrompt, setSystemPrompt] = useState("");
  const [botName, setBotName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [requireApprovalAll, setRequireApprovalAll] = useState(false);
  const [cfgForm, setCfgForm] = useState<AgentConfigView | null>(null);

  useEffect(() => {
    if (settings) {
      setSystemPrompt(settings.system_prompt);
      setBotName(settings.bot_name);
      setEnabled(settings.enabled);
      setRequireApprovalAll(settings.require_approval_all ?? false);
    }
  }, [settings]);
  useEffect(() => {
    if (cfg && !cfgForm) setCfgForm(cfg);
  }, [cfg, cfgForm]);

  const save = useMutation({
    mutationFn: async () => {
      await upFn({
        data: {
          id: settings!.id,
          system_prompt: systemPrompt,
          bot_name: botName,
          enabled,
          require_approval_all: requireApprovalAll,
        },
      });
      if (cfgForm) await saveCfgFn({ data: cfgForm });
    },
    onSuccess: () => {
      toast.success("Personality & configuration saved");
      qc.invalidateQueries({ queryKey: ["botSettings"] });
      qc.invalidateQueries({ queryKey: ["agent-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Global personality</h3>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Bot active</Label>
              <p className="text-xs text-muted-foreground">
                When off, the bot stops replying but keeps recording messages.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-amber-500/50 bg-amber-50/30 p-3 dark:bg-amber-950/10">
            <div>
              <Label>Require approval for every outgoing message</Label>
              <p className="text-xs text-muted-foreground">
                Everything the bot wants to send goes to Approvals first — your safety net.
              </p>
            </div>
            <Switch checked={requireApprovalAll} onCheckedChange={setRequireApprovalAll} />
          </div>
          <div>
            <Label htmlFor="botName">
              Bot name (used to recognize when it's addressed in groups)
            </Label>
            <Input
              id="botName"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              dir="auto"
            />
          </div>
          <div>
            <Label htmlFor="prompt">
              Personality & style (system prompt — write in the bot's working language)
            </Label>
            <Textarea
              id="prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              className="font-mono text-sm"
              dir="auto"
            />
          </div>
        </CardContent>
      </Card>

      {cfgForm && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-2">
              <Cpu className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">Models & behavior</h3>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Strong model (reasoning / drafts)</Label>
                <Input
                  placeholder="default: google/gemini-3.1-pro-preview"
                  value={cfgForm.model_strong ?? ""}
                  onChange={(e) => setCfgForm({ ...cfgForm, model_strong: e.target.value || null })}
                  dir="ltr"
                />
              </div>
              <div>
                <Label className="text-xs">Fast model (classification)</Label>
                <Input
                  placeholder="default: google/gemini-3-flash-preview"
                  value={cfgForm.model_fast ?? ""}
                  onChange={(e) => setCfgForm({ ...cfgForm, model_fast: e.target.value || null })}
                  dir="ltr"
                />
              </div>
              <label className="flex items-center justify-between gap-2 text-xs">
                Reply delay (seconds, merges rapid bursts)
                <Input
                  type="number"
                  min={0}
                  max={30}
                  className="w-16"
                  value={cfgForm.reply_delay_seconds}
                  onChange={(e) =>
                    setCfgForm({ ...cfgForm, reply_delay_seconds: Number(e.target.value) || 0 })
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                Max messages per reply
                <Input
                  type="number"
                  min={1}
                  max={5}
                  className="w-16"
                  value={cfgForm.max_reply_parts}
                  onChange={(e) =>
                    setCfgForm({ ...cfgForm, max_reply_parts: Number(e.target.value) || 3 })
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                Self-critique before sending (maximum quality)
                <Switch
                  checked={cfgForm.critique_enabled}
                  onCheckedChange={(v) => setCfgForm({ ...cfgForm, critique_enabled: v })}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                React 👍 to trivial messages ("thanks" etc.)
                <Switch
                  checked={cfgForm.react_to_trivial}
                  onCheckedChange={(v) => setCfgForm({ ...cfgForm, react_to_trivial: v })}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                Automatic follow-ups
                <Switch
                  checked={cfgForm.follow_ups_enabled}
                  onCheckedChange={(v) => setCfgForm({ ...cfgForm, follow_ups_enabled: v })}
                />
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      <Button onClick={() => save.mutate()} disabled={save.isPending} className="gap-2">
        <Save className="size-4" />
        {save.isPending ? "Saving…" : "Save all"}
      </Button>
    </div>
  );
}
