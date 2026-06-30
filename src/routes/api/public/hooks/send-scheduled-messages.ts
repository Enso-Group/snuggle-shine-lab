import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/hooks/send-scheduled-messages")({
  server: {
    handlers: {
      POST: async () => {
        try {
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

          const { sendTextMessage } = await import("@/lib/whapi.server");
          const results: any[] = [];
          for (const r of due) {
            try {
              if (r.require_approval) {
                await supabase.from("scheduled_approvals").insert({
                  scheduled_message_id: r.id,
                  user_id: r.user_id,
                  target_chat_id: r.target_chat_id,
                  target_name: r.target_name,
                  body: r.body,
                  status: "pending",
                });
                await supabase
                  .from("scheduled_messages")
                  .update({ last_sent_at: new Date().toISOString() })
                  .eq("id", r.id);
                results.push({ id: r.id, queued: true });
              } else {
                await sendTextMessage(r.target_chat_id, r.body);
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
