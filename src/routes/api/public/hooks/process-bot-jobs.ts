import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// Queue sweeper, hit every minute by pg_cron (job 'process-bot-jobs').
// The webhook processes most jobs inline; this endpoint exists for
// reliability: it retries failed jobs, recovers jobs whose worker died, and
// runs anything the inline path never got to (e.g. the isolate was killed).

export const Route = createFileRoute("/api/public/hooks/process-bot-jobs")({
  server: {
    handlers: {
      // Read-only health check: queue depth by status, no secret required,
      // no secret values exposed.
      GET: async () => {
        try {
          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } },
          );
          const counts: Record<string, number> = {};
          for (const status of ["pending", "processing", "failed"]) {
            const { count } = await supabase
              .from("bot_jobs")
              .select("id", { count: "exact", head: true })
              .eq("status", status);
            counts[status] = count ?? 0;
          }
          let followUpsPending = 0;
          try {
            const { count } = await supabase
              .from("follow_ups")
              .select("id", { count: "exact", head: true })
              .eq("status", "pending");
            followUpsPending = count ?? 0;
          } catch {
            // follow_ups table not migrated yet — fine
          }
          return Response.json({
            ok: true,
            info: "Bot-jobs sweeper. POST with x-cron-secret to trigger a run.",
            queue: counts,
            follow_ups_pending: followUpsPending,
          });
        } catch (e) {
          return Response.json(
            { ok: false, error: String((e as Error)?.message ?? e) },
            { status: 500 },
          );
        }
      },
      POST: async ({ request }) => {
        try {
          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } },
          );

          const { data: botSettings } = await supabase
            .from("bot_settings")
            .select("cron_secret")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

          const { secretsEqual } = await import("@/lib/agent/inbound");
          const url = new URL(request.url);
          const provided = request.headers.get("x-cron-secret") ?? url.searchParams.get("secret");
          const envSecret = process.env.CRON_SECRET || "";
          const dbSecret =
            (botSettings as { cron_secret?: string | null } | null)?.cron_secret || "";
          if (envSecret || dbSecret) {
            const authorized =
              (!!envSecret && secretsEqual(provided, envSecret)) ||
              (!!dbSecret && secretsEqual(provided, dbSecret));
            if (!authorized) {
              return new Response(JSON.stringify({ error: "forbidden" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
              });
            }
          } else {
            console.warn(
              "[jobs] no cron secret configured (env or DB) — endpoint is UNAUTHENTICATED.",
            );
          }

          const { processQueuedJobs } = await import("@/lib/agent/worker.server");
          const { processDueFollowUps } = await import("@/lib/agent/follow-ups.server");
          const { realWhapiPort } = await import("@/lib/agent/whapi-port.server");
          const deps = {
            supabase,
            whapi: realWhapiPort(),
            trigger: "inbound" as const,
            workerId: `sweeper-${Math.random().toString(36).slice(2, 8)}`,
            humanPacing: true,
          };
          const run = await processQueuedJobs(deps, { max: 3 });
          const followUps = await processDueFollowUps(deps, { max: 2 });
          const { runGroupEngine } = await import("@/lib/agent/posting.server");
          const groups = await runGroupEngine(deps);

          return Response.json({
            ok: true,
            claimed: run.claimed,
            results: run.results.map((r) => ({ jobId: r.jobId, action: r.outcome.action })),
            follow_ups: followUps,
            groups,
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
