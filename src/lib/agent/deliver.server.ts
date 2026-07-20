// Human-like delivery: mark the inbound as read, type for a believable
// duration, send the reply as 1–3 WhatsApp-natural messages with short pauses,
// and record every outbound row. Pacing is skipped in simulation.
import type { Json } from "@/integrations/supabase/types";
import type { Supa } from "./types";
import { interPartDelayMs, typingSecondsFor } from "./inbound";
import type { AgentContext, WhapiPort } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Upper bound on total pacing (typing + pauses) so a delivery can never push
// the serverless request toward its timeout.
const MAX_TOTAL_PACING_MS = 12_000;

export type DeliveryResult = {
  sentMessageIds: Array<string | null>;
  parts: string[];
};

export async function deliverReply(
  supabase: Supa,
  whapi: WhapiPort,
  ctx: AgentContext,
  parts: string[],
  opts: { humanPacing: boolean; botName: string },
): Promise<DeliveryResult> {
  let pacingBudgetMs = MAX_TOTAL_PACING_MS;

  // Read receipt on the message we're answering — best-effort.
  if (ctx.message.messageId) {
    await whapi.markRead(ctx.message.messageId).catch(() => {});
  }

  const sentMessageIds: Array<string | null> = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (opts.humanPacing) {
      const typingMs = Math.min(typingSecondsFor(part) * 1000, pacingBudgetMs);
      if (typingMs > 500) {
        await whapi
          .presence(ctx.message.chatId, "typing", Math.ceil(typingMs / 1000))
          .catch(() => {});
        await sleep(typingMs);
        pacingBudgetMs -= typingMs;
      }
    }

    const sendRes = await whapi.sendText(ctx.message.chatId, part);
    const whapiId = (sendRes as { message?: { id?: string } })?.message?.id ?? null;
    sentMessageIds.push(whapiId);

    await supabase.from("messages").insert({
      conversation_id: ctx.conversation.id,
      whapi_message_id: whapiId,
      direction: "outbound",
      sender_name: opts.botName || "Bot",
      sender_id: "bot",
      body: part,
      raw: sendRes as Json,
    });

    if (opts.humanPacing && i < parts.length - 1) {
      const pauseMs = Math.min(interPartDelayMs(), Math.max(pacingBudgetMs, 0));
      if (pauseMs > 0) {
        await sleep(pauseMs);
        pacingBudgetMs -= pauseMs;
      }
    }
  }

  // One logical reply = one anti-ban outbound unit, whatever the part count.
  const { recordOutbound } = await import("@/lib/anti-ban.server");
  await recordOutbound(supabase, ctx.conversation.id, parts.join("\n\n"));

  return { sentMessageIds, parts };
}
