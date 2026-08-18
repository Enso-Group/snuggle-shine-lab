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
      GET: async ({ request }) => {
        try {
          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } },
          );

          // ?probe=1 — LIVE integration check: one real Tavily search, one
          // real fast-LLM call, a Whapi /health call and a DB write, each
          // reported with latency. This endpoint is unauthenticated, so real
          // probes are throttled to one per 10 minutes via a decision-row
          // marker; inside the window the last result is returned instead.
          let probe: Record<string, unknown> | null = null;
          const probeParam = new URL(request.url).searchParams.get("probe");

          // ?probe=imagegen — ONE-SHOT live proof of gateway image generation
          // (marker-gated: generation costs credits, so it never re-runs on
          // repeated calls; the stored result is returned instead). Generates
          // a real image, uploads it to the media bucket, returns the signed
          // preview URL + which model answered.
          if (probeParam === "imagegen") {
            const MARKER = "Image gen self-test v1";
            try {
              const { data: done } = await supabase
                .from("bot_decisions")
                .select("created_at, data")
                .eq("stage", "config")
                .like("summary", `${MARKER}%`)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (done) {
                probe = { image_gen: { already_ran: true, at: done.created_at, last: done.data } };
              } else {
                const { generateImage } = await import("@/lib/image-gen.server");
                const t0 = Date.now();
                const g = await generateImage(
                  "A warm, modern flat illustration of a small business community chatting on their phones, soft teal and green palette, no text or letters anywhere in the image.",
                  { source: "image_gen_selftest" },
                );
                const result = {
                  ok: true,
                  model: g.model,
                  storage_path: g.attachment.storage_path,
                  preview_url: g.attachment.url,
                  ms: Date.now() - t0,
                };
                await supabase.from("bot_decisions").insert({
                  trigger: "scheduled",
                  stage: "config",
                  status: "ok",
                  summary: `${MARKER}: generated via ${g.model} in ${Math.round((Date.now() - t0) / 1000)}s and stored in the media bucket`,
                  data: result,
                });
                probe = { image_gen: result };
              }
            } catch (e) {
              probe = {
                image_gen: { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) },
              };
            }
          }

          // ?probe=dmimage — END-TO-END proof of the DM image pipeline, step
          // by step: generate via the gateway → store in the media bucket →
          // mint a signed URL → send as a real WhatsApp image to the OWNER's
          // own chat (message-yourself). Marker-gated per version — repeated
          // calls return the stored trace instead of spending credits/sends.
          if (probeParam === "dmimage") {
            // v4: re-armed 2026-07-28 — v2/v3 measured BOTH GPT image models
            // >20s at medium quality. This run mirrors the DM pipeline
            // exactly: 20s per candidate at quality "low".
            const MARKER = "DM image self-test v4";
            try {
              const { data: done } = await supabase
                .from("bot_decisions")
                .select("created_at, data")
                .eq("stage", "config")
                .like("summary", `${MARKER}%`)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (done) {
                probe = { dm_image: { already_ran: true, at: done.created_at, last: done.data } };
              } else {
                const trace: Record<string, unknown> = {};
                const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
                  const t0 = Date.now();
                  try {
                    const out = await fn();
                    trace[label] = { ok: true, ms: Date.now() - t0 };
                    return out;
                  } catch (e) {
                    trace[label] = {
                      ok: false,
                      ms: Date.now() - t0,
                      error: String((e as Error)?.message ?? e).slice(0, 300),
                    };
                    throw e;
                  }
                };
                try {
                  const ch = await step("1_channel", async () => {
                    const { getConnectedChannel } = await import("@/lib/agent/channel.server");
                    const c = await getConnectedChannel();
                    if (!c.connected || !c.phone) throw new Error("no connected WhatsApp channel");
                    return c;
                  });
                  const generated = await step("2_generate", async () => {
                    const { generateImage } = await import("@/lib/image-gen.server");
                    // Same shape as the DM pipeline: 20s per candidate at
                    // quality "low" so a stalling lead model hands over to
                    // the next GPT model.
                    return generateImage(
                      "A cozy, photorealistic golden retriever puppy sitting in a sunlit garden, shallow depth of field, no text or letters in the image.",
                      {
                        source: "dm_image_selftest",
                        timeoutMs: 20_000,
                        budgetMs: 45_000,
                        quality: "low",
                      },
                    );
                  });
                  trace["2_generate"] = {
                    ...(trace["2_generate"] as Record<string, unknown>),
                    model: generated.model,
                    storage_path: generated.attachment.storage_path,
                  };
                  const sendRes = await step("3_send_whatsapp", async () => {
                    const { sendMediaMessage } = await import("@/lib/media.server");
                    return (await sendMediaMessage(
                      `${ch.phone}@s.whatsapp.net`,
                      generated.attachment,
                      "🧪 DM image self-test — this exact pipeline (generate → store → sign → send) serves DM image requests.",
                    )) as { message?: { id?: string } };
                  });
                  trace["3_send_whatsapp"] = {
                    ...(trace["3_send_whatsapp"] as Record<string, unknown>),
                    whapi_message_id: sendRes?.message?.id ?? null,
                  };
                  trace.ok = true;
                } catch {
                  trace.ok = false;
                }
                await supabase.from("bot_decisions").insert({
                  trigger: "scheduled",
                  stage: "config",
                  status: trace.ok ? "ok" : "error",
                  summary: `${MARKER}: ${trace.ok ? "image generated AND delivered to the owner chat" : "FAILED — see step trace"}`,
                  data: trace,
                });
                probe = { dm_image: trace };
              }
            } catch (e) {
              probe = {
                dm_image: { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) },
              };
            }
          }

          // ?probe=researchmedia — END-TO-END proof of media-from-search:
          // Tavily search (with images) → candidate collection → download +
          // byte-validation → re-host in the bucket → real WhatsApp image to
          // the owner chat with caption + source link. Marker-gated per
          // version, same as the other one-shot probes.
          if (probeParam === "researchmedia") {
            const MARKER = "Research media self-test v1";
            try {
              const { data: done } = await supabase
                .from("bot_decisions")
                .select("created_at, data")
                .eq("stage", "config")
                .like("summary", `${MARKER}%`)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (done) {
                probe = {
                  research_media: { already_ran: true, at: done.created_at, last: done.data },
                };
              } else {
                const trace: Record<string, unknown> = {};
                try {
                  const { getConnectedChannel } = await import("@/lib/agent/channel.server");
                  const ch = await getConnectedChannel();
                  if (!ch.connected || !ch.phone) throw new Error("no connected WhatsApp channel");
                  const { tavilySearch, isTavilyConfigured } = await import("@/lib/tavily.server");
                  if (!isTavilyConfigured()) throw new Error("TAVILY_API_KEY not configured");
                  let t0 = Date.now();
                  const search = await tavilySearch("Tel Aviv skyline photo", {
                    maxResults: 5,
                    timeoutMs: 8_000,
                    budgetMs: 10_000,
                  });
                  trace.search = {
                    ok: true,
                    ms: Date.now() - t0,
                    results: search.results.length,
                    images: search.images?.length ?? 0,
                  };
                  const { collectMediaCandidates, fetchFirstUsableMedia } =
                    await import("@/lib/agent/research-media.server");
                  const candidates = collectMediaCandidates(search, null);
                  t0 = Date.now();
                  const stored = await fetchFirstUsableMedia(candidates, {
                    budgetMs: 15_000,
                    preferKind: "image",
                  });
                  trace.fetch_validate = {
                    ok: !!stored,
                    ms: Date.now() - t0,
                    candidates: candidates.length,
                    kind: stored?.attachment.kind ?? null,
                    storage_path: stored?.attachment.storage_path ?? null,
                    source_url: stored?.sourceUrl ?? null,
                  };
                  if (!stored) throw new Error("no candidate survived download+validation");
                  t0 = Date.now();
                  const { sendMediaMessage } = await import("@/lib/media.server");
                  const sendRes = (await sendMediaMessage(
                    `${ch.phone}@s.whatsapp.net`,
                    stored.attachment,
                    `🧪 Research-media self-test — a REAL image found by web search, validated and re-sent.\nמקור: ${(await import("@/lib/agent/url-display")).prettyUrl(stored.sourceUrl)}`,
                  )) as { message?: { id?: string } };
                  trace.send = {
                    ok: true,
                    ms: Date.now() - t0,
                    whapi_message_id: sendRes?.message?.id ?? null,
                  };
                  trace.ok = true;
                } catch (e) {
                  trace.ok = false;
                  trace.error = String((e as Error)?.message ?? e).slice(0, 300);
                }
                await supabase.from("bot_decisions").insert({
                  trigger: "scheduled",
                  stage: "config",
                  status: trace.ok ? "ok" : "error",
                  summary: `${MARKER}: ${trace.ok ? "search → validate → deliver all passed" : "FAILED — see trace"}`,
                  data: trace,
                });
                probe = { research_media: trace };
              }
            } catch (e) {
              probe = {
                research_media: {
                  ok: false,
                  error: String((e as Error)?.message ?? e).slice(0, 300),
                },
              };
            }
          }

          // ?probe=researchdiag — direct production test calls for the whole
          // research stack: per tool, the EXACT request (URL, key present —
          // never the key itself), raw status, latency and a body snippet.
          // For Apollo the old wrong path is probed too so the 404 evidence
          // is on record next to the fixed path's result. Throttled to one
          // real run per 10 minutes (unauthenticated endpoint, paid APIs).
          if (probeParam === "researchdiag") {
            const MARKER = "Research diag v1";
            try {
              const { data: recent } = await supabase
                .from("bot_decisions")
                .select("created_at, data")
                .eq("stage", "config")
                .like("summary", `${MARKER}%`)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (recent && Date.now() - new Date(recent.created_at).getTime() < 10 * 60_000) {
                probe = { throttled: true, last_at: recent.created_at, last: recent.data };
              } else {
                const diag: Record<string, unknown> = {};
                // --- Tavily: one direct call, generous timeout, measured ---
                {
                  const url = "https://api.tavily.com/search";
                  const keyPresent = !!process.env.TAVILY_API_KEY;
                  const t0 = Date.now();
                  if (!keyPresent) {
                    diag.tavily = {
                      url,
                      key_present: false,
                      error: "TAVILY_API_KEY not set in production",
                    };
                  } else {
                    try {
                      const ctrl = new AbortController();
                      const timer = setTimeout(() => ctrl.abort(), 20_000);
                      const res = await fetch(url, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
                        },
                        body: JSON.stringify({
                          query: "Gigi Levy-Weiss NFX investor",
                          search_depth: "basic",
                          max_results: 5,
                          include_answer: true,
                          include_images: true,
                          include_image_descriptions: true,
                        }),
                        signal: ctrl.signal,
                      });
                      const bodyText = await res.text();
                      clearTimeout(timer);
                      let parsed: { results?: unknown[]; images?: unknown[]; answer?: unknown } =
                        {};
                      try {
                        parsed = JSON.parse(bodyText);
                      } catch {
                        /* snippet below carries the evidence */
                      }
                      diag.tavily = {
                        url,
                        key_present: true,
                        status: res.status,
                        ms: Date.now() - t0,
                        results: Array.isArray(parsed.results) ? parsed.results.length : null,
                        images: Array.isArray(parsed.images) ? parsed.images.length : null,
                        has_answer: typeof parsed.answer === "string" && !!parsed.answer,
                        top_result:
                          Array.isArray(parsed.results) && parsed.results[0]
                            ? {
                                title: String(
                                  (parsed.results[0] as { title?: unknown }).title ?? "",
                                ).slice(0, 120),
                                url: String((parsed.results[0] as { url?: unknown }).url ?? ""),
                              }
                            : null,
                        ...(res.ok ? {} : { body_snippet: bodyText.slice(0, 300) }),
                      };
                    } catch (e) {
                      diag.tavily = {
                        url,
                        key_present: true,
                        ms: Date.now() - t0,
                        error:
                          (e as Error)?.name === "AbortError"
                            ? "timed out after 20s"
                            : String((e as Error)?.message ?? e).slice(0, 200),
                      };
                    }
                  }
                }
                // --- Apollo: fixed path AND the old wrong path, side by side ---
                {
                  const keyPresent = !!process.env.APOLLO_API_KEY;
                  const attempt = async (url: string): Promise<Record<string, unknown>> => {
                    const t0 = Date.now();
                    try {
                      const ctrl = new AbortController();
                      const timer = setTimeout(() => ctrl.abort(), 15_000);
                      const res = await fetch(url, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "x-api-key": process.env.APOLLO_API_KEY ?? "",
                        },
                        body: JSON.stringify({
                          q_keywords: "Gigi Levy-Weiss NFX",
                          person_names: ["Gigi Levy-Weiss"],
                          page: 1,
                          per_page: 1,
                        }),
                        signal: ctrl.signal,
                      });
                      const bodyText = await res.text();
                      clearTimeout(timer);
                      let people: unknown[] = [];
                      try {
                        const parsed = JSON.parse(bodyText) as { people?: unknown[] };
                        if (Array.isArray(parsed.people)) people = parsed.people;
                      } catch {
                        /* snippet carries it */
                      }
                      const first = people[0] as
                        | { name?: unknown; title?: unknown; organization?: { name?: unknown } }
                        | undefined;
                      return {
                        url,
                        status: res.status,
                        ms: Date.now() - t0,
                        matches: people.length,
                        first_match: first
                          ? {
                              name: String(first.name ?? "").slice(0, 80),
                              title: String(first.title ?? "").slice(0, 120),
                              company: String(first.organization?.name ?? "").slice(0, 80),
                            }
                          : null,
                        ...(res.ok ? {} : { body_snippet: bodyText.slice(0, 300) }),
                      };
                    } catch (e) {
                      return {
                        url,
                        ms: Date.now() - t0,
                        error:
                          (e as Error)?.name === "AbortError"
                            ? "timed out after 15s"
                            : String((e as Error)?.message ?? e).slice(0, 200),
                      };
                    }
                  };
                  if (!keyPresent) {
                    diag.apollo = {
                      key_present: false,
                      error: "APOLLO_API_KEY not set in production",
                    };
                  } else {
                    const { APOLLO_SEARCH_URL } = await import("@/lib/apollo.server");
                    diag.apollo = {
                      key_present: true,
                      fixed_path: await attempt(APOLLO_SEARCH_URL),
                      old_wrong_path: await attempt("https://api.apollo.io/v1/mixed_people_search"),
                    };
                  }
                }
                await supabase.from("bot_decisions").insert({
                  trigger: "scheduled",
                  stage: "config",
                  status: "ok",
                  summary: `${MARKER}: direct Tavily + Apollo test calls from production`,
                  data: diag,
                });
                probe = diag;
              }
            } catch (e) {
              probe = {
                research_diag: {
                  ok: false,
                  error: String((e as Error)?.message ?? e).slice(0, 300),
                },
              };
            }
          }

          // ?probe=models — read-only: the gateway's LIVE model catalog, the
          // authoritative answer to "which models (image? video?) exist here".
          // Model ids only, no secrets. Also probes one video-model id so the
          // rejection error is on record.
          if (probeParam === "models") {
            try {
              const apiKey = process.env.LOVABLE_API_KEY;
              if (!apiKey) {
                probe = { models: { ok: false, error: "LOVABLE_API_KEY not configured" } };
              } else {
                const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
                  headers: { "Lovable-API-Key": apiKey, Authorization: `Bearer ${apiKey}` },
                });
                const bodyText = await res.text();
                let ids: string[] | null = null;
                try {
                  const parsed = JSON.parse(bodyText) as {
                    data?: Array<{ id?: string }>;
                    models?: Array<{ id?: string } | string>;
                  };
                  const list = parsed.data ?? parsed.models;
                  if (Array.isArray(list)) {
                    ids = list
                      .map((m) => (typeof m === "string" ? m : String(m?.id ?? "")))
                      .filter(Boolean)
                      .sort();
                  }
                } catch {
                  /* non-JSON body — return the raw snippet below */
                }
                // A battery of endpoint/model attempts — each rejection's
                // exact wording is the evidence for what the gateway does and
                // does not serve.
                const attempt = async (
                  path: string,
                  body: Record<string, unknown> | null,
                  method = "POST",
                ): Promise<Record<string, unknown>> => {
                  try {
                    const r = await fetch(`https://ai.gateway.lovable.dev${path}`, {
                      method,
                      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
                      ...(body ? { body: JSON.stringify(body) } : {}),
                    });
                    return { path, status: r.status, body: (await r.text()).slice(0, 2500) };
                  } catch (e) {
                    return { path, error: String((e as Error)?.message ?? e).slice(0, 200) };
                  }
                };
                const video = {
                  // The prize: an invalid model id makes the gateway enumerate
                  // its FULL allowed-models list in the error body.
                  full_catalog_via_error: await attempt("/v1/chat/completions", {
                    model: "definitely/not-a-model",
                    messages: [{ role: "user", content: "hi" }],
                  }),
                  veo_videos_post: await attempt("/v1/videos/generations", {
                    model: "google/veo-3.1",
                    prompt: "A 3 second clip of ocean waves",
                  }),
                  veo_videos_get: await attempt("/v1/videos/generations", null, "GET"),
                  veo_video_singular: await attempt("/v1/video/generations", {
                    model: "google/veo-3.1",
                    prompt: "A 3 second clip of ocean waves",
                  }),
                };
                probe = {
                  models: {
                    ok: res.ok,
                    http: res.status,
                    count: ids?.length ?? null,
                    ids: ids ?? bodyText.slice(0, 800),
                    video_attempt: video,
                  },
                };
              }
            } catch (e) {
              probe = {
                models: { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) },
              };
            }
          }

          const probeRequested = probeParam === "1";
          if (probeRequested) {
            const MARKER = "Integration probe v1";
            probe = {};
            try {
              const { data: recent } = await supabase
                .from("bot_decisions")
                .select("created_at, data")
                .eq("stage", "config")
                .like("summary", `${MARKER}%`)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (recent && Date.now() - new Date(recent.created_at).getTime() < 10 * 60_000) {
                probe = { throttled: true, last_at: recent.created_at, last: recent.data };
              } else {
                try {
                  const { checkHealth } = await import("@/lib/whapi.server");
                  const t0 = Date.now();
                  const h = await checkHealth();
                  probe.whapi = h.ok
                    ? { ok: true, status: h.status, ms: Date.now() - t0 }
                    : { ok: false, error: String(h.error ?? "").slice(0, 200) };
                } catch (e) {
                  probe.whapi = {
                    ok: false,
                    error: String((e as Error)?.message ?? e).slice(0, 200),
                  };
                }
                try {
                  const { isTavilyConfigured, tavilySearch } = await import("@/lib/tavily.server");
                  if (!isTavilyConfigured()) {
                    probe.tavily = { ok: false, error: "TAVILY_API_KEY not configured" };
                  } else {
                    const t0 = Date.now();
                    const r = await tavilySearch("WhatsApp Business automation news", {
                      maxResults: 3,
                      timeoutMs: 8_000,
                      budgetMs: 10_000,
                    });
                    probe.tavily = {
                      ok: true,
                      results: r.results.length,
                      has_answer: !!r.answer,
                      top_url: r.results[0]?.url ?? null,
                      ms: Date.now() - t0,
                    };
                  }
                } catch (e) {
                  probe.tavily = {
                    ok: false,
                    error: String((e as Error)?.message ?? e).slice(0, 200),
                  };
                }
                try {
                  const { isApifyConfigured, xSearch } = await import("@/lib/apify-x.server");
                  if (!isApifyConfigured()) {
                    probe.apify_x = { ok: false, error: "APIFY_API_KEY not configured" };
                  } else {
                    const t0 = Date.now();
                    const r = await xSearch("AI news", {
                      maxItems: 5,
                      timeoutMs: 25_000,
                      budgetMs: 26_000,
                    });
                    probe.apify_x = {
                      ok: true,
                      results: r.results.length,
                      top_url: r.results[0]?.url ?? null,
                      top_author: r.results[0]?.author ?? null,
                      ms: Date.now() - t0,
                    };
                  }
                } catch (e) {
                  probe.apify_x = {
                    ok: false,
                    error: String((e as Error)?.message ?? e).slice(0, 200),
                  };
                }
                try {
                  const { callLLM } = await import("@/lib/llm.server");
                  const t0 = Date.now();
                  const r = await callLLM({
                    role: "fast",
                    source: "integration_probe",
                    timeoutMs: 10_000,
                    budgetMs: 12_000,
                    messages: [{ role: "user", content: "Reply with the single word: OK" }],
                  });
                  probe.llm = {
                    ok: true,
                    model: r.model,
                    reply: r.content.slice(0, 20),
                    ms: Date.now() - t0,
                  };
                } catch (e) {
                  probe.llm = {
                    ok: false,
                    error: String((e as Error)?.message ?? e).slice(0, 300),
                  };
                }
                // The marker doubles as the DB-write proof (awaited — CF drops
                // fire-and-forget writes when the response returns).
                const ok = (x: unknown) => !!(x as { ok?: boolean } | null)?.ok;
                const { error: markerErr } = await supabase.from("bot_decisions").insert({
                  trigger: "scheduled",
                  stage: "config",
                  status: ok(probe.whapi) && ok(probe.tavily) && ok(probe.llm) ? "ok" : "error",
                  summary: `${MARKER}: llm=${ok(probe.llm) ? "ok" : "FAIL"} tavily=${ok(probe.tavily) ? "ok" : "FAIL"} whapi=${ok(probe.whapi) ? "ok" : "FAIL"}`,
                  data: probe,
                });
                probe.db_write = markerErr ? { ok: false, error: markerErr.message } : { ok: true };
              }
            } catch (e) {
              probe = { error: String((e as Error)?.message ?? e).slice(0, 300) };
            }
          }

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
              const chatStr = String(row.chat_id ?? "");
              const isGroup = chatStr.endsWith("@g.us");
              const isDemo = chatStr.startsWith("demo-");
              if (!isGroup && !isDemo && d.latency_breakdown && recentDmReplies.length < 10) {
                recentDmReplies.push({ at: row.created_at, ...d.latency_breakdown });
              }
            }
          } catch {
            // best-effort — never fail the health check over observability
          }

          // Research-promise SLA observability: recent research_answer jobs
          // with their deadline math (numbers and status only, no content) —
          // the external proof that "I'll check and get back" answers land
          // inside 10 minutes.
          let research: Record<string, unknown> | string = {};
          try {
            const { parseResearchPayload } = await import("@/lib/agent/research");
            const { isTavilyConfigured } = await import("@/lib/tavily.server");
            const { data: rjobs } = await supabase
              .from("bot_jobs")
              .select("status, attempts, payload, created_at, updated_at, last_error")
              .eq("kind", "research_answer")
              .order("created_at", { ascending: false })
              .limit(10);
            const nowMs = Date.now();
            research = {
              // Whether the production runtime can actually read the Tavily
              // secret — the boolean only, never the value.
              tavily_configured: isTavilyConfigured(),
              apify_x_configured: (await import("@/lib/apify-x.server")).isApifyConfigured(),
              recent: (rjobs ?? []).map((j) => {
                const p = parseResearchPayload(j.payload);
                return {
                  status: j.status,
                  attempts: j.attempts,
                  created_at: j.created_at,
                  minutes_since_promise: p ? Math.round((nowMs - p.promised_at) / 60_000) : null,
                  interim_sent: p?.interim_sent ?? null,
                  answer_ready: !!p?.answer_parts?.length,
                  overdue:
                    !!p && j.status !== "done" && j.status !== "superseded"
                      ? nowMs > p.deadline_at
                      : false,
                  last_error: j.last_error ? String(j.last_error).slice(0, 200) : null,
                };
              }),
            };
          } catch (e) {
            research = String((e as Error)?.message ?? e);
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
              .select(
                "kind, chat_id, status, attempts, max_attempts, last_error, run_after, updated_at",
              )
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
              .select(
                "group_chat_id, status, source, reasoning, engagement, created_at, updated_at",
              )
              .in("status", ["planned", "failed"])
              .order("created_at", { ascending: true })
              .limit(10);
            debug.planned_posts = {
              counts: postCounts,
              stuck: (stuckPosts ?? []).map((p) => {
                // Generation-lease bookkeeping lives in the engagement jsonb;
                // exposing model + lease horizon alongside attempts is what
                // lets a killed attempt's story be read from outside (which
                // model died, when the lease frees the post for retry).
                const gen = (p.engagement ?? null) as {
                  gen_attempts?: number;
                  gen_last_model?: string;
                  gen_lease_until?: string;
                } | null;
                return {
                  chat: maskChat(p.group_chat_id),
                  status: p.status,
                  source: p.source,
                  reasoning: p.reasoning ? String(p.reasoning).slice(0, 200) : null,
                  gen_attempts: gen?.gen_attempts ?? null,
                  gen_last_model: gen?.gen_last_model ?? null,
                  gen_lease_until: gen?.gen_lease_until ?? null,
                  created_at: p.created_at,
                  updated_at: p.updated_at,
                };
              }),
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
            // Seeded demo rows (chat id marked demo-) are staged content for
            // recordings, never real failures — keep diagnostics honest.
            debug.error_decisions = (errs ?? [])
              .filter((r) => !String(r.chat_id ?? "").startsWith("demo-"))
              .map((r) => ({
                at: r.created_at,
                stage: r.stage,
                chat: maskChat(r.chat_id),
                summary: String(r.summary ?? "").slice(0, 220),
              }));
          } catch (e) {
            debug.error_decisions = String((e as Error)?.message ?? e);
          }
          try {
            // The flip side of recent_dm_replies: DM decisions that ended
            // WITHOUT a reply (skips + errors), so a silent contact can be
            // diagnosed from outside without auth. Group rows are noise here —
            // the never-silent SLA is DM-only, so they're filtered out
            // (over-fetch then filter, since chat shape isn't queryable).
            const { data: noReply } = await supabase
              .from("bot_decisions")
              .select("created_at, stage, status, chat_id, summary")
              .in("status", ["skip", "error"])
              .order("created_at", { ascending: false })
              .limit(50);
            debug.recent_dm_no_reply = (noReply ?? [])
              .filter((r) => {
                const chat = String(r.chat_id ?? "");
                return chat !== "" && !chat.endsWith("@g.us") && !chat.startsWith("demo-");
              })
              .slice(0, 8)
              .map((r) => ({
                at: r.created_at,
                stage: r.stage,
                status: r.status,
                chat: maskChat(r.chat_id),
                summary: String(r.summary ?? "").slice(0, 200),
              }));
          } catch (e) {
            debug.recent_dm_no_reply = String((e as Error)?.message ?? e);
          }
          try {
            const { count: totalPeople } = await supabase
              .from("people")
              .select("id", { count: "exact", head: true });
            const { data: peopleRows } = await supabase
              .from("people")
              .select("id, wa_id, display_name")
              .limit(2000);
            const byPhone = new Map<string, number>();
            const byName = new Map<string, number>();
            for (const r of peopleRows ?? []) {
              const phone = String(r.wa_id ?? "")
                .split("@")[0]
                .replace(/\D/g, "");
              if (phone) byPhone.set(phone, (byPhone.get(phone) ?? 0) + 1);
              // Names under 5 chars are ignored — same threshold as the v2
              // dedupe's cross-format match, so this counter mirrors what the
              // dedupe is allowed to fix.
              const name = String(r.display_name ?? "")
                .trim()
                .toLowerCase();
              if (name.length >= 5) byName.set(name, (byName.get(name) ?? 0) + 1);
            }
            debug.people = {
              total: totalPeople ?? 0,
              duplicate_phone_groups: [...byPhone.values()].filter((n) => n > 1).length,
              // Cross-format dupes ('@lid' + phone row for one human) share no
              // digits, so duplicate_phone_groups reads 0 while the dashboard
              // still shows the same name twice — this counter is the external
              // proof that class of dupe is gone.
              // Informational, NOT a defect count: distinct people can share
              // a display name (the owner has a contact with two phones) —
              // dedupe never merges on names, this just makes such pairs
              // visible so a "duplicate" report can be triaged from outside.
              name_collisions: [...byName.values()].filter((n) => n > 1).length,
            };
          } catch (e) {
            debug.people = String((e as Error)?.message ?? e);
          }

          return Response.json({
            ok: true,
            info: "Bot-jobs sweeper. POST with x-cron-secret to trigger a run.",
            ...(probe ? { probe } : {}),
            queue: counts,
            follow_ups_pending: followUpsPending,
            research,
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
      // DISCONNECTED (2026-08-17). WhatsApp moved to kindred-spirits. This
      // cron endpoint is refused at the door rather than left to fail one job
      // at a time: without this it would wake every minute, pull work, and
      // burn each item against a guard it can never pass, turning a clean
      // shutdown into a retry storm in the logs and the queue.
      //
      // The pg_cron schedules are unscheduled as well — this is the belt to
      // that braces, so a schedule surviving anywhere still does nothing.
      POST: async () =>
        Response.json(
          {
            ok: false,
            disconnected: true,
            info: "WhatsApp is disconnected from this project; the bot runs in kindred-spirits.",
          },
          { status: 410 },
        ),

      /** The original handler, kept for the reconnect path. Unreachable today. */
      _disabledPOST: async ({ request }: { request: Request }) => {
        const requestStartedAt = Date.now();
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

          // Research-promise deadline watchdog runs FIRST, before the job
          // drain, in BOTH tick shapes: it is the only actor that guarantees
          // the 10-minute interim, it costs one cheap indexed select when
          // nothing is overdue, and a single legitimate ~45s research job in
          // the drain would otherwise push it past the ~60s request wall.
          let researchInterims: unknown = null;
          try {
            const { sendOverdueResearchInterims } = await import("@/lib/agent/research.server");
            researchInterims = await sendOverdueResearchInterims(deps, { max: jobsOnly ? 2 : 4 });
          } catch (e) {
            console.error("[jobs] research-interims failed", e);
            researchInterims = { error: String((e as Error)?.message ?? e).slice(0, 300) };
          }

          // Never-silent backstop for WALL-KILLED reply jobs: attempts that
          // die by platform kill never run the worker's catch path, so the
          // job lands in 'failed' with zero output. This pass gives such jobs
          // the alert + canned fallback + research follow-up they were owed.
          let deadJobs: unknown = null;
          try {
            const { sweepDeadReplyJobs } = await import("@/lib/agent/worker.server");
            deadJobs = await sweepDeadReplyJobs(deps, { max: 2 });
          } catch (e) {
            console.error("[jobs] dead-job sweep failed", e);
            deadJobs = { error: String((e as Error)?.message ?? e).slice(0, 300) };
          }

          // Cap at 3 per tick: each job may do a short (<=20s) top-up wait, and
          // they run serially, so this bounds a single Worker invocation's time.
          // Jobs beyond the cap are picked up on the next 20s tick.
          const run = await processQueuedJobs(deps, { max: 3 });
          if (jobsOnly) {
            // The fast tick also drains planned posts so planning→sent stays
            // inside ~a minute instead of waiting for the full per-minute
            // sweep. Safe to run from every tick: generation is protected by
            // a per-post lease+CAS claim inside the engine, so a concurrent
            // tick just reports 'leased'/'lost_claim' without doing work.
            // max: 1 keeps this request to at most one LLM generation — the
            // runtime kills us after ~a minute of wall clock. And if the job
            // drain already ate the wall (up to 3 jobs × 20s top-up waits),
            // starting a generation would claim a lease we can't honor — skip,
            // the next 20s tick will pick the post up with a fresh budget.
            let posts: Array<{ group: string; status: string }> = [];
            if (Date.now() - requestStartedAt > 15_000) {
              posts = [{ group: "*", status: "drain_skipped_wall_budget" }];
            } else {
              try {
                const { drainPlannedPosts } = await import("@/lib/agent/posting.server");
                posts = await drainPlannedPosts(deps, { max: 1 });
              } catch (e) {
                // A post-drain failure must never break the job drain — DM
                // replies are the fast tick's primary duty.
                console.error("[jobs] planned-post drain failed", e);
              }
            }
            return Response.json({
              ok: true,
              jobs_only: true,
              claimed: run.claimed,
              results: run.results.map((r) => ({ jobId: r.jobId, action: r.outcome.action })),
              research_interims: researchInterims,
              dead_jobs: deadJobs,
              posts,
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

          // One-shot model pin (2026-07-26, Itamar: "use only gpt 5.5"): any
          // stored model override in bot_settings outranks the code chain, so
          // the pin is written to the DB too. Marker-gated — a later
          // deliberate change in the Personality tab is never fought.
          const modelPin = await guarded("model-pin", async () => {
            const MARKER = "Model pin v1 — gpt-5.5";
            const { data: done } = await supabase
              .from("bot_decisions")
              .select("id")
              .eq("stage", "config")
              .like("summary", `${MARKER}%`)
              .limit(1)
              .maybeSingle();
            if (done) return { ran: false as const, reason: "already pinned" };
            const { data: settings } = await supabase
              .from("bot_settings")
              .select("id, model_strong, model_fast")
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (!settings?.id) return { ran: false as const, reason: "no settings row" };
            const { error: markerErr } = await supabase.from("bot_decisions").insert({
              trigger: "scheduled",
              stage: "config",
              status: "ok",
              summary: `${MARKER}: model_strong/model_fast set to openai/gpt-5.5 (were ${settings.model_strong ?? "null"}/${settings.model_fast ?? "null"})`,
              data: { previous_strong: settings.model_strong, previous_fast: settings.model_fast },
            });
            if (markerErr) throw new Error(`marker insert failed: ${markerErr.message}`);
            const { error: pinErr } = await supabase
              .from("bot_settings")
              .update({
                model_strong: "openai/gpt-5.5",
                model_fast: "openai/gpt-5.5",
                updated_at: new Date().toISOString(),
              })
              .eq("id", settings.id);
            if (pinErr) throw new Error(`pin failed: ${pinErr.message}`);
            return { ran: true as const };
          });

          // One-shot demo teardown (2026-07-26, Itamar: "take out the demo"):
          // deletes every `demo-`-marked row left from the earlier server-side
          // seeding and clears agent_config.demo_view, so the dashboard shows
          // real data again. Marker-gated — a later deliberate re-seed is
          // never fought. Runs here because the Lovable DB is reachable only
          // through the app's own service-role client.
          const demoWipe = await guarded("demo-wipe", async () => {
            const MARKER = "Demo wipe v1";
            const { data: done } = await supabase
              .from("bot_decisions")
              .select("id")
              .eq("stage", "config")
              .like("summary", `${MARKER}%`)
              .limit(1)
              .maybeSingle();
            if (done) return { ran: false as const, reason: "already wiped" };
            const { wipeAll, setDemoView } = await import("@/lib/demo-seed");
            const result = await wipeAll(supabase);
            await setDemoView(supabase, false);
            const removedTotal = Object.values(result.removed).reduce((a, b) => a + b, 0);
            const failedCount = Object.keys(result.failed).length;
            // Marker AFTER the wipe (awaited): a wall-kill mid-wipe should
            // retry next sweep — wipeAll is idempotent (delete by marker).
            const { error: markerErr } = await supabase.from("bot_decisions").insert({
              trigger: "scheduled",
              stage: "config",
              status: failedCount ? "error" : "ok",
              summary: `${MARKER}: removed ${removedTotal} demo row(s) across ${Object.keys(result.removed).length} table(s)${failedCount ? `, ${failedCount} table(s) FAILED` : ""} — demo view off`,
              data: result as unknown as Record<string, never>,
            });
            if (markerErr) throw new Error(`marker insert failed: ${markerErr.message}`);
            return { ran: true as const, ...result };
          });

          // One-shot media self-test: proves image/video/document sending
          // works END TO END in production by messaging the connected
          // account's own chat (WhatsApp "message yourself") with the three
          // demo assets served by this very site. Marker-gated — runs exactly
          // once per version; visible proof lands on the owner's phone and as
          // a config decision with the Whapi message ids.
          const mediaSelfTest = await guarded("media-self-test", async () => {
            // v2: re-armed 2026-07-26 so the first full sweep after WhatsApp
            // is reconnected re-proves image/video/PDF delivery end to end
            // (v1 passed live 2026-07-26 07:26Z before the disconnect).
            const MARKER = "Media send self-test v2";
            const { data: done } = await supabase
              .from("bot_decisions")
              .select("id")
              .eq("stage", "config")
              .like("summary", `${MARKER}%`)
              .limit(1)
              .maybeSingle();
            if (done) return { ran: false as const, reason: "already ran" };
            const { getConnectedChannel } = await import("@/lib/agent/channel.server");
            const ch = await getConnectedChannel();
            if (!ch.connected || !ch.phone) return { ran: false as const, reason: "no channel" };
            // Marker FIRST (awaited): a wall-kill mid-test must never cause
            // the owner to get spammed with test media on every sweep.
            const { error: markerErr } = await supabase.from("bot_decisions").insert({
              trigger: "scheduled",
              stage: "config",
              status: "ok",
              summary: `${MARKER} — sending image/video/document to the owner chat`,
              data: { started_at: new Date().toISOString() },
            });
            if (markerErr) throw new Error(`marker insert failed: ${markerErr.message}`);
            const selfChat = `${ch.phone}@s.whatsapp.net`;
            const base = "https://snuggle-shine-lab.lovable.app/demo";
            const { sendMediaMessage } = await import("@/lib/media.server");
            const results: Record<string, string> = {};
            const cases = [
              {
                kind: "image" as const,
                url: `${base}/sample-image.png`,
                caption: "🧪 Media self-test 1/3 — image",
              },
              {
                kind: "video" as const,
                url: `${base}/sample-video.mp4`,
                caption: "🧪 Media self-test 2/3 — video",
              },
              {
                kind: "document" as const,
                url: `${base}/sample-report.pdf`,
                caption: "🧪 Media self-test 3/3 — PDF",
                filename: "sample-report.pdf",
              },
            ];
            for (const c of cases) {
              try {
                const res = (await sendMediaMessage(
                  selfChat,
                  { kind: c.kind, url: c.url, filename: c.filename ?? null, mime: null },
                  c.caption,
                )) as { message?: { id?: string } };
                results[c.kind] = res?.message?.id ? `sent ${res.message.id}` : "sent (no id)";
              } catch (e) {
                results[c.kind] = `FAILED: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
              }
            }
            const failed = Object.values(results).filter((r) => r.startsWith("FAILED"));
            // Awaited insert — fire-and-forget writes die with the request on
            // this platform (repo lesson from the cleanup marker).
            await supabase.from("bot_decisions").insert({
              trigger: "scheduled",
              stage: failed.length ? "error" : "config",
              status: failed.length ? "error" : "ok",
              summary: `${MARKER} result: ${failed.length ? `${failed.length}/3 FAILED` : "all 3 media types delivered"}`,
              data: results,
            });
            if (failed.length) {
              const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
              await raiseAdminAlert(
                supabase,
                `Media self-test: ${failed.length}/3 sends failed — ${JSON.stringify(results).slice(0, 400)}`,
              );
            }
            return { ran: true as const, results };
          });

          // One-shot revive (2026-07-28, Itamar's blog-post test): put the
          // newest failed Glidai blog-campaign post back to 'planned' so the
          // engine reruns it through the NEW article-retrieval path — real
          // article, Hebrew summary, direct link. Exactly once (marker);
          // deliberately ONE post, not all seven (newest-wins would cancel
          // the rest anyway, and a catch-up blast reads as spam).
          const blogPostRevive = await guarded("blog-post-revive", async () => {
            const MARKER = "Glidai blog revive v1";
            const { data: done } = await supabase
              .from("bot_decisions")
              .select("id")
              .eq("stage", "config")
              .like("summary", `${MARKER}%`)
              .limit(1)
              .maybeSingle();
            if (done) return { ran: false as const, reason: "already revived" };
            const { data: failedPost } = await supabase
              .from("planned_posts")
              .select("id, group_chat_id, engagement, prompt")
              .eq("status", "failed")
              .ilike("prompt", "%glidaiproperties%")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (!failedPost) return { ran: false as const, reason: "no failed glidai post found" };
            // Marker FIRST (awaited) — a wall-kill must never revive twice.
            const { error: markerErr } = await supabase.from("bot_decisions").insert({
              trigger: "scheduled",
              stage: "config",
              status: "ok",
              summary: `${MARKER}: re-planned post ${String(failedPost.id).slice(0, 8)} for the article-retrieval test`,
              data: { planned_post_id: failedPost.id, chat_id: failedPost.group_chat_id },
            });
            if (markerErr) throw new Error(`marker insert failed: ${markerErr.message}`);
            const {
              draft: _d,
              gen_attempts: _a,
              gen_lease_until: _l,
              gen_started_at: _s,
              ...engagement
            } = (failedPost.engagement ?? {}) as Record<string, unknown>;
            const now = new Date().toISOString();
            await supabase
              .from("planned_posts")
              .update({
                status: "planned",
                reasoning: null,
                engagement: engagement as never,
                created_at: now,
                scheduled_for: now,
                updated_at: now,
              })
              .eq("id", failedPost.id)
              .eq("status", "failed");
            return { ran: true as const, planned_post_id: failedPost.id };
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
          // Batched WhatsApp-admin digest (posts sent, replies, new contacts)
          // — one message per ~30min window; approvals and errors ping
          // immediately from their own paths, this covers the routine rest.
          const adminDigest = await guarded("admin-digest", async () => {
            const { sendAdminDigest } = await import("@/lib/agent/admin-notify.server");
            return sendAdminDigest(deps);
          });

          return Response.json({
            ok: true,
            claimed: run.claimed,
            results: run.results.map((r) => ({ jobId: r.jobId, action: r.outcome.action })),
            admin_digest: adminDigest,
            follow_ups: followUps,
            research_interims: researchInterims,
            dead_jobs: deadJobs,
            media_self_test: mediaSelfTest,
            groups,
            analytics,
            cleanup,
            channel,
            dedupe,
            approval_restore: approvalRestore,
            blog_post_revive: blogPostRevive,
            demo_wipe: demoWipe,
            model_pin: modelPin,
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
