// Research-promise engine. When a delivered reply says "I'll check and get
// back to you", the pipeline enqueues a research_answer job here with a hard
// 10-minute deadline. The job runs immediately (webhook fast-tick claims it
// within ~20s): web search (Tavily) + KB → one grounded strong-model answer →
// the same approval/anti-ban gates as any reply. If the answer cannot land in
// time, the contact gets an interim update instead of silence — sent by the
// watchdog sweep (fast tick + full sweep) for jobs that are stuck, backing
// off, waiting out the anti-ban min-gap, or dead.
import { isApifyConfigured, xSearch, type XSearchOutcome } from "@/lib/apify-x.server";
import { callLLM, modelCandidates } from "@/lib/llm.server";
import { mediaLabel } from "@/lib/media";
import { isTavilyConfigured, tavilySearch, type TavilySearchOutcome } from "@/lib/tavily.server";
import type { Json } from "@/integrations/supabase/types";
import { loadAgentSettings } from "./context.server";
import { logDecision } from "./decisions.server";
import { deliverReply } from "./deliver.server";
import { isChannelChatId } from "./inbound";
import { loadKnowledge } from "./kb.server";
import { loadOrCreatePerson, personPromptBlock } from "./people.server";
import { PERSONA_FALLBACK_LINE } from "./persona";
import { buildHumanizeRules, buildDateContext } from "./prompts.server";
import {
  buildResearchBlock,
  buildResearchPayload,
  buildXBlock,
  detectsResourceRequest,
  interimLineFor,
  parseResearchPayload,
  stripCitationMarkers,
  RESEARCH_INTERIM_AFTER_MS,
  RESEARCH_JOB_KIND,
  type ResearchJobPayload,
} from "./research";
import { sanitizeParts } from "./stages.server";
import { stripStructuredOutput } from "./inbound";
import type {
  AgentContext,
  AgentDeps,
  AgentSettings,
  BotJob,
  PipelineOutcome,
  Supa,
} from "./types";

// The answer draft's slice of a worker attempt. Search (≤14s budget incl.
// retry) + draft (≤25s) + pacing (≤6s) stays inside the ~60s request wall.
// 9s per attempt, not 7 — Tavily with include_images was measured slower and
// a timed-out search costs a whole retry cycle (live 2026-07-28).
const SEARCH_TIMEOUT_MS = 9_000;
const SEARCH_BUDGET_MS = 14_000;
// X/Twitter runs IN PARALLEL with Tavily, so its budget rides inside the same
// search slice of the wall — it never adds wall time, only breadth.
const X_SEARCH_TIMEOUT_MS = 10_000;
const X_SEARCH_BUDGET_MS = 11_000;
const ANSWER_TIMEOUT_MS = 15_000;
const ANSWER_BUDGET_MS = 25_000;
// Anti-ban min-gap between consecutive outbound is 3 min; deferral lands just
// past it so the retry never bounces off the same guard.
const MIN_GAP_MS = 3 * 60_000;
const MIN_GAP_DEFER_BUFFER_MS = 15_000;
const HOURLY_CAP_DEFER_MS = 2 * 60_000;
// A runnable DM reply outranks the research answer — fresher conversation
// state, and sending the research answer first would min-gap-block the reply.
const YIELD_TO_REPLY_DEFER_MS = 45_000;
// A research job this far past its deadline is stale — give up loudly rather
// than deferring forever.
const STALE_GIVE_UP_MS = 30 * 60_000;
// claim_bot_jobs locks for 3 min; a live attempt never lasts beyond ~90s, so
// an older lock means the worker was wall-killed and won't send anything.
const CLAIM_LOCK_MS = 3 * 60_000;
const MAX_LIVE_ATTEMPT_MS = 90_000;

/** Cheap language guess for paths where no intent analysis ran. */
export function guessLanguage(text: string): string {
  return /[א-ת]/.test(text) ? "he" : "en";
}

/** Loose sameness check so a re-promise of the same question replaces the old
 * job, while a promise about a NEW question leaves the old one to deliver. */
