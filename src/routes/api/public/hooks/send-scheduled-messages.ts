import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/hooks/send-scheduled-messages")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          // Require a shared secret so only the configured cron can trigger sends.
          const cronSecret = process.env.CRON_SECRET;
          if (cronSecret) {
            const url = new URL(request.url);
            const provided =
              request.headers.get("x-cron-secret") ?? url.searchParams.get("secret");
            if (provided !== cronSecret) {
              return new Response(JSON.stringify({ error: "forbidden" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
              });
            }
          } else {
            console.warn(
              "[cron] no CRON_SECRET configured — scheduled-send endpoint is UNAUTHENTICATED.",
            );
          }

          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } },
          );

          // Compute current day-of-week + HH:MM in Asia/Jerusalem.
          const now = new Date();
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Jerusalem",
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).formatToParts(now);
          const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
          const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
          const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
          const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
          const dow = dayMap[wd];
          if (dow === undefined) return new Response(JSON.stringify({ error: "weekday parse" }), { status: 500 });

          // Match items scheduled for current minute (HH:MM) that weren't sent in the last 5 minutes.
          const minTs = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
          const { data: rows, error } = await supabase
            .from("scheduled_messages")
            .select("*")
            .eq("enabled", true)
            .eq("day_of_week", dow)
            .gte("send_time", `${hh}:${mm}:00`)
            .lte("send_time", `${hh}:${mm}:59`);
          if (error) throw new Error(error.message);

          const due = (rows ?? []).filter((r: any) => !r.last_sent_at || r.last_sent_at < minTs);

          // Global approval gate — when on, every scheduled send is queued too.
          // Also grab the system prompt for AI-mode generation.
          const { data: botSettings } = await supabase
            .from("bot_settings")
            .select("require_approval_all, system_prompt")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          const globalApproval = !!botSettings?.require_approval_all;
          const systemPrompt = botSettings?.system_prompt ?? "אתה עוזר חכם בעברית.";

          const { sendTextMessage } = await import("@/lib/whapi.server");
          const { runCommand } = await import("@/lib/ai-brain.server");
          const results: any[] = [];
          for (const r of due) {
            try {
              // In "ai" mode the stored body is a prompt — generate a fresh
              // message NOW (same logic/model as the manual Send flow) so each
              // weekly send can be unique.
              let body = r.body;
              if (r.mode === "ai") {
                body = (await runCommand(r.body, systemPrompt, "schedule")).trim();
                if (!body) throw new Error("ה-AI לא הצליח לייצר הודעה מהפרומפט");
              }

              if (r.require_approval || globalApproval) {
                await supabase.from("scheduled_approvals").insert({
                  scheduled_message_id: r.id,
                  user_id: r.user_id,
                  target_chat_id: r.target_chat_id,
                  target_name: r.target_name,
                  body,
                  status: "pending",
                });
                await supabase
                  .from("scheduled_messages")
                  .update({ last_sent_at: new Date().toISOString() })
                  .eq("id", r.id);
                results.push({ id: r.id, queued: true });
              } else {
                await sendTextMessage(r.target_chat_id, body);
                await supabase
                  .from("scheduled_messages")
                  .update({ last_sent_at: new Date().toISOString() })
                  .eq("id", r.id);
                results.push({ id: r.id, ok: true });
              }
            } catch (e: any) {
              results.push({ id: r.id, ok: false, error: String(e?.message ?? e) });
            }
          }
          return new Response(JSON.stringify({ checked: rows?.length ?? 0, sent: results.length, results }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: any) {
          return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
