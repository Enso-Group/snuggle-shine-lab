import { createFileRoute } from "@tanstack/react-router";

// Thin webhook: authenticate, parse, and hand each message to the shared
// inbound handler (src/lib/agent/inbound-handler.server.ts). All processing is
// backed by the bot_jobs queue — if this request dies mid-way, the
// every-minute sweeper (process-bot-jobs) finishes the work, and the unique
// index on inbound whapi ids makes Whapi's retries harmless.

export const Route = createFileRoute("/api/public/whapi-webhook")({
  server: {
    handlers: {
      // rev: deploy beacon — bump when server behavior changes so a live
      // deploy can be confirmed from outside without auth.
      GET: async () =>
        Response.json({
          ok: true,
          info: "Whapi webhook endpoint",
          rev: "2026-07-23-auto-cleanup",
        }),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const secretParam =
          url.searchParams.get("secret") ?? request.headers.get("x-webhook-secret");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { secretsEqual, parseWhapiMessage } = await import("@/lib/agent/inbound");

        const { data: settingsRow } = await supabaseAdmin
          .from("bot_settings")
          .select(
            "id, system_prompt, bot_name, enabled, webhook_secret, require_approval_all, model_strong, model_fast, agent_config",
          )
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        // Prefer a server-side env secret (set in Cloud), fall back to the DB
        // column. If a secret is configured, every webhook call MUST present it.
        const expectedSecret =
          process.env.WHAPI_WEBHOOK_SECRET || settingsRow?.webhook_secret || "";
        if (expectedSecret) {
          if (!secretsEqual(secretParam, expectedSecret)) {
            return new Response("forbidden", { status: 403 });
          }
        } else {
          console.warn(
            "[webhook] no WHAPI_WEBHOOK_SECRET configured — endpoint is UNAUTHENTICATED. Set the secret in Cloud and re-register the webhook.",
          );
        }

        let payload: {
          messages?: unknown;
          data?: unknown;
          message?: unknown;
          groups?: unknown;
          groups_participants?: unknown;
        };
        try {
          payload = await request.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }

        const messages: unknown[] = Array.isArray(payload.messages)
          ? payload.messages
          : Array.isArray(payload.data)
            ? payload.data
            : payload.message
              ? [payload.message]
              : [];
        console.log(
          "[webhook] payload keys:",
          Object.keys(payload || {}),
          "messages:",
          messages.length,
        );

        const settings = {
          id: settingsRow?.id,
          enabled: settingsRow?.enabled !== false,
          system_prompt: settingsRow?.system_prompt ?? "אתה עוזר חכם בעברית.",
          bot_name: settingsRow?.bot_name ?? "",
          require_approval_all: !!settingsRow?.require_approval_all,
          model_strong: settingsRow?.model_strong ?? null,
          model_fast: settingsRow?.model_fast ?? null,
          agent_config: (settingsRow?.agent_config ??
            {}) as import("@/lib/agent/types").AgentConfig,
        };

        const { handleInboundMessage } = await import("@/lib/agent/inbound-handler.server");
        const { realWhapiPort } = await import("@/lib/agent/whapi-port.server");
        const deps = {
          supabase: supabaseAdmin,
          whapi: realWhapiPort(),
          trigger: "inbound" as const,
          workerId: `webhook-${Math.random().toString(36).slice(2, 8)}`,
          humanPacing: true,
        };

        // Group membership events (joins/leaves) — welcomes + member tracking.
        const groupOutcomes: Array<{ action: string }> = [];
        try {
          const { parseGroupEvents, handleGroupEvent } =
            await import("@/lib/agent/group-events.server");
          for (const event of parseGroupEvents(payload as Record<string, unknown>)) {
            groupOutcomes.push(await handleGroupEvent(deps, settings, event));
          }
        } catch (e) {
          console.error("[webhook] group event error", e);
        }

        if (messages.length === 0) {
          return Response.json({
            ok: true,
            skipped: "no messages",
            group_events: groupOutcomes.length,
            keys: Object.keys(payload || {}),
          });
        }

        const outcomes: Array<{ action: string }> = [];
        for (const raw of messages) {
          try {
            const m = parseWhapiMessage(raw as import("@/lib/agent/inbound").RawWhapiMessage);
            if (!m) continue;

            // Resolve our own identity for messages sent from the linked phone,
            // so they're stored under the right name.
            if (m.fromMe) {
              try {
                const { checkHealth } = await import("@/lib/whapi.server");
                const health = await checkHealth();
                m.senderId = health.userId || m.senderId;
                m.senderName = health.userName || m.senderName || "Me";
              } catch {
                m.senderName = m.senderName || "Me";
              }
            }

            const outcome = await handleInboundMessage(deps, settings, m, raw);
            console.log(`[webhook] chat=${m.chatId} action=${outcome.action}`);
            outcomes.push({ action: outcome.action });
          } catch (e) {
            console.error("[webhook] handler error", e);
            outcomes.push({ action: "error" });
          }
        }

        return Response.json({ ok: true, processed: messages.length, outcomes });
      },
    },
  },
});