function similarQuestions(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (!na || !nb) return true;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export async function enqueueResearchJob(
  supabase: Supa,
  args: {
    chatId: string;
    conversationId: string;
    personWaId: string | null;
    question: string | null;
    language: string;
    sourceBody: string;
    promiseText: string;
    promisedAtMs: number;
  },
): Promise<string | null> {
  try {
    // Channels/broadcasts never get promises tracked — nothing should ever
    // be sent into a one-way surface (belt to the inbound/pipeline gates).
    if (isChannelChatId(args.chatId)) return null;
    const payload = buildResearchPayload({
      question: args.question,
      promisedAtMs: args.promisedAtMs,
      language: args.language,
      personWaId: args.personWaId,
      sourceBody: args.sourceBody,
      promiseText: args.promiseText,
    });
    // Insert FIRST, supersede after: the reverse order could leave the chat
    // with zero research jobs when the insert fails mid-way.
    const { data, error } = await supabase
      .from("bot_jobs")
      .insert({
        kind: RESEARCH_JOB_KIND,
        chat_id: args.chatId,
        conversation_id: args.conversationId,
        payload,
        run_after: new Date().toISOString(), // research starts immediately
      })
      .select("id")
      .single();
    if (error) {
      console.error("[research] enqueue failed", error);
      return null;
    }
    const newId = data?.id ?? null;

    // Retire only pending jobs asking (roughly) the SAME question — a
    // re-promise after a nudge. A pending job about a DIFFERENT question is a
    // separate promise the contact is still owed; it stays alive.
    const { data: pendingRows } = await supabase
      .from("bot_jobs")
      .select("id, payload")
      .eq("chat_id", args.chatId)
      .eq("kind", RESEARCH_JOB_KIND)
      .eq("status", "pending");
    const toRetire = (pendingRows ?? [])
      .filter((r) => String(r.id) !== String(newId))
      .filter((r) => {
        const p = parseResearchPayload(r.payload);
        return !p || similarQuestions(p.question, payload.question);
      })
      .map((r) => String(r.id));
    if (toRetire.length) {
      await supabase
        .from("bot_jobs")
        .update({ status: "superseded", updated_at: new Date().toISOString() })
        .in("id", toRetire)
        .eq("status", "pending");
    }
    return newId;
  } catch (e) {
    console.error("[research] enqueue failed", e);
    return null;
  }
}

type ConvRow = {
  id: string;
  whapi_chat_id: string;
  name: string | null;
  is_group: boolean;
  inbound_count: number;
  consecutive_outbound: number;
  blocked: boolean;
  last_outbound_at: string | null;
  last_outbound_body: string | null;
};

async function loadConv(supabase: Supa, conversationId: string): Promise<ConvRow | null> {
  const { data } = await supabase
    .from("conversations")
    .select(
      "id, whapi_chat_id, name, is_group, inbound_count, consecutive_outbound, blocked, last_outbound_at, last_outbound_body",
    )
    .eq("id", conversationId)
    .maybeSingle();
  return (data as ConvRow | null) ?? null;
}

function researchCtx(
  settings: AgentSettings,
  conv: ConvRow,
  payload: ResearchJobPayload,
): AgentContext {
  return {
    settings,
    conversation: conv,
    history: [],
    message: {
      chatId: conv.whapi_chat_id,
      chatName: conv.name ?? "",
      senderId: payload.person_wa_id ?? conv.whapi_chat_id,
      senderName: "",
      body: "",
      isGroup: !!conv.is_group,
      fromMe: false,
      messageId: "",
      ts: Date.now(),
      mentions: [],
      quotedId: null,
      quotedAuthor: null,
    },
  } satisfies AgentContext;
}

async function persistPayload(supabase: Supa, jobId: string, payload: ResearchJobPayload) {
  await supabase
    .from("bot_jobs")
    .update({ payload, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/** Bodies an already-sent answer could have been recorded under: the pipeline
 * sends part-by-part, the approval flow sends the parts joined, and a media
 * send mirrors as caption + "[image: …]" label in one row. */
function answerBodyCandidates(
  parts: string[],
  media?: import("@/lib/media").MediaAttachment | null,
): string[] {
  const joined = parts.join("\n\n");
  const bodies = [parts[0], joined];
  if (media) bodies.push([joined, mediaLabel(media)].filter(Boolean).join("\n"));
  return [...new Set(bodies)].filter(Boolean);
}

/**
 * Did the interim line ACTUALLY reach the conversation? The interim_sent flag
 * is written before the send, and a wall-killed request dies between flag and
 * delivery with no rollback — so flag-truth must be verified against the
 * messages table before it is allowed to suppress an interim.
 */
async function interimDelivered(
  supabase: Supa,
  conversationId: string,
  jobCreatedAt: string,
  language: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .eq("body", interimLineFor(language))
    .gt("created_at", jobCreatedAt)
    .limit(1);
  return !!data?.length;
}

type InterimSendResult = "sent" | "blocked_temporary" | "blocked_permanent" | "failed";

/**
 * Send the canned interim line under the anti-ban guard. Flag-first (so a
 * concurrent sender stands down), but the flag is ROLLED BACK when the send
 * didn't happen for a temporary reason (min-gap / hourly cap / a thrown
 * send) — otherwise one transient block would permanently consume the only
 * interim the contact will ever get.
 */
async function sendInterim(
  deps: AgentDeps,
  settings: AgentSettings,
  conv: ConvRow,
  payload: ResearchJobPayload,
  jobId: string,
  base: { conversation_id: string | null; chat_id: string; job_id: string },
): Promise<InterimSendResult> {
  const line = interimLineFor(payload.language);
  payload.interim_sent = true;
  await persistPayload(deps.supabase, jobId, payload);
  const rollBack = async () => {
    payload.interim_sent = false;
    await persistPayload(deps.supabase, jobId, payload);
  };
  try {
    const { checkOutboundAllowed } = await import("@/lib/anti-ban.server");
    const guard = await checkOutboundAllowed(deps.supabase, conv, line);
    if (!guard.ok) {
      logDecision(deps.supabase, {
        ...base,
        trigger: "research",
        stage: "research",
        status: "skip",
        summary: `Interim update blocked by the anti-ban guard: ${guard.reason}`,
        data: { code: guard.code },
      });
      if (guard.code === "min_gap" || guard.code === "hourly_cap") {
        await rollBack();
        return "blocked_temporary";
      }
      // blocked / consecutive_limit / cold_contact — guards outrank
      // never-silent; the interim stays consumed so we stop trying.
      return "blocked_permanent";
    }
    const ctx = researchCtx(settings, conv, payload);
    await deliverReply(deps.supabase, deps.whapi, ctx, [line], {
      humanPacing: deps.humanPacing,
      botName: settings.bot_name,
    });
    logDecision(deps.supabase, {
      ...base,
      trigger: "research",
      stage: "research",
      summary: "Interim update sent — the promised answer is close to the 10-minute deadline",
      data: {
        question: payload.question.slice(0, 300),
        minutes_since_promise: Math.round((Date.now() - payload.promised_at) / 60_000),
      },
    });
    return "sent";
  } catch (e) {
    console.error("[research] interim send failed", e);
    await rollBack().catch(() => {});
    return "failed";
  }
}

export async function processResearchJob(deps: AgentDeps, job: BotJob): Promise<PipelineOutcome> {
  const { supabase } = deps;
  const base = {
    job_id: job.id,
    conversation_id: job.conversation_id,
    chat_id: job.chat_id,
  };
  const payload = parseResearchPayload(job.payload);
  if (!payload) return { action: "skipped", reason: "invalid research payload" };
  if (job.chat_id.endsWith("@simulation")) return { action: "skipped", reason: "simulation chat" };
  if (isChannelChatId(job.chat_id)) return { action: "skipped", reason: "channel chat" };

  const settings = await loadAgentSettings(supabase);
  if (!settings || !settings.enabled) return { action: "skipped", reason: "bot disabled" };
  if (settings.agent_config?.research_enabled === false) {
    return { action: "skipped", reason: "research disabled" };
  }
  if (!job.conversation_id) return { action: "skipped", reason: "no conversation" };

  // Immortality cap: deferral loops (approval never decided, guards never
  // clearing) must not keep a stale promise alive forever. Well past the
  // deadline the job gives up LOUDLY — the admin owns it from here.
  if (Date.now() > payload.deadline_at + STALE_GIVE_UP_MS) {
    if (!payload.escalated_alerted) {
      const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
      await raiseAdminAlert(
        supabase,
        `Research promise gave up ${Math.round((Date.now() - payload.promised_at) / 60_000)} minutes after the promise (chat ${job.chat_id}) — answer never sent. Question: ${payload.question.slice(0, 200)}`,
      );
    }
    logDecision(supabase, {
      ...base,
      trigger: "research",
      stage: "research",
      status: "error",
      summary: "Research promise gave up — far past the deadline with no deliverable answer",
      data: { question: payload.question.slice(0, 300), interim_sent: !!payload.interim_sent },
    });
    return { action: "skipped", reason: "gave up (stale)" };
  }

  const conv = await loadConv(supabase, job.conversation_id);
  if (!conv) return { action: "skipped", reason: "conversation no longer exists" };
  if (conv.blocked) return { action: "skipped", reason: "contact is blocked" };

  // A human already took over: a manual outbound after the promise means the
  // owner answered from the dashboard — a bot answer on top would be noise.
  const { data: manual } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", job.conversation_id)
    .eq("direction", "outbound")
    .eq("sender_id", "manual")
    .gt("created_at", job.created_at)
    .limit(1);
  if (manual?.length) {
    logDecision(supabase, {
      ...base,
      trigger: "research",
      stage: "research",
      status: "skip",
      summary: "Owner replied manually after the promise — research answer cancelled",
    });
    return { action: "skipped", reason: "owner replied manually" };
  }

  // Crash-retry dedup: a previous attempt may have sent the cached answer and
  // died before completing the job.
  if (payload.answer_parts?.length && job.attempts > 1) {
    const { data: sent } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", job.conversation_id)
      .eq("direction", "outbound")
      .in("body", answerBodyCandidates(payload.answer_parts, payload.media_attachment))
      .gt("created_at", job.created_at)
      .limit(1);
    if (sent?.length) return { action: "skipped", reason: "answer already delivered" };
  }

  // A due DM reply outranks the research answer: the reply job carries the
  // fresher conversation state, and sending the research answer first would
  // min-gap-block the reply — the pipeline would then silently drop it.
  // Yield and come back shortly after the reply has gone out.
  const { data: liveReplies } = await supabase
    .from("bot_jobs")
    .select("id, run_after")
    .eq("chat_id", job.chat_id)
    .eq("kind", "inbound_reply")
    .eq("status", "pending")
    .limit(5);
  const soon = Date.now() + 60_000;
  if ((liveReplies ?? []).some((r) => new Date(String(r.run_after)).getTime() <= soon)) {
    return {
      action: "deferred",
      reason: "yield to pending reply",
      runAfterMs: Date.now() + YIELD_TO_REPLY_DEFER_MS,
    };
  }

  let parts = payload.answer_parts?.length ? payload.answer_parts : null;
  let search: TavilySearchOutcome | null = null;
  let searchError: string | null = null;
  let xResults: XSearchOutcome | null = null;
  let xError: string | null = null;

  if (!parts) {
    // Deliberately NO inline interim here even when the attempt starts late:
    // an interim send bumps last_outbound_at, and the min-gap guard would
    // then defer the real answer by 3+ more minutes. A live attempt's best
    // move is always to finish and deliver; the watchdog covers the cases
    // where no live attempt is running.

    // A retry (or a revived job) must be CHEAP — attempt 1 already proved the
    // full-price path dies at the ~60s wall on this thread. Cached search
    // results skip the search; the draft leads with the chain-tail model
    // (fast, known to deliver) under tight budgets. Same medicine that cured
    // the posting engine's wall deaths.
    const cheapAttempt = job.attempts >= 2 || !!payload.revived;

    // --- Research: web search (Tavily) + X/Twitter (Apify) IN PARALLEL + KB.
    // X is strictly additive: it runs alongside Tavily inside the same wall
    // budget, its failure NEVER fails the attempt (Tavily-only is a fine
    // answer), and cheap retry attempts use only its cached results — a
    // scraper re-run is exactly the slow, paid work a retry must not do.
    const t = Date.now();
    const cachedTavily =
      payload.search_results &&
      (payload.search_results.answer || payload.search_results.results.length)
        ? payload.search_results
        : null;
    const cachedX = payload.x_results?.results.length ? payload.x_results : null;

    const tavilyPromise: Promise<TavilySearchOutcome | null> = cachedTavily
      ? Promise.resolve(cachedTavily)
      : isTavilyConfigured()
        ? tavilySearch(payload.question, {
            timeoutMs: cheapAttempt ? 5_000 : SEARCH_TIMEOUT_MS,
            budgetMs: cheapAttempt ? 6_000 : SEARCH_BUDGET_MS,
          })
        : Promise.reject(new Error("TAVILY_API_KEY not configured"));
    const xPromise: Promise<XSearchOutcome | null> = cachedX
      ? Promise.resolve(cachedX)
      : !cheapAttempt && isApifyConfigured()
        ? xSearch(payload.question, {
            maxItems: 10,
            timeoutMs: X_SEARCH_TIMEOUT_MS,
            budgetMs: X_SEARCH_BUDGET_MS,
          })
        : Promise.resolve(null);

    const [tavilySettled, xSettled] = await Promise.allSettled([tavilyPromise, xPromise]);
    if (tavilySettled.status === "fulfilled") {
      search = tavilySettled.value;
    } else {
      searchError = String((tavilySettled.reason as Error)?.message ?? tavilySettled.reason).slice(
        0,
        200,
      );
    }
    if (xSettled.status === "fulfilled") {
      xResults = xSettled.value;
    } else {
      // Scrapers break and stall — that is an expected, non-blocking outcome.
      xError = String((xSettled.reason as Error)?.message ?? xSettled.reason).slice(0, 200);
    }
    // Cache both immediately: a wall-kill after this line costs the retry
    // nothing — it resumes at the draft.
    if ((search && search !== cachedTavily) || (xResults && xResults !== cachedX)) {
      if (search) payload.search_results = search;
      if (xResults) payload.x_results = xResults;
      await persistPayload(supabase, job.id, payload);
    }
    const kb = await loadKnowledge(supabase, `${payload.question} ${payload.source_body}`);

    const hasMaterial =
      !!(search && (search.answer || search.results.length)) ||
      !!xResults?.results.length ||
      kb.count > 0;
    if (!hasMaterial) {
      // A transient search failure with attempts left is a retry, not an
      // escalation — a 20s Tavily blip must not burn an answerable question.
      if (searchError && isTavilyConfigured() && job.attempts < job.max_attempts) {
        throw new Error(`research search failed: ${searchError}`);
      }

      // Nothing to ground an answer in — never fake one. A human takes over
      // (alerted exactly once) and the contact gets the honest interim once
      // the min-gap allows it.
      if (!payload.escalated_alerted) {
        const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
        await raiseAdminAlert(
          supabase,
          `Research promise needs a human: no web/X results and no KB entry for "${payload.question.slice(0, 200)}" (chat ${job.chat_id}).${searchError ? ` Search error: ${searchError}` : ""}`,
        );
        payload.escalated_alerted = true;
        await persistPayload(supabase, job.id, payload);
      }
      logDecision(supabase, {
        ...base,
        trigger: "research",
        stage: "research",
        status: "skip",
        summary: `No research material found — escalated to a human (${searchError ?? "empty search + empty KB"})`,
        data: { question: payload.question.slice(0, 300), search_error: searchError },
      });

      // Sending the interim ~40s after the promise is pointless — the min-gap
      // guard deterministically blocks it. Stay alive until the interim
      // threshold (a later attempt also re-runs the search — Tavily may have
      // recovered or the KB been filled), then send it and hand off.
      const interimDueAt = payload.promised_at + RESEARCH_INTERIM_AFTER_MS;
      if (Date.now() < interimDueAt) {
        return {
          action: "deferred",
          reason: "no material yet — waiting for the interim window",
          runAfterMs: interimDueAt + 5_000,
        };
      }
      // Flag-truth verified against the messages table: a wall-killed sender
      // can leave interim_sent=true with nothing delivered.
      const interimReallySent =
        payload.interim_sent &&
        (await interimDelivered(supabase, job.conversation_id, job.created_at, payload.language));
      if (!interimReallySent) {
        const interim = await sendInterim(deps, settings, conv, payload, job.id, base);
        if (interim === "blocked_temporary" || interim === "failed") {
          return {
            action: "deferred",
            reason: `interim ${interim} — retrying`,
            runAfterMs: Date.now() + 2 * 60_000,
          };
        }
      }
      return { action: "skipped", reason: "escalated to human" };
    }

    // --- Draft the grounded answer (one strong call) ---
    const person = payload.person_wa_id
      ? await loadOrCreatePerson(supabase, payload.person_wa_id)
      : null;
    // Deliberately NOT buildGroundingRules(kb): its empty-KB variant says
    // "אסור לציין... קישורים ספציפיים", which contradicts this stage's whole
    // job — the search results ARE the verified source here, and the answer
    // must be able to carry their URLs (live complaint: promised links never
    // arrived because the model obeyed the stricter KB rule).
    const kbBlock =
      kb.count > 0
        ? `

מאגר הידע העסקי (מקור מאומת נוסף לעובדות):
${kb.block}`
        : "";
    const wantsResource =
      detectsResourceRequest(payload.question) || detectsResourceRequest(payload.source_body);
    const system =
      settings.system_prompt +
      buildHumanizeRules() +
      buildDateContext() +
      personPromptBlock(person) +
      kbBlock +
      buildResearchBlock(search) +
      buildXBlock(xResults) +
      `

משימה: קודם הבטחת ללקוח לבדוק משהו ולחזור אליו — עכשיו בדקת, וזו הודעת ההמשך עם התשובה.
- ענה ישירות ולעניין על השאלה הפתוחה, בשפה "${payload.language}", בטון טבעי של המשך שיחה ("בדקתי לגבי..."). בלי לפתוח מחדש את כל השיחה ובלי להתנצל על ההמתנה מעבר למילה אחת אם בכלל.
- עובדות אך ורק מתוצאות החיפוש או ממאגר הידע שלמעלה. אם התוצאות עונות רק חלקית — אמור מה כן ידוע ומה עדיין פתוח.
- אל תבטיח שוב "אבדוק ואחזור" — זו כבר הודעת החזרה.${
        wantsResource
          ? `
- הלקוח ביקש משאב קונקרטי (קישור/דוח/מאמר) — התשובה חייבת לכלול כתובת URL מלאה מהתוצאות למעלה.`
          : ""
      }

פורמט פלט (חובה): החזר JSON בלבד במבנה {"messages": ["הודעה 1", ...], "reasoning": "one short sentence in English"}. הודעה אחת-שתיים קצרות, כמו בוואטסאפ.`;

    const user = `ההודעה של הלקוח שפתחה את הבדיקה:
"""${payload.source_body.slice(0, 600)}"""

מה ענינו לו אז (ההבטחה):
"""${payload.promise_text.slice(0, 400)}"""

השאלה הפתוחה לבדיקה: ${payload.question}`;

    // Cheap attempts lead with the candidate-chain TAIL (flash — the model
    // that reliably drafts when the pinned strong model stalls on long
    // prompts) and a tight budget: the whole attempt must fit the wall.
    const baseOverrides = { model_strong: settings.model_strong, model_fast: settings.model_fast };
    const res = await callLLM({
      role: "strong",
      source: "agent_research_answer",
      json: true,
      overrides: cheapAttempt
        ? {
            model_strong: modelCandidates("strong", baseOverrides).at(-1) ?? null,
            model_fast: settings.model_fast,
          }
        : baseOverrides,
      timeoutMs: cheapAttempt ? 10_000 : ANSWER_TIMEOUT_MS,
      budgetMs: cheapAttempt ? 12_000 : ANSWER_BUDGET_MS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const { parseJsonLoose } = await import("@/lib/llm.server");
    let drafted: string[];
    try {
      const parsed = parseJsonLoose<{ messages?: unknown }>(res.content);
      drafted = Array.isArray(parsed.messages) ? parsed.messages.map((m) => String(m ?? "")) : [];
    } catch {
      drafted = [res.content];
    }
    // An empty draft must THROW (so the queue retries), never fall through to
    // sanitizeParts — its empty-input fallback is the persona line "לא בטוח
    // שהבנתי", which delivered as "the answer I promised" would be absurd.
    const cleaned = drafted.map((p) => stripCitationMarkers(p)).filter(Boolean);
    if (!cleaned.length) throw new Error("research answer draft had no messages");
    const { parts: personaSafe, leaked } = sanitizeParts(cleaned);
    if (leaked && personaSafe.length === 1 && personaSafe[0] === PERSONA_FALLBACK_LINE) {
      throw new Error("research answer was persona-stripped to nothing");
    }
    const { parts: safe } = stripStructuredOutput(personaSafe);
    if (!safe.length) throw new Error("research answer was empty after safety filtering");
    parts = safe.slice(0, 2);

    // Deterministic link guarantee: when the contact asked for a concrete
    // resource, a prose-only answer is a broken promise no matter how well
    // written. If the model ignored the link rule, append the best search
    // result's URL as its own closing message (WhatsApp renders a preview).
    const hasUrl = parts.some((p) => /https?:\/\//i.test(p));
    if (wantsResource && !hasUrl) {
      // Prefer a web article/report (source of record); fall back to the top
      // tweet when X was the only source that found anything.
      const top = search?.results.length
        ? [...search.results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.url
        : xResults?.results[0]?.url;
      if (top) {
        const { formatUrlForMessage } = await import("./url-display.server");
        parts = [...parts, await formatUrlForMessage(top)];
      }
    }

    logDecision(supabase, {
      ...base,
      trigger: "research",
      stage: "research",
      summary: `Research done — drafted the promised answer (${search?.results.length ?? 0} web result(s), ${xResults?.results.length ?? 0} X post(s), ${kb.count} KB item(s))`,
      data: {
        question: payload.question.slice(0, 300),
        tavily_results: search?.results.length ?? 0,
        tavily_answer: !!search?.answer,
        x_results: xResults?.results.length ?? 0,
        x_error: xError,
        kb_items: kb.count,
        search_error: searchError,
      },
      duration_ms: Date.now() - t,
    });

    // Cache the answer so a send deferral (anti-ban min-gap) never redoes the
    // research, and a crash-retry can dedup against exactly this text.
    payload.answer_parts = parts;
    await persistPayload(supabase, job.id, payload);
  }

  // --- Media-from-search: when the person asked for a real photo/video/file,
  // try to deliver the ACTUAL file the research surfaced (Tavily image
  // results, tweet media, direct file links) — downloaded, byte-validated and
  // re-hosted before it is ever attached. Runs at most once per job
  // (media_checked survives retries/deferrals); a failed lookup just means a
  // text answer, never a broken send.
  {
    const { detectsMediaRequest, collectMediaCandidates, fetchFirstUsableMedia } =
      await import("./research-media.server");
    const askText = `${payload.question} ${payload.source_body}`;
    if (!payload.media_checked && detectsMediaRequest(askText)) {
      const t = Date.now();
      try {
        const candidates = collectMediaCandidates(
          search ?? payload.search_results ?? null,
          xResults ?? payload.x_results ?? null,
        );
        const preferKind = /וידאו|וידיאו|סרטון|video|clip/i.test(askText)
          ? ("video" as const)
          : /pdf|דוח|דו"ח|מסמך|קובץ|מצגת|document|file|report/i.test(askText)
            ? ("document" as const)
            : ("image" as const);
        const stored = candidates.length
          ? await fetchFirstUsableMedia(candidates, { budgetMs: 10_000, preferKind })
          : null;
        payload.media_checked = true;
        if (stored) {
          payload.media_attachment = stored.attachment;
          payload.media_source = stored.sourceUrl;
          // The source link is part of the honest caption — appended as its
          // own closing part unless the answer already carries it, and cached
          // WITH the answer so crash-retry dedup matches what was sent.
          const { formatUrlForMessage } = await import("./url-display.server");
          const sourceLink = await formatUrlForMessage(stored.sourceUrl);
          if (!parts.some((p) => p.includes(sourceLink) || p.includes(stored.sourceUrl))) {
            parts = [...parts, sourceLink];
          }
          payload.answer_parts = parts;
        }
        await persistPayload(supabase, job.id, payload);
        logDecision(supabase, {
          ...base,
          trigger: "research",
          stage: "research",
          summary: stored
            ? `Found a real ${stored.attachment.kind} in the research results — validated and attached to the answer`
            : `Media was requested but no usable file survived validation (${candidates.length} candidate(s)) — answering with text and links only`,
          data: {
            candidates: candidates.length,
            attached: stored ? stored.attachment.kind : null,
            source_url: stored?.sourceUrl ?? null,
            storage_path: stored?.attachment.storage_path ?? null,
          },
          duration_ms: Date.now() - t,
        });
      } catch (e) {
        // Never let media plumbing kill a drafted answer.
        payload.media_checked = true;
        await persistPayload(supabase, job.id, payload).catch(() => {});
        console.warn("[research] media lookup failed:", e);
      }
    }
  }

  const joined = parts.join("\n\n");

  // Re-load the conversation before the guard: sends since this attempt
  // started (follow-ups, watchdog interim) may have bumped
  // last_outbound_at/consecutive counts, and the guard must judge the send
  // against the CURRENT state.
  const freshConv = (await loadConv(supabase, job.conversation_id)) ?? conv;
  if (freshConv.blocked) return { action: "skipped", reason: "contact is blocked" };

  // --- Approval gate mirrors the reply pipeline — but the job stays ALIVE
  // while the human decides, so the watchdog still owns the interim and the
  // stale cap still closes it out. Completing here would silently disable
  // the whole 10-minute guarantee in approval mode.
  if (settings.require_approval_all) {
    if (!payload.approval_queued) {
      const { data: adminRole } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin")
        .limit(1)
        .maybeSingle();
      if (!adminRole?.user_id) throw new Error("no approval owner for research answer");
      const { data: approvalRow, error: approvalErr } = await supabase
        .from("scheduled_approvals")
        .insert({
          user_id: adminRole.user_id,
          conversation_id: job.conversation_id,
          target_chat_id: job.chat_id,
          target_name: freshConv.name ?? job.chat_id,
          body: joined,
          source: "research",
          status: "pending",
          // A found real-media file rides on the approval — approve sends it
          // as a WhatsApp image/video/document with the text as caption.
          ...(payload.media_attachment ? { media: payload.media_attachment } : {}),
        } as never)
        .select("id")
        .single();
      // A failed insert must THROW so the queue retries in seconds — marking
      // approval_queued without a row would loop deferrals for 30+ minutes
      // with the drafted answer never reaching the approval screen.
      if (approvalErr || !approvalRow?.id) {
        throw new Error(
          `research approval insert failed: ${approvalErr?.message ?? "no row id returned"}`,
        );
      }
      payload.approval_queued = true;
      payload.approval_id = String(approvalRow.id);
      await persistPayload(supabase, job.id, payload);
      logDecision(supabase, {
        ...base,
        trigger: "research",
        stage: "queued_approval",
        summary: "Promised answer is ready — awaiting human approval",
        data: { draft: joined, question: payload.question.slice(0, 300) },
      });
    } else if (payload.approval_id) {
      const { data: approval } = await supabase
        .from("scheduled_approvals")
        .select("status")
        .eq("id", payload.approval_id)
        .maybeSingle();
      if (approval && approval.status !== "pending") {
        // Decided (approved = sent by the approve flow, or rejected) — the
        // promise is out of this engine's hands either way.
        return { action: "skipped", reason: `approval ${approval.status}` };
      }
    }
    return {
      action: "deferred",
      reason: "awaiting approval",
      runAfterMs: Date.now() + 3 * 60_000,
    };
  }

  // --- Anti-ban guard right before the send ---
  const { checkOutboundAllowed } = await import("@/lib/anti-ban.server");
  const guard = await checkOutboundAllowed(supabase, freshConv, joined);
  if (!guard.ok) {
    if (guard.code === "min_gap") {
      // The 3-min gap since the promise hasn't elapsed. The answer is cached —
      // reschedule the send for just past the gap instead of failing.
      const lastOut = freshConv.last_outbound_at
        ? new Date(freshConv.last_outbound_at).getTime()
        : Date.now();
      const runAfterMs = Math.max(
        Date.now() + 5_000,
        lastOut + MIN_GAP_MS + MIN_GAP_DEFER_BUFFER_MS,
      );
      return { action: "deferred", reason: "min_gap", runAfterMs };
    }
    if (guard.code === "hourly_cap") {
      return {
        action: "deferred",
        reason: "hourly_cap",
        runAfterMs: Date.now() + HOURLY_CAP_DEFER_MS,
      };
    }
    if (guard.code === "duplicate") {
      // Identical body already the last outbound — the answer is out there.
      return { action: "skipped", reason: "answer already delivered" };
    }
    // blocked / consecutive_limit / cold_contact: the answer cannot be sent.
    // The admin hears about it — a promised answer dying silently is exactly
    // what this engine exists to prevent.
    const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
    await raiseAdminAlert(
      supabase,
      `Promised research answer could not be sent to ${job.chat_id} (${guard.code}): ${guard.reason}`,
    );
    logDecision(supabase, {
      ...base,
      trigger: "research",
      stage: "skipped",
      status: "skip",
      summary: `Research answer blocked by the anti-ban guard: ${guard.reason}`,
      data: { code: guard.code },
    });
    return { action: "skipped", reason: guard.code };
  }

  // --- Deliver ---
  const ctx = researchCtx(settings, freshConv, payload);
  let delivery: { parts: string[]; sentMessageIds: Array<string | null> };
  if (payload.media_attachment) {
    // Found-media answer: ONE WhatsApp media message with the whole answer
    // (incl. the source link) as its caption — mirrors the reply pipeline's
    // image send, which bypasses text-only deliverReply.
    await deps.whapi.presence(job.chat_id, "typing", 3).catch(() => {});
    const { sendMediaMessage } = await import("@/lib/media.server");
    const sendRes = (await sendMediaMessage(
      job.chat_id,
      payload.media_attachment,
      joined || undefined,
    )) as { message?: { id?: string } };
    const whapiId = sendRes?.message?.id ?? null;
    await supabase.from("messages").insert({
      conversation_id: job.conversation_id,
      whapi_message_id: whapiId,
      direction: "outbound",
      sender_name: settings.bot_name || "Bot",
      sender_id: "bot",
      body: [joined, mediaLabel(payload.media_attachment)].filter(Boolean).join("\n"),
      raw: sendRes as Json,
    });
    const { recordOutbound } = await import("@/lib/anti-ban.server");
    await recordOutbound(
      supabase,
      job.conversation_id,
      joined || mediaLabel(payload.media_attachment),
    );
    delivery = {
      parts: [joined || mediaLabel(payload.media_attachment)],
      sentMessageIds: [whapiId],
    };
  } else {
    delivery = await deliverReply(supabase, deps.whapi, ctx, parts, {
      humanPacing: deps.humanPacing,
      botName: settings.bot_name,
    });
  }
  const latencyS = Math.round((Date.now() - payload.promised_at) / 1000);
  const deadlineMet = Date.now() <= payload.deadline_at;
  logDecision(supabase, {
    ...base,
    trigger: "research",
    stage: "deliver",
    summary: `Promised answer delivered ${Math.floor(latencyS / 60)}m${String(latencyS % 60).padStart(2, "0")}s after the promise${deadlineMet ? "" : " — PAST the 10-minute deadline"}`,
    data: {
      parts: delivery.parts,
      whapi_ids: delivery.sentMessageIds,
      question: payload.question.slice(0, 300),
      promise_to_answer_s: latencyS,
      deadline_met: deadlineMet,
      interim_sent: !!payload.interim_sent,
    },
  });
  return { action: "replied", parts: delivery.parts };
}

export type ResearchInterimRunResult = {
  checked: number;
  sent: number;
  results: Array<{ id: string; action: string }>;
};

/**
 * Deadline watchdog, run from the fast tick and the full sweep. Covers every
 * way a research job can be late — stuck in retry backoff, waiting out the
 * min-gap, wall-killed mid-attempt, out of attempts — and sends the interim
 * update once the threshold passes. Jobs verifiably held by a LIVE worker
 * are left alone; a lock older than any plausible attempt means the worker
 * is dead and the watchdog takes over.
 */
export async function sendOverdueResearchInterims(
  deps: AgentDeps,
  opts: { max?: number } = {},
): Promise<ResearchInterimRunResult> {
  const { supabase } = deps;
  const max = opts.max ?? 5;
  const results: ResearchInterimRunResult["results"] = [];

  const settings = await loadAgentSettings(supabase);
  if (!settings || !settings.enabled) return { checked: 0, sent: 0, results };

  // 45-min window: an interim only means something near the 10-min deadline;
  // day-old failed jobs must not occupy scan slots during an incident.
  const { data: rows, error } = await supabase
    .from("bot_jobs")
    .select("*")
    .eq("kind", RESEARCH_JOB_KIND)
    .in("status", ["pending", "processing", "failed"])
    .gte("created_at", new Date(Date.now() - 45 * 60_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    console.warn("[research] watchdog load failed:", error.message);
    return { checked: 0, sent: 0, results };
  }

  let sent = 0;
  for (const row of (rows ?? []) as BotJob[]) {
    if (sent >= max) break;
    const payload = parseResearchPayload(row.payload);
    if (!payload) continue;
    if (row.chat_id.endsWith("@simulation")) continue;
    if (isChannelChatId(row.chat_id)) continue;

    // FAILED jobs get handled ahead of the interim window: a dead job whose
    // answer never went out is revived ONCE for a cheap final attempt (cached
    // search + fast model — see processResearchJob's cheapAttempt path), so
    // wall-killed attempts don't leave the promise permanently unanswered.
    // Already-revived-and-dead-again jobs alert the admin exactly once.
    if (row.status === "failed") {
      const answerOut =
        !!payload.answer_parts?.length &&
        row.conversation_id &&
        (
          await supabase
            .from("messages")
            .select("id")
            .eq("conversation_id", row.conversation_id)
            .eq("direction", "outbound")
            .in("body", answerBodyCandidates(payload.answer_parts, payload.media_attachment))
            .gt("created_at", row.created_at)
            .limit(1)
        ).data?.length;
      if (!answerOut) {
        const withinCap = Date.now() < payload.deadline_at + STALE_GIVE_UP_MS;
        if (!payload.revived && withinCap) {
          const { data: revivedRow } = await supabase
            .from("bot_jobs")
            .update({
              status: "pending",
              attempts: 0,
              run_after: new Date().toISOString(),
              locked_until: null,
              payload: { ...payload, revived: true },
              last_error: "revived by watchdog for one cheap final attempt",
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .eq("updated_at", row.updated_at)
            .select("id");
          if (revivedRow?.length) {
            logDecision(supabase, {
              job_id: row.id,
              conversation_id: row.conversation_id,
              chat_id: row.chat_id,
              trigger: "research",
              stage: "research",
              summary:
                "Research job died out of attempts — revived once for a cheap final attempt (cached search + fast model)",
              data: { question: payload.question.slice(0, 300), attempts_spent: row.attempts },
            });
            results.push({ id: row.id, action: "revived" });
            continue;
          }
        } else if (!payload.escalated_alerted) {
          const { raiseAdminAlert } = await import("@/lib/anti-ban.server");
          await raiseAdminAlert(
            supabase,
            `Research promise is DEAD (revive spent, ${row.attempts} attempts) — a human must answer "${payload.question.slice(0, 200)}" (chat ${row.chat_id}). Interim ${payload.interim_sent ? "was" : "was NOT"} sent.`,
          );
          await supabase
            .from("bot_jobs")
            .update({
              payload: { ...payload, escalated_alerted: true },
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          payload.escalated_alerted = true;
          results.push({ id: row.id, action: "alerted" });
          // The alert update changed updated_at, so this pass's interim CAS
          // would fail anyway — the next sweep (≤20s) sends the interim.
          continue;
        }
      }
    }

    // Threshold-only gate here: the interim_sent flag is checked further
    // down AGAINST THE MESSAGES TABLE, because a wall-killed sender can leave
    // the flag true with nothing delivered.
    if (Date.now() < payload.promised_at + RESEARCH_INTERIM_AFTER_MS) continue;
    // Trust a processing lock only while the attempt could still be alive:
    // claim locks last 3 min but a real attempt never exceeds ~90s, so an
    // older lock is a wall-killed worker that will never send anything.
    if (row.status === "processing" && row.locked_until) {
      const lockRemainingMs = new Date(row.locked_until).getTime() - Date.now();
      const attemptAgeMs = CLAIM_LOCK_MS - lockRemainingMs;
      if (lockRemainingMs > 0 && attemptAgeMs < MAX_LIVE_ATTEMPT_MS) continue;
    }
    if (!row.conversation_id) continue;
    // Flag-truth check: interim_sent may be a lie from a wall-killed sender
    // that died between the flag write and the delivery. Only a real
    // messages row suppresses the interim.
    if (
      payload.interim_sent &&
      (await interimDelivered(supabase, row.conversation_id, row.created_at, payload.language))
    ) {
      continue;
    }
    // An already-delivered answer (job status just never resolved) needs no
    // interim. Matches both the part-by-part and approval-joined body shapes.
    if (payload.answer_parts?.length) {
      const { data: sentRow } = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", row.conversation_id)
        .eq("direction", "outbound")
        .in("body", answerBodyCandidates(payload.answer_parts, payload.media_attachment))
        .gt("created_at", row.created_at)
        .limit(1);
      if (sentRow?.length) continue;
    }
    // Owner took over from the dashboard — retire the job instead of texting
    // "still checking" after the human already answered.
    const { data: manual } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", row.conversation_id)
      .eq("direction", "outbound")
      .eq("sender_id", "manual")
      .gt("created_at", row.created_at)
      .limit(1);
    if (manual?.length) {
      if (row.status !== "processing") {
        await supabase
          .from("bot_jobs")
          .update({
            status: "done",
            last_error: "owner replied manually",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("updated_at", row.updated_at);
      }
      results.push({ id: row.id, action: "owner_handled" });
      continue;
    }

    // CAS the flag before sending: whoever flips payload first owns the
    // interim. run_after is pushed past our send window in the same write so
    // the claim RPC can't hand the job to a worker mid-interim.
    const bumpedRunAfter = new Date(
      Math.max(new Date(row.run_after).getTime(), Date.now() + 90_000),
    ).toISOString();
    const { data: claimed } = await supabase
      .from("bot_jobs")
      .update({
        payload: { ...payload, interim_sent: true },
        // Unconditional: harmless on processing rows, and the moment the
        // claim RPC's crash-recovery flips one back to pending the bump is
        // exactly what keeps it out of a worker's hands mid-interim.
        run_after: bumpedRunAfter,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at)
      .select("id");
    if (!claimed?.length) continue;
    payload.interim_sent = true;

    const base = { job_id: row.id, conversation_id: row.conversation_id, chat_id: row.chat_id };
    const rollBack = async () => {
      await supabase
        .from("bot_jobs")
        .update({
          payload: { ...payload, interim_sent: false },
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    };
    try {
      const conv = await loadConv(supabase, row.conversation_id);
      if (!conv || conv.blocked) {
        results.push({ id: row.id, action: "skipped" });
        continue;
      }
      const { checkOutboundAllowed } = await import("@/lib/anti-ban.server");
      const line = interimLineFor(payload.language);
      const guard = await checkOutboundAllowed(supabase, conv, line);
      if (!guard.ok) {
        logDecision(supabase, {
          ...base,
          trigger: "research",
          stage: "research",
          status: "skip",
          summary: `Watchdog interim blocked by the anti-ban guard: ${guard.reason}`,
          data: { code: guard.code },
        });
        // Temporary blocks give the flag back so the next sweep retries.
        if (guard.code === "min_gap" || guard.code === "hourly_cap") await rollBack();
        results.push({ id: row.id, action: "guard_blocked" });
        continue;
      }
      const ctx = researchCtx(settings, conv, payload);
      await deliverReply(supabase, deps.whapi, ctx, [line], {
        humanPacing: deps.humanPacing,
        botName: settings.bot_name,
      });
      logDecision(supabase, {
        ...base,
        trigger: "research",
        stage: "research",
        summary: `Interim update sent by the deadline watchdog — the promised answer is ${Math.round((Date.now() - payload.promised_at) / 60_000)} minutes old (job ${row.status})`,
        data: {
          question: payload.question.slice(0, 300),
          job_status: row.status,
          attempts: row.attempts,
        },
      });
      // (Failed-job alerting lives in the failed-handling block at the top of
      // the loop — by the time a failed job reaches this send, it was already
      // revived or alerted on an earlier sweep.)
      sent++;
      results.push({ id: row.id, action: "interim_sent" });
    } catch (e) {
      console.error("[research] watchdog interim failed", e);
      await rollBack().catch(() => {});
      results.push({ id: row.id, action: "failed" });
    }
  }
  return { checked: rows?.length ?? 0, sent, results };
}
