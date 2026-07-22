// Behind the Scenes → Simulator: chat with the bot through the full real
// pipeline (real models, real memory/KB) with zero WhatsApp traffic.
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Eraser, FlaskConical, Send } from "lucide-react";
import { StageBadge } from "@/components/stage-badge";
import { runSimulation, cleanupSimulations } from "@/lib/simulate.functions";

type SimExchange = {
  userMessage: string;
  action: string;
  botParts: string[];
  reactions: string[];
  trace: Array<{ stage: string; summary: string | null; duration_ms: number | null }>;
};

export function SimulatorTab() {
  const simulateFn = useServerFn(runSimulation);
  const cleanupFn = useServerFn(cleanupSimulations);

  const [simChatId, setSimChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [log, setLog] = useState<SimExchange[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const simulate = useMutation({
    mutationFn: (message: string) =>
      simulateFn({ data: { messages: [message], chatId: simChatId ?? undefined } }),
    onSuccess: (res, message) => {
      setSimChatId(res.chatId);
      setLog((l) => [
        ...l,
        {
          userMessage: message,
          action: res.outcomes[0]?.action ?? "?",
          botParts: res.sent.map((s) => s.body),
          reactions: res.reactions.map((r) => r.emoji),
          trace: res.decisions.map((d) => ({
            stage: d.stage,
            summary: d.summary,
            duration_ms: d.duration_ms,
          })),
        },
      ]);
      setInput("");
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cleanup = useMutation({
    mutationFn: () => cleanupFn(),
    onSuccess: (r) => {
      setSimChatId(null);
      setLog([]);
      toast.success(`Removed ${r.removed} simulation chats`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Test the bot without WhatsApp</h3>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => cleanup.mutate()}
            disabled={cleanup.isPending}
          >
            <Eraser className="size-3.5" /> Clear simulations
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Messages run through the full production pipeline (reply gate → intent → draft → critique
          → memory) with real AI but zero WhatsApp traffic. Keep typing to test multi-turn memory.
          Write in any language — the bot answers in the language you use.
        </p>

        {log.length > 0 && (
          <div className="max-h-96 space-y-3 overflow-y-auto rounded-md border p-3">
            {log.map((ex, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-end">
                  <span
                    className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-1.5 text-sm"
                    dir="auto"
                  >
                    {ex.userMessage}
                  </span>
                </div>
                {ex.botParts.map((p, j) => (
                  <div key={j} className="flex justify-start">
                    <span
                      className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-1.5 text-sm"
                      dir="auto"
                    >
                      {p}
                    </span>
                  </div>
                ))}
                {ex.reactions.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    The bot reacted with {ex.reactions.join(" ")}
                  </p>
                )}
                {ex.botParts.length === 0 && ex.reactions.length === 0 && (
                  <p className="text-xs text-muted-foreground">({ex.action})</p>
                )}
                {ex.trace.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Decision trace ({ex.trace.length} stages)
                    </summary>
                    <div className="mt-1.5 space-y-1 border-s-2 border-primary/30 ps-3">
                      {ex.trace.map((t, k) => (
                        <div key={k} className="flex items-start gap-2" dir="auto">
                          <StageBadge stage={t.stage} />
                          <span className="flex-1">{t.summary}</span>
                          {t.duration_ms != null && (
                            <span className="shrink-0 text-muted-foreground">
                              {t.duration_ms}ms
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim() && !simulate.isPending) simulate.mutate(input.trim());
          }}
        >
          <Input
            placeholder="Type a message as if you were a customer…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            dir="auto"
            className="flex-1"
          />
          <Button type="submit" disabled={simulate.isPending || !input.trim()} className="gap-2">
            <Send className="size-4" />
            {simulate.isPending ? "Thinking…" : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
