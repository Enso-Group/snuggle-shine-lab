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
          // Last self-cleanup run (counts only — no chat content, no secrets),
          // so a deploy's data-fix can be confirmed from outside without auth.
          let lastCleanup: { at: string; summary: string | null } | null = null;
          try {
            const { data: cleanupRow } = await supabase
              .from("bot_decisions")
              .select("created_at, summary")
              .eq("stage", "config")
              .like("summary", "Non-participated cleanup%")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (cleanupRow) {
              lastCleanup = { at: cleanupRow.created_at, summary: cleanupRow.summary };
            }
          } catch {
            // bot_decisions unavailable — health check stays best-effort
          }

          // Observability for the DM latency requirement and the JSON-leak
          // guard: recent deliveries' timing numbers, and a scan of recently
          // sent parts for anything JSON-shaped. Numbers and timestamps only —
          // message content never leaves the server.
          const recentDmReplies: Array<Record<string, unknown>> = [];
          const leakScan: { scanned: number; leaks: number; last_leak_at: string | null } = {
            scanned: 0,
            leaks: 0,
            last_leak_at: null,
          };
          try {
            const { looksLikeStructuredOutput } = await import("@/lib/agent/inbound");
            const { data: delivers } = await supabase
              .from("bot_decisions")
              .select("created_at, chat_id, data")
              .eq("stage", "deliver")
              .order("created_at", { ascending: false })
              .limit(100);
            for (const row of delivers ?? []) {
              const d = (row.data ?? {}) as {
                parts?: unknown;
                latency_breakdown?: Record<string, unknown>;
              };
              const parts = Array.isArray(d.parts) ? d.parts.map((p) => String(p ?? "")) : [];
              leakScan.scanned += 1;
              if (parts.some((p) => looksLikeStructuredOutput(p))) {
                leakScan.leaks += 1;
                if (!leakScan.last_leak_at) leakScan.last_leak_at = row.created_at;
              }
              const isGroup = (row.chat_id ?? "").endsWith("@g.us");
              if (!isGroup && d.latency_breakdown && recentDmReplies.length < 10) {
                recentDmReplies.push({ at: row.created_at, ...d.latency_breakdown });
              }
            }
          } catch {
            // best-effort — never fail the health check over observability
          }

          // Send-pipeline failure evidence: truncated error strings, masked
          // chat ids, counts — never message content. This is what lets a
          // stuck "generating" post or a dead LLM gateway be diagnosed from
          // outside without auth.
          const debug: Record<string, unknown> = {};
          const maskChat = (id: string | null | undefined) => {
            const s = String(id ?? "");
            const [user, domain] = s.split("@");
            return user.length > 4 ? `…${user.slice(-4)}${domain ? "@" + domain : ""}` : s;
          };
          try {
            // Whether WhatsApp will accept sends at all — a de-authorized
            // channel (Whapi 401) fails every delivery while the rest of the
            // pipeline looks healthy.
            const { getConnectedChannel } = await import("@/lib/agent/channel.server");
            const ch = await getConnectedChannel();
            debug.channel = {
              connected: ch.connected,
              phone: ch.phone ? `…${ch.phone.slice(-4)}` : null,
            };
          } catch (e) {
            debug.channel = String((e as Error)?.message ?? e);
          }
          try {
            const { data: bs } = await supabase
              .from("bot_settings")
              .select("enabled, require_approval_all, updated_at")
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            debug.bot = bs
              ? {
                  enabled: bs.enabled,
                  require_approval_all: bs.require_approval_all,
                  updated_at: bs.updated_at,
                }
              : null;
          } catch (e) {
            debug.bot = String((e as Error)?.message ?? e);
          }
          try {
            const { data: jobs } = await supabase
              .from("bot_jobs")
              .select("kind, chat_id, status, attempts, max_attempts, last_error, run_after, updated_at")
              .order("updated_at", { ascending: false })
              .limit(10);
            debug.recent_jobs = (jobs ?? []).map((j) => ({
              kind: j.kind,
              status: j.status,
              attempts: `${j.attempts}/${j.max_attempts}`,
              chat: maskChat(j.chat_id),
              run_after: j.run_after,
              updated_at: j.updated_at,
              last_error: j.last_error ? String(j.last_error).slice(0, 300) : null,
            }));
          } catch (e) {
            debug.recent_jobs = String((e as Error)?.message ?? e);
          }
          try {
            const { data: aiErr } = await supabase
              .from("ai_usage_log")
              .select("created_at, model, source, status, http_status, error_message")
              .eq("status", "error")
              .order("created_at", { ascending: false })
              .limit(8);
            debug.ai_errors = (aiErr ?? []).map((r) => ({
              at: r.created_at,
              model: r.model,
              source: r.source,
              http: r.http_status,
              error: r.error_message ? String(r.error_message).slice(0, 200) : null,
            }));
            const { data: aiOk } = await supabase
              .from("ai_usage_log")
              .select("created_at, model, source")
              .eq("status", "success")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            debug.last_ai_success = aiOk ?? null;
          } catch (e) {
            debug.ai_errors = String((e as Error)?.message ?? e);
          }
          try {
            const postCounts: Record<string, number> = {};
            for (const st of ["planned", "queued_approval", "sent", "failed", "cancelled"]) {
              const { count } = await supabase
                .from("planned_posts")
                .select("id", { count: "exact", head: true })
                .eq("status", st);
              postCounts[st] = count ?? 0;
            }
            const { data: stuckPosts } = await supabase
              .from("planned_posts")
              .select("group_chat_id, status, source, reasoning, engagement, created_at, updated_at")
              .in("status", ["planned", "failed"])
              .order("created_at", { ascending: true })
              .limit(10);
            debug.planned_posts = {
              counts: postCounts,
              stuck: (stuckPosts ?? []).map((p) => ({
                chat: maskChat(p.group_chat_id),
                status: p.status,
                source: p.source,
                reasoning: p.reasoning ? String(p.reasoning).slice(0, 200) : null,
                gen_attempts:
                  (p.engagement as { gen_attempts?: number } | null)?.gen_attempts ?? null,
                created_at: p.created_at,
                updated_at: p.updated_at,
              })),
            };
          } catch (e) {
            debug.planned_posts = String((e as Error)?.message ?? e);
          }
          try {
            // Proof of the last actual delivery: has_whapi_id means WhatsApp
            // ACCEPTED the send, not just that we flipped the status to sent.
            const { data: lastSent } = await supabase
              .from("planned_posts")
              .select("group_chat_id, source, sent_at, whapi_message_id")
              .eq("status", "sent")
              .order("sent_at", { ascending: false, nullsFirst: false })
              .limit(1)
              .maybeSingle();
            debug.last_sent_post = lastSent
              ? {
                  chat: maskChat(lastSent.group_chat_id),
                  source: lastSent.source,
                  sent_at: lastSent.sent_at,
                  has_whapi_id: !!lastSent.whapi_message_id,
                }
              : null;
          } catch (e) {
            debug.last_sent_post = String((e as Error)?.message ?? e);
          }
          try {
            // The post pipeline's decision trace (planned → attempts/errors →
            // sent/cancelled/retry), so a post that "vanished" can be
            // reconstructed from outside without auth.
            const { data: postDecisions } = await supabase
              .from("bot_decisions")
              .select("created_at, stage, status, chat_id, summary")
              .in("stage", ["post", "config", "error"])
              .order("created_at", { ascending: false })
              .limit(10);
            debug.recent_post_decisions = (postDecisions ?? []).map((r) => ({
              at: r.created_at,
              stage: r.stage,
              status: r.status,
              chat: maskChat(r.chat_id),
              summary: String(r.summary ?? "").slice(0, 200),
            }));
          } catch (e) {
            debug.recent_post_decisions = String((e as Error)?.message ?? e);
          }
          try {
            // Whether the posting engine can act at all: a planned post whose
            // group has no ENABLED profile can never be generated.
            const { data: gps } = await supabase
              .from("group_profiles")
              .select("chat_id, name, enabled, updated_at")
              .order("updated_at", { ascending: false })
              .limit(20);
            debug.group_profiles = (gps ?? []).map((g) => ({
              chat: maskChat(g.chat_id),
              name: g.name,
              enabled: g.enabled,
              updated_at: g.updated_at,
            }));
          } catch (e) {
            debug.group_profiles = String((e as Error)?.message ?? e);
          }
          try {
            const { data: errs } = await supabase
              .from("bot_decisions")
              .select("created_at, stage, chat_id, summary")
              .eq("status", "error")
              .order("created_at", { ascending: false })
              .limit(8);
            debug.error_decisions = (errs ?? []).map((r) => ({
              at: r.created_at,
              stage: r.stage,
              chat: maskChat(r.chat_id),
              summary: String(r.summary ?? "").slice(0, 220),
            }));
          } catch (e) {
            debug.error_decisions = String((e as Error)?.message ?? e);
          }
          try {
            const { count: totalPeople } = await supabase
              .from("people")
              .select("id", { count: "exact", head: true });
            const { data: peopleRows } = await supabase.from("people").select("wa_id").limit(2000);
            const byPhone = new Map<string, number>();
            for (const r of peopleRows ?? []) {
              const phone = String(r.wa_id ?? "").split("@")[0].replace(/\D/g, "");
              if (!phone) continue;
              byPhone.set(phone, (byPhone.get(phone) ?? 0) + 1);
            }
            debug.people = {
              total: totalPeople ?? 0,
              duplicate_phone_groups: [...byPhone.values()].filter((n) => n > 1).length,
            };
          } catch (e) {
            debug.people = String((e as Error)?.message ?? e);
          }

          return Response.json({
            ok: true,
            info: "Bot-jobs sweeper. POST with x-cron-secret to trigger a run.",
            queue: counts,
            follow_ups_pending: followUpsPending,
            last_cleanup: lastCleanup,
            recent_dm_replies: recentDmReplies,
            leak_scan: leakScan,
            debug,
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
          const { realWhapiPort } = await import("@/lib/agent/whapi-port.server");
          const deps = {
            supabase,
            whapi: realWhapiPort(),
            trigger: "inbound" as const,
            workerId: `sweeper-${Math.random().toString(36).slice(2, 8)}`,
            humanPacing: true,
          };

          // Fast tick: only drain due jobs (this is what delivers DM replies on
          // time, since their run_after encodes the 15-120s human delay). The
          // heavier per-minute work (follow-ups, group engine, analytics) is
          // skipped so it can run at a lower frequency.
          const jobsOnly =
            url.searchParams.get("jobs_only") === "1" || request.headers.get("x-jobs-only") === "1";
          // Cap at 3 per tick: each job may do a short (<=20s) top-up wait, and
          // they run serially, so this bounds a single Worker invocation's time.
          // Jobs beyond the cap are picked up on the next 20s tick.
          const run = await processQueuedJobs(deps, { max: 3 });
          if (jobsOnly) {
            return Response.json({
              ok: true,
              jobs_only: true,
              claimed: run.claimed,
              results: run.results.map((r) => ({ jobId: r.jobId, action: r.outcome.action })),
            });
          }

          // Each maintenance stage is isolated: a failure in one (e.g. an LLM
          // error inside the group engine) must not 500 the sweep or starve
          // the stages after it.
          const guarded = async <T>(
            label: string,
            fn: () => Promise<T>,
          ): Promise<T | { error: string }> => {
            try {
              return await fn();
            } catch (e) {
              console.error(`[jobs] ${label} failed`, e);
              return { error: String((e as Error)?.message ?? e).slice(0, 300) };
            }
          };

          // One-shot heal: require_approval_all was flipped on during the
          // 2026-07-23 incident (raw-JSON leak, before the leak guard
          // deployed), which parks every reply/post in Approvals and reads as
          // "the bot stopped sending". Restore auto-send exactly once — the
          // marker row makes this permanent, so a later DELIBERATE re-enable
          // of approval mode in the dashboard is never fought. Marker is
          // written BEFORE the flip: if the flip fails we retry via a manual
          // toggle, but a lost marker must never cause repeated flips.
          const approvalRestore = await guarded("approval-restore", async () => {
            const MARKER = "Restored auto-send after the 2026-07-23 incident";
            const { data: done } = await supabase
              .from("bot_decisions")
              .select("id")
              .eq("stage", "config")
              .like("summary", `${MARKER}%`)
              .limit(1)
              .maybeSingle();
            if (done) return { ran: false as const, reason: "already restored" };
            const { data: settings } = await supabase
              .from("bot_settings")
              .select("id, require_approval_all")
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (!settings?.require_approval_all) {
              return { ran: false as const, reason: "auto-send already on" };
            }
            const { error: markerErr } = await supabase.from("bot_decisions").insert({
              trigger: "scheduled",
              stage: "config",
              status: "ok",
              summary: `${MARKER} — require_approval_all set back to false`,
              data: { flipped_at: new Date().toISOString() },
            });
            if (markerErr) throw new Error(`marker insert failed: ${markerErr.message}`);
            const { error: flipErr } = await supabase
              .from("bot_settings")
              .update({ require_approval_all: false, updated_at: new Date().toISOString() })
              .eq("id", settings.id);
            if (flipErr) throw new Error(`flip failed: ${flipErr.message}`);
            return { ran: true as const };
          });

          // The group engine runs FIRST after the job drain: the sweep request
          // only survives ~a minute of wall clock (2026-07-24 evidence:
          // LLM-drafting posts died mid-fetch with their failure handlers
          // never running), so the stage that makes LLM calls gets the budget
          // and the cheap, marker-throttled data passes run on what's left.
          const groups = await guarded("group-engine", async () => {
            const { runGroupEngine } = await import("@/lib/agent/posting.server");
            return runGroupEngine(deps);
          });
          // Channel backfill before cleanup so scope tags exist for both.
          const channel = await guarded("channel-backfill", async () => {
            const { backfillChannelPhone } = await import("@/lib/agent/channel-backfill.server");
            return backfillChannelPhone(supabase);
          });
          // Dedupe before cleanup: cleanup matches people to conversations by
          // canonical digits, so collapsing wa_id spellings first keeps its
          // keep/delete decisions accurate.
          const dedupe = await guarded("people-dedupe", async () => {
            const { dedupePeople } = await import("@/lib/agent/people-dedupe.server");
            return dedupePeople(supabase);
          });
          const cleanup = await guarded("cleanup", async () => {
            const { cleanupNonParticipatedChats } = await import("@/lib/agent/cleanup.server");
            return cleanupNonParticipatedChats(supabase);
          });
          const followUps = await guarded("follow-ups", async () => {
            const { processDueFollowUps } = await import("@/lib/agent/follow-ups.server");
            return processDueFollowUps(deps, { max: 2 });
          });
          const analytics = await guarded("analytics", async () => {
            const { runAnalytics } = await import("@/lib/agent/analytics.server");
            return runAnalytics(deps);
          });

          return Response.json({
            ok: true,
            claimed: run.claimed,
            results: run.results.map((r) => ({ jobId: r.jobId, action: r.outcome.action })),
            follow_ups: followUps,
            groups,
            analytics,
            cleanup,
            channel,
            dedupe,
            approval_restore: approvalRestore,
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
