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

          // Match anything due in the last GRACE_MINUTES rather than only the
          // current minute: a cron that runs every few minutes — or that misses
          // a single tick — would otherwise skip the send for a whole week.
          const GRACE_MINUTES = 10;
          const pad = (n: number) => String(n).padStart(2, "0");
          const nowMinutes = Number(hh) * 60 + Number(mm);
          const fromMinutes = Math.max(0, nowMinutes - GRACE_MINUTES);
          const fromTime = `${pad(Math.floor(fromMinutes / 60))}:${pad(fromMinutes % 60)}:00`;

          const { data: rows, error } = await supabase
            .from("scheduled_messages")
            .select("*")
            .eq("enabled", true)
            .eq("day_of_week", dow)
            .gte("send_time", fromTime)
            .lte("send_time", `${hh}:${mm}:59`);
          if (error) throw new Error(error.message);

          // Each slot fires once a week, so anything already sent in the last
          // few hours is this same occurrence — don't send it twice.
          const dedupeTs = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
          const due = (rows ?? []).filter((r: any) => !r.last_sent_at || r.last_sent_at < dedupeTs);

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
            // Claim the row before doing any work. Overlapping cron runs (the
            // project can have more than one job pointed here) would otherwise
            // both see the same row as unsent and deliver it twice. The filter
            // makes this atomic: only one caller's UPDATE can match.
            const { data: claimed } = await supabase
              .from("scheduled_messages")
              .update({ last_sent_at: new Date().toISOString() })
              .eq("id", r.id)
              .or(`last_sent_at.is.null,last_sent_at.lt.${dedupeTs}`)
              .select("id");
            if (!claimed || claimed.length === 0) {
              results.push({ id: r.id, skipped: "already claimed by another run" });
              continue;
            }

            try {
              // In "ai" mode the stored body is a prompt — generate a fresh
              // message NOW (same logic/model as the manual Send flow) so each
              // weekly send can be unique.
              let body = r.body;
              if (r.mode === "ai") {
                body = (await runCommand(r.body, systemPrompt, "schedule")).trim();
                if (!body) throw new Error("The AI couldn't generate a message from the prompt");
              }

              // last_sent_at was already stamped by the claim above.
              if (r.require_approval || globalApproval) {
                await supabase.from("scheduled_approvals").insert({
                  scheduled_message_id: r.id,
                  user_id: r.user_id,
                  target_chat_id: r.target_chat_id,
                  target_name: r.target_name,
                  body,
                  status: "pending",
                });
                results.push({ id: r.id, queued: true });
              } else {
                await sendTextMessage(r.target_chat_id, body);
                results.push({ id: r.id, ok: true });
              }
            } catch (e: any) {
              // Release the claim so a later run can retry this occurrence,
              // instead of it being stuck "sent" until next week.
              await supabase
                .from("scheduled_messages")
                .update({ last_sent_at: r.last_sent_at })
                .eq("id", r.id);
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
