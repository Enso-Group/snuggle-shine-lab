// Simulation mode — run the FULL inbound pipeline (idempotency, gates, queue,
// intent → draft → critique → deliver) against a sandbox conversation, with
// WhatsApp stubbed out. Uses real LLM calls so reply quality can be judged;
// sends nothing, and sandbox chats are namespaced so anti-ban counters and
// analytics for real chats are untouched.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";

const SIM_CHAT_SUFFIX = "@simulation";

export const runSimulation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        // Sequential inbound messages from a pretend customer.
        messages: z.array(z.string().min(1).max(2000)).min(1).max(5),
        senderName: z.string().max(80).optional(),
        // Reuse an existing sandbox chat to test multi-turn memory.
        chatId: z.string().max(80).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadAgentSettings } = await import("@/lib/agent/context.server");
    const { handleInboundMessage } = await import("@/lib/agent/inbound-handler.server");
    const { recordingWhapiPort } = await import("@/lib/agent/whapi-port.server");
    const { parseWhapiMessage } = await import("@/lib/agent/inbound");

    const settings = await loadAgentSettings(supabaseAdmin);
    if (!settings) throw new Error("bot_settings row missing");

    const chatId =
      data.chatId && data.chatId.endsWith(SIM_CHAT_SUFFIX)
        ? data.chatId
        : `sim-${Date.now().toString(36)}${SIM_CHAT_SUFFIX}`;
    const senderName = data.senderName || "Simulation Customer";
    const { port, calls } = recordingWhapiPort();

    const outcomes: Array<{ message: string; action: string }> = [];
    const jobIds: string[] = [];
    for (let i = 0; i < data.messages.length; i++) {
      const m = parseWhapiMessage({
        chat_id: chatId,
        chat_name: `Simulation — ${senderName}`,
        from: chatId,
        from_name: senderName,
        id: `sim-in-${Date.now()}-${i}`,
        text: { body: data.messages[i] },
        timestamp: Math.floor(Date.now() / 1000),
      });
      if (!m) continue;
      const outcome = await handleInboundMessage(
        {
          supabase: supabaseAdmin,
          whapi: port,
          trigger: "simulation",
          workerId: "simulation",
          humanPacing: false,
        },
        // Simulation always exercises the full pipeline — approval mode would
        // just queue drafts, which is not what's being tested here.
        { ...settings, enabled: true, require_approval_all: false },
        m,
        { simulated: true },
      );
      outcomes.push({ message: data.messages[i], action: outcome.action });
      if (outcome.jobId) jobIds.push(outcome.jobId);
    }

    // The decision trail is the interesting output — same rows the live
    // activity log shows for real traffic.
    const { data: decisions } = jobIds.length
      ? await supabaseAdmin
          .from("bot_decisions")
          .select("job_id, stage, status, summary, data, duration_ms, created_at")
          .in("job_id", jobIds)
          .order("created_at", { ascending: true })
      : { data: [] };

    return {
      chatId,
      outcomes,
      decisions: decisions ?? [],
      sent: calls.filter((c) => c.kind === "sendText"),
      reactions: calls.filter((c) => c.kind === "react"),
    };
  });

export const cleanupSimulations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: sims } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .like("whapi_chat_id", `%${SIM_CHAT_SUFFIX}`);
    const ids = (sims ?? []).map((s) => s.id);
    if (ids.length) {
      // messages/bot_decisions cascade via FK; jobs are keyed by chat id.
      await supabaseAdmin.from("bot_jobs").delete().like("chat_id", `%${SIM_CHAT_SUFFIX}`);
      await supabaseAdmin.from("conversations").delete().in("id", ids);
    }
    return { removed: ids.length };
  });
