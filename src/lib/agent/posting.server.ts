// Autonomous posting engine + research loop for managed groups.
//
// Every sweeper tick:
//  * due schedule slots become planned_posts rows (the partial unique index on
//    slot_key claims each occurrence exactly once across isolates),
//  * planned posts are generated (draft → self-review) with the group's
//    profile, recent activity, persisted insights and the knowledge base,
//    then sent — or queued for approval when the global gate is on
//    (drainPlannedPosts exposes just this stage for faster drain-only ticks;
//    a per-post lease in engagement jsonb keeps concurrent ticks off the
//    same post),
//  * every ~6h per group the research loop refreshes insights: activity
//    stats, engagement of recent posts, and a topics read that can trigger
//    a reactive post when the profile allows it.
import { callLLM, modelCandidates } from "@/lib/llm.server";
import type { Json } from "@/integrations/supabase/types";
import { logDecision } from "./decisions.server";
import { loadKnowledge } from "./kb.server";
import { groupPromptBlock, listEnabledGroupProfiles, type GroupProfile } from "./groups.server";
import { parseJsonLoose } from "@/lib/llm.server";
import { approvalMatchesPost } from "./approval-match";
import { computeDueSlots } from "./posting-schedule";
import { buildHumanizeRules, buildDateContext } from "./prompts.server";
import { sanitizeParts } from "./stages.server";
import type { AgentDeps, AgentSettings } from "./types";
import { loadAgentSettings } from "./context.server";

const INSIGHTS_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_POSTS_PER_TICK = 2;
const REACTIVE_MIN_GAP_MS = 12 * 60 * 60 * 1000;
// Two attempts, not four: the target is planned → terminal within about a
// minute, and at the new ~20s drain cadence two attempts land there while
// still giving a second model a turn (the final attempt jumps straight to
// the known-good tail of the chain — see draftModelForAttempt).
export const MAX_GEN_ATTEMPTS = 2;
// One post's generation must finish well inside a single Worker invocation:
// the runtime kills a request after roughly a minute of wall clock, and a
// kill mid-LLM-call skips the catch below so the post sits 'planned' with no
// trace (live 2026-07-24). Budgets are sized so claim + draft (40s budget,
// clamped per-attempt by llm.server) + review (15s, skipped entirely when
// drafting ate the margin — see REVIEW_SKIP_AFTER_MS) + send fit inside the
// wall, and a drafted post is persisted the moment it exists so a killed
// request never loses the work.
const DRAFT_TIMEOUT_MS = 30_000;
const DRAFT_BUDGET_MS = 40_000;
const REVIEW_TIMEOUT_MS = 15_000;
const REVIEW_BUDGET_MS = 15_000;
// Generation lease: while a claim is younger than this, other ticks leave
// the post alone (overlapping drains used to double-send). Longer than the
// worst-case claim→send (~55s) so a live worker is never raced, short enough
// that a killed isolate delays the retry by only ~one extra tick cycle.
export const GEN_LEASE_MS = 90_000;
// Self-review is skipped when drafting already burned this much of the wall
// budget — a second LLM roundtrip would outlive the request, and an
// unreviewed post beats a dead isolate (the sanitize gate still runs).
const REVIEW_SKIP_AFTER_MS = 20_000;

/**
 * Which model should lead this generation attempt. Attempt 1 keeps the
 * configured chain order; the FINAL allowed attempt jumps straight to the
 * LAST element of the chain — the known-good fast fallback — so the cap can
 * never expire without the reliable model getting a turn (live 2026-07-24: a
 * post only drafted once rotation finally reached flash, the tail candidate,
 * on its 4th attempt). Any attempts in between rotate through the remaining
 * candidates so a degraded first model cannot consume the whole cap.
 */
export function draftModelForAttempt(attempts: number, chain: string[]): string | null {
  if (attempts <= 1 || chain.length < 2) return null;
  if (attempts >= MAX_GEN_ATTEMPTS) return chain[chain.length - 1];
  return chain[(attempts - 1) % chain.length];
}

/** Draft persisted by an earlier attempt whose request died before sending. */
export function readStoredDraft(
  engagement: Record<string, unknown>,
): { post: string; poll: unknown } | null {
  const d = engagement.draft;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const post = String((d as Record<string, unknown>).post ?? "").trim();
  const poll = (d as Record<string, unknown>).poll ?? null;
  if (!post && !poll) return null;
  return { post, poll };
}

/**
 * Attempt accounting for post generation. The counter lives in the post's
 * engagement jsonb (reused post-send for reply stats) and is persisted BEFORE
 * drafting, so a request that dies mid-flight still counts toward the cap and
 * repeated failures converge to a visible 'failed' instead of retrying forever.
 */
export function nextGenAttempt(
  engagement: unknown,
  lastReasoning: string | null | undefined,
): {
  exceeded: boolean;
  attempts: number;
  /** Normalized engagement as read, un-bumped — the cap-bypass claim writes this. */
  prior: Record<string, unknown>;
  engagement: Record<string, unknown>;
  failReasoning: string;
} {
  const prior =
    engagement && typeof engagement === "object" && !Array.isArray(engagement)
      ? (engagement as Record<string, unknown>)
      : {};
  const attempts = Number(prior.gen_attempts ?? 0) + 1;
  // "unknown error" told the operator nothing. When the last attempt died
  // without persisting reasoning (the runtime killed the request mid-call),
  // the claim's lease fields still say what ran and when — surface those.
  const lastModel = typeof prior.gen_last_model === "string" ? prior.gen_last_model : null;
  const lastStart = typeof prior.gen_started_at === "string" ? prior.gen_started_at : null;
  const lastTrace =
    lastModel || lastStart
      ? `attempt ${attempts - 1} (model ${lastModel ?? "unknown"}) started at ${lastStart ?? "unknown"} and never completed — the request was likely killed`
      : "unknown error";
  return {
    exceeded: attempts > MAX_GEN_ATTEMPTS,
    attempts,
    prior,
    engagement: { ...prior, gen_attempts: attempts },
    failReasoning: `Generation failed after ${MAX_GEN_ATTEMPTS} attempts: ${lastReasoning || lastTrace}`,
  };
}

/**
 * True while a worker's generation lease on this post is still live. The
 * lease lives in the engagement jsonb (gen_lease_until, ISO instant) because
 * planned_posts has no lock columns — it rides the same conditional claim
 * write as the attempt counter, so claim + lease are a single atomic update.
 */
export function leaseActive(engagement: unknown, now: number): boolean {
  if (!engagement || typeof engagement !== "object" || Array.isArray(engagement)) return false;
  const until = (engagement as Record<string, unknown>).gen_lease_until;
  if (typeof until !== "string") return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

/**
 * Engagement with the generation lease stripped (gen_attempts and
 * gen_last_model stay for the record). EVERY write that ends this worker's
 * ownership — sent, failed, queued_approval, and the caught-failure persist —
 * goes through this, so a finished or crashed attempt never leaves a live
 * lease that would stall the next tick's retry.
 */
export function releaseLease(engagement: Record<string, unknown>): Record<string, unknown> {
  const { gen_lease_until: _lease, gen_started_at: _started, ...rest } = engagement;
  return rest;
}

/**
 * Errors the next sweeper tick can plausibly succeed on — LLM timeouts and
 * gateway 429/5xx (error shapes from llm.server). Anything else (bad prompt
 * output, missing approval owner, out of credits) won't fix itself, so the
 * post is failed immediately rather than burning the remaining attempts.
 * Deliberately NOT matched: Whapi send failures ("The connection to WhatsApp
 * took too long…") — a send timeout doesn't prove the message wasn't
 * delivered, and a retry would regenerate AND resend, risking a double post
 * in the group. Those fail visibly and a human re-plans.
 */
export function isTransientGenError(message: string): boolean {
  return /timed out/i.test(message) || /\bAI error (?:429|5\d\d)\b/i.test(message);
}

export type PostingRunResult = {
  planned: number;
  posted: Array<{ group: string; status: string }>;
  insightsRefreshed: string[];
};

export async function runGroupEngine(deps: AgentDeps): Promise<PostingRunResult> {
  const result: PostingRunResult = { planned: 0, posted: [], insightsRefreshed: [] };
  const settings = await loadAgentSettings(deps.supabase);
  if (!settings?.enabled) return result;

  await reconcileDecidedApprovals(deps);

  const profiles = await listEnabledGroupProfiles(deps.supabase);
  if (!profiles.length) return result;

  // 1) Claim due schedule slots.
  const now = new Date();
  const { channelStamp } = await import("./channel.server");
  const stamp = await channelStamp(deps.supabase);
  for (const profile of profiles) {
    for (const due of computeDueSlots(profile.posting_schedule, now)) {
      const { error } = await deps.supabase.from("planned_posts").insert({
        group_chat_id: profile.chat_id,
        ...stamp,
        source: "schedule",
        slot_key: due.slotKey,
        pillar: due.slot.pillar ?? null,
        prompt: due.slot.prompt ?? null,
        scheduled_for: now.toISOString(),
      });
      if (!error) result.planned += 1;
      else if (error.code !== "23505") console.warn("[posting] slot claim failed:", error.message);
    }
  }

  // 2) Generate + send planned posts (shared with faster drain-only ticks;
  // it reloads settings/profiles itself — the price of one code path).
  result.posted = await drainPlannedPosts(deps);

  // 3) Research loop.
  for (const profile of profiles) {
    const refreshed = await maybeRefreshInsights(deps, settings, profile);
    if (refreshed) result.insightsRefreshed.push(profile.name ?? profile.chat_id);
  }
  return result;
}

/**
 * Generate + send planned posts (oldest first, capped per call) — ONLY the
 * supersede-cancel pass and the generate/send loop, no slot claiming, no
 * approval reconcile, no insights. Safe to call from any tick, however
 * frequent: per-post ownership is enforced by the generation lease and the
 * conditional claim write inside generateAndSendPost, so overlapping drains
 * cannot double-generate or double-send the same post.
 */
export async function drainPlannedPosts(
  deps: AgentDeps,
  opts?: { max?: number },
): Promise<Array<{ group: string; status: string }>> {
  const settings = await loadAgentSettings(deps.supabase);
  if (!settings?.enabled) return [];
  // ALL profiles, not just enabled ones: a manager-requested campaign post
  // sends regardless of the group's autonomy toggle (live 2026-07-28: seven
  // Glidai campaign posts were failed "profile disabled or missing" because
  // the group's Autonomous-management toggle was off — but the manager had
  // explicitly asked for those posts). null = the profile QUERY failed; do
  // nothing this tick rather than mis-fail every post over a transient blip.
  const { listAllGroupProfiles, fallbackGroupProfile } = await import("./groups.server");
  const profiles = await listAllGroupProfiles(deps.supabase);
  if (profiles === null) return [];
  const posted: Array<{ group: string; status: string }> = [];

  // A backlog can pile up while generation is broken (schedule slots keep
  // claiming). Sending several catch-up posts back-to-back would read as spam
  // in a real group — so, mirroring the DM queue's supersede rule, the NEWEST
  // planned slot per group owns the catch-up and older unsent ones cancel.
  // Groups with a LIVE generation lease are left entirely alone this tick:
  // cancelling a row another worker is mid-way through sending would let the
  // send land on a 'cancelled' row (and a second post could start for the
  // same group while the first is still in flight).
  const { data: allPlanned } = await deps.supabase
    .from("planned_posts")
    .select("id, group_chat_id, created_at, engagement")
    .eq("status", "planned")
    .order("created_at", { ascending: false });
  const nowMs = Date.now();
  const leasedGroups = new Set<string>();
  for (const p of allPlanned ?? []) {
    if (leaseActive(p.engagement, nowMs)) leasedGroups.add(p.group_chat_id);
  }
  const newestPerGroup = new Set<string>();
  const staleIds: string[] = [];
  for (const p of allPlanned ?? []) {
    if (leasedGroups.has(p.group_chat_id)) continue;
    if (newestPerGroup.has(p.group_chat_id)) staleIds.push(p.id);
    else newestPerGroup.add(p.group_chat_id);
  }
  if (staleIds.length) {
    const { error: staleErr } = await deps.supabase
      .from("planned_posts")
      .update({
        status: "cancelled",
        reasoning: "Superseded — a newer scheduled slot was planned before this one could send",
        updated_at: new Date().toISOString(),
      })
      .in("id", staleIds)
      .eq("status", "planned");
    if (!staleErr) {
      logDecision(deps.supabase, {
        trigger: "scheduled",
        stage: "config",
        status: "ok",
        summary: `Cancelled ${staleIds.length} stale planned post(s) superseded by newer slots`,
        data: { cancelled_planned_posts: staleIds.length },
      });
    }
  }

  // updated_at is the claim's compare-and-swap token: generateAndSendPost
  // only takes ownership if the row is exactly as read here.
  const { data: pending } = await deps.supabase
    .from("planned_posts")
    .select("id, group_chat_id, source, pillar, prompt, engagement, reasoning, updated_at")
    .eq("status", "planned")
    .order("created_at", { ascending: true })
    .limit(opts?.max ?? MAX_POSTS_PER_TICK);
  for (const post of pending ?? []) {
    // One in-flight generation per group: while any of the group's posts is
    // leased, its other posts wait for the next tick.
    if (leasedGroups.has(post.group_chat_id)) {
      posted.push({ group: post.group_chat_id, status: "leased" });
      continue;
    }
    const stored = profiles.find((p) => p.chat_id === post.group_chat_id) ?? null;
    // A CAMPAIGN post is an explicit manager request ("post X to group Y") —
    // it sends even when the group's autonomy toggle is off or the group was
    // never taught (a minimal stand-in profile carries it; approval falls
    // back to the global setting). Only AUTONOMOUS posts (schedule slots,
    // reactive) require the enabled profile — running a group on its own is
    // exactly what that toggle governs.
    const isCampaign = post.source === "campaign";
    const profile = stored ?? (isCampaign ? fallbackGroupProfile(post.group_chat_id) : null);
    if (!profile || (!profile.enabled && !isCampaign)) {
      // Skipping silently would leave the row 'planned' forever (shown as
      // "generating" on the dashboard) — fail it visibly, and say exactly
      // which switch to flip.
      const reason = stored
        ? `Autonomous posting is OFF for this group — scheduled/reactive posts only send when "Autonomous management" is on. Turn it on in Command Center → this group (the toggle now saves immediately) and press Retry.`
        : `This group has no profile yet — scheduled/reactive posts need one. Open the group in Command Center, turn on "Autonomous management", then press Retry.`;
      await deps.supabase
        .from("planned_posts")
        .update({
          status: "failed",
          reasoning: reason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      logDecision(deps.supabase, {
        chat_id: post.group_chat_id,
        trigger: "scheduled",
        stage: "error",
        status: "error",
        summary: `Planned ${post.source} post failed: group ${post.group_chat_id} ${stored ? "has autonomous posting off" : "has no profile"}`,
        data: { planned_post_id: post.id },
      });
      posted.push({ group: post.group_chat_id, status: "failed" });
      continue;
    }
    const status = await generateAndSendPost(deps, settings, profile, post);
    posted.push({ group: profile.name ?? profile.chat_id, status });
  }
  return posted;
}

/**
 * Posts stuck in queued_approval whose approval was already decided — either
 * rows from before approvePending updated planned_posts, or a decide whose
 * post update failed mid-flight. Flip them to sent/cancelled so the dashboard
 * panels match reality. Matches by planned_post_id when the link column
 * exists, else by same group + body containment; an approval older than the
 * post can never be its approval, and posts with a still-pending approval are
 * left for the approve flow.
 */
async function reconcileDecidedApprovals(deps: AgentDeps): Promise<void> {
  const { data: queued } = await deps.supabase
    .from("planned_posts")
    .select("id, group_chat_id, body, created_at")
    .eq("status", "queued_approval");
  if (!queued?.length) return;

  const { data: approvals } = await deps.supabase
    .from("scheduled_approvals")
    .select("*")
    .eq("source", "group_post")
    .in("status", ["pending", "approved", "rejected"]);
  if (!approvals?.length) return;

  for (const post of queued) {
    if (approvals.some((a) => a.status === "pending" && approvalMatchesPost(a, post))) continue;
    const decided = approvals
      .filter((a) => a.status !== "pending" && approvalMatchesPost(a, post))
      .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))[0];
    if (!decided) continue;
    const { error: healErr } = await deps.supabase
      .from("planned_posts")
      .update(
        decided.status === "approved"
          ? {
              status: "sent",
              sent_at: decided.decided_at ?? new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : { status: "cancelled", updated_at: new Date().toISOString() },
      )
      .eq("id", post.id)
      .eq("status", "queued_approval");
    // Sent posts must always leave a 'post' decision — the Activity page's
    // Posts count is built from these rows.
    if (!healErr && decided.status === "approved") {
      logDecision(deps.supabase, {
        chat_id: post.group_chat_id,
        trigger: "scheduled",
        stage: "post",
        summary: `Approved post published in ${decided.target_name ?? post.group_chat_id} (recovered by the sweeper)`,
        data: { planned_post_id: post.id, post: (post.body ?? "").slice(0, 500) },
      });
    }
  }
}

async function recentGroupActivity(deps: AgentDeps, chatId: string, limit = 30): Promise<string> {
  const { data: conv } = await deps.supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", chatId)
    .maybeSingle();
  if (!conv) return "";
  const { data: msgs } = await deps.supabase
    .from("messages")
    .select("direction, sender_name, body, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (msgs ?? [])
    .reverse()
    .filter((m) => m.body)
    .map(
      (m) =>
        `${m.direction === "outbound" ? "אנחנו" : m.sender_name || "חבר"}: ${String(m.body).slice(0, 200)}`,
    )
    .join("\n");
}

async function latestInsights(deps: AgentDeps, chatId: string): Promise<string> {
  const { data } = await deps.supabase
    .from("group_insights")
    .select("kind, content")
    .eq("group_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(3);
  return (data ?? []).map((i) => `[${i.kind}] ${i.content}`).join("\n");
}

async function recentPostBodies(deps: AgentDeps, chatId: string): Promise<string[]> {
  const { data } = await deps.supabase
    .from("planned_posts")
    .select("body")
    .eq("group_chat_id", chatId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(5);
  return (data ?? []).map((p) => String(p.body ?? "")).filter(Boolean);
}

/**
 * Anything near-identical delivered to this chat in the last hour — sent
 * planned_posts plus the conversation's outbound mirror (which also catches
 * sends whose post row was lost). Returns where/when the match was found.
 */
export async function findRecentNearDuplicate(
  supabase: AgentDeps["supabase"],
  chatId: string,
  candidateBody: string,
): Promise<{ at: string; source: string } | null> {
  if (!candidateBody.trim()) return null;
  const { isNearDuplicateText } = await import("./dedupe");
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: sentPosts } = await supabase
    .from("planned_posts")
    .select("body, sent_at")
    .eq("group_chat_id", chatId)
    .eq("status", "sent")
    .gte("sent_at", hourAgo)
    .limit(30);
  for (const p of sentPosts ?? []) {
    if (p.body && isNearDuplicateText(candidateBody, String(p.body))) {
      return { at: String(p.sent_at ?? ""), source: "sent post" };
    }
  }
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", chatId)
    .maybeSingle();
  if (conv) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("body, created_at")
      .eq("conversation_id", conv.id)
      .eq("direction", "outbound")
      .gte("created_at", hourAgo)
      .limit(30);
    for (const m of msgs ?? []) {
      if (m.body && isNearDuplicateText(candidateBody, String(m.body))) {
        return { at: String(m.created_at ?? ""), source: "outbound message" };
      }
    }
  }
  return null;
}

async function generateAndSendPost(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile,
  post: {
    id: string;
    source: string;
    pillar: string | null;
    prompt: string | null;
    engagement?: Json | null;
    reasoning?: string | null;
    updated_at: string;
  },
): Promise<string> {
  const { supabase } = deps;
  const overrides = { model_strong: settings.model_strong, model_fast: settings.model_fast };

  // Another worker owns this post: two drains overlapping around a tick
  // boundary used to both pick up the same 'planned' row and double-send.
  if (leaseActive(post.engagement, Date.now())) return "leased";

  // Count this attempt before any LLM work — a generation killed mid-flight
  // must still leave a trace so the cap can converge to a visible 'failed'.
  const attempt = nextGenAttempt(post.engagement, post.reasoning);
  // A draft from an earlier attempt whose request died before sending.
  const storedDraft = readStoredDraft(attempt.prior);
  // The cap budgets LLM WORK; sending an already-finished draft costs none —
  // so a stored draft always proceeds to the send path, even over the cap
  // (live 2026-07-24: a persisted draft was failed at the cap unsent).
  if (attempt.exceeded && !storedDraft) {
    await supabase
      .from("planned_posts")
      .update({
        status: "failed",
        reasoning: attempt.failReasoning,
        // Terminal writes never leave lease fields behind.
        engagement: releaseLease(attempt.prior) as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id);
    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "error",
      status: "error",
      summary: `Post generation for ${profile.name ?? profile.chat_id} gave up after ${MAX_GEN_ATTEMPTS} attempts`,
      data: { planned_post_id: post.id },
    });
    return "failed";
  }

  // Later attempts lead with a different candidate model — a degraded first
  // model must not consume the whole attempt cap.
  const chain = modelCandidates("strong", overrides);
  const rotated = draftModelForAttempt(attempt.attempts, chain);

  // CLAIM: persist the attempt count + lease, conditional on the row being
  // exactly as the drain read it. Errors or 0 rows mean another worker
  // claimed first (or the row moved on) — walk away before any LLM work or
  // send. On the cap-bypass path gen_attempts stays unchanged: no LLM runs,
  // but the lease must still stop a second tick from re-sending the draft.
  const claimedAtMs = Date.now();
  let owned: Record<string, unknown> = {
    ...(attempt.exceeded ? attempt.prior : attempt.engagement),
    gen_lease_until: new Date(claimedAtMs + GEN_LEASE_MS).toISOString(),
    gen_last_model: rotated ?? chain[0],
    gen_started_at: new Date(claimedAtMs).toISOString(),
  };
  const { data: claimed, error: claimErr } = await supabase
    .from("planned_posts")
    .update({ engagement: owned as Json, updated_at: new Date().toISOString() })
    .eq("id", post.id)
    .eq("status", "planned")
    .eq("updated_at", post.updated_at)
    .select("id");
  if (claimErr || !claimed?.length) return "lost_claim";

  // IDEMPOTENT SENDS: a previous attempt persisted this marker immediately
  // before its WhatsApp send and then died before recording (a wall-kill has
  // no catch path). The message very likely reached the group — live
  // 2026-07-28: the Bluewaters post went out 13:32 unrecorded and the retry
  // re-sent a near-identical draft at 13:33. NEVER send again: record the
  // row as sent (flagged unconfirmed) and stop.
  const priorSend = attempt.prior as { send_started_at?: string; send_body?: string };
  if (priorSend.send_started_at) {
    const { draft: _recoveredDraft, ...recoveredEngagement } = releaseLease(owned);
    await supabase
      .from("planned_posts")
      .update({
        body: priorSend.send_body || storedDraft?.post || post.prompt || "",
        status: "sent",
        sent_at: priorSend.send_started_at,
        reasoning:
          "Recovered: a previous attempt reached the WhatsApp send and died before recording — marked sent WITHOUT resending (delivery unconfirmed; check the chat)",
        engagement: recoveredEngagement as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id);
    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "post",
      status: "ok",
      summary: `Recovered an unrecorded send in ${profile.name ?? profile.chat_id} — marked sent without resending (idempotency marker from ${priorSend.send_started_at})`,
      data: { planned_post_id: post.id, send_started_at: priorSend.send_started_at },
    });
    return "recovered_sent";
  }

  try {
    const { normalizePoll, pollCount, pollAsHistoryText } = await import("./poll");
    let final = "";
    let poll: import("./poll").PollSpec | null = null;
    let reviewNote = "";

    // Reuse the stored draft and skip the LLM work (an unreviewed draft
    // beats another roundtrip on a wall budget that already ran out once).
    if (storedDraft) {
      final = storedDraft.post;
      poll = normalizePoll(storedDraft.poll);
      reviewNote = "recovered draft from an interrupted attempt";
    }

    // --- ARTICLE MODE: the prompt references a site URL → the post MUST be
    // grounded in ONE real article from there (discover → rotate past
    // already-posted URLs → fetch + extract the text). HARD RULE: retrieval
    // failure fails the post VISIBLY — a generic "safe" post about the blog
    // is exactly the bug this exists to kill (live 2026-07-28, Glidai).
    const { extractSourceUrl } = await import("./article-source.server");
    const sourceUrl = extractSourceUrl(post.prompt);
    let article: { url: string; title: string | null; text: string } | null = null;
    if (sourceUrl && !storedDraft) {
      // A previous attempt's pick survives the retry (wall-kill safe).
      const cachedArticle = (
        attempt.prior as { article?: { url?: string; title?: string | null; text?: string } }
      ).article;
      if (cachedArticle?.url && cachedArticle.text) {
        article = {
          url: String(cachedArticle.url),
          title: cachedArticle.title ?? null,
          text: String(cachedArticle.text),
        };
      } else {
        try {
          const { pickFreshArticle } = await import("./article-source.server");
          const picked = await pickFreshArticle(supabase, profile.chat_id, sourceUrl);
          article = { url: picked.url, title: picked.title, text: picked.text };
          logDecision(supabase, {
            chat_id: profile.chat_id,
            trigger: "scheduled",
            stage: "post",
            status: "ok",
            summary: `Article picked for the post: "${(picked.title ?? picked.url).slice(0, 120)}" (${picked.discovered} discovered, unused ones rotated)`,
            data: { planned_post_id: post.id, article_url: picked.url },
          });
          // Persist the pick + text NOW (rides on the live lease): a killed
          // request must not re-pick a different article on retry.
          owned = {
            ...owned,
            article: { url: article.url, title: article.title, text: article.text.slice(0, 6000) },
          };
          await supabase
            .from("planned_posts")
            .update({ engagement: owned as Json, updated_at: new Date().toISOString() })
            .eq("id", post.id);
        } catch (e) {
          const reason = String((e as Error)?.message ?? e).slice(0, 400);
          await supabase
            .from("planned_posts")
            .update({
              status: "failed",
              reasoning: `Article retrieval failed — NO post was sent (hard rule: no specific article, no post). ${reason}`,
              engagement: releaseLease(owned) as Json,
              updated_at: new Date().toISOString(),
            })
            .eq("id", post.id);
          logDecision(supabase, {
            chat_id: profile.chat_id,
            trigger: "scheduled",
            stage: "error",
            status: "error",
            summary: `Blog-article post skipped for ${profile.name ?? profile.chat_id}: ${reason}`,
            data: { planned_post_id: post.id, source_url: sourceUrl },
          });
          return "failed";
        }
      }
    }
    // The link humans SEE: decoded Hebrew (never a %D7%… wall), shortened when
    // even the decoded form is long. engagement.article.url keeps the raw URL
    // so rotation dedupe (urlKey) is unaffected.
    let articleLink: string | null = null;
    if (article) {
      const { formatUrlForMessage } = await import("./url-display.server");
      articleLink = await formatUrlForMessage(article.url);
    }
    const articleBlock = article
      ? `

המאמר שנבחר לפוסט הזה (חובה לבסס את הפוסט אך ורק עליו):
כותרת: ${article.title ?? "(ללא כותרת)"}
קישור: ${articleLink}
תוכן המאמר:
"""${article.text.slice(0, 5000)}"""

חוקי פוסט-מאמר (מחייבים, גוברים על כל הנחיה כללית):
- כתוב תקציר קצר בעברית (2-4 משפטים) של המאמר הזה בלבד — רק עובדות שמופיעות בתוכן למעלה.
- חובה לכלול בפוסט את הקישור המדויק ${articleLink} — מועתק אות באות, בלי לשנות אותו.
- אסור פוסט כללי על הבלוג או על הנושא — הפוסט הוא על המאמר הספציפי הזה.`
      : "";

    const { latestRecommendationsBlock } = await import("./analytics.server");
    const [activity, insights, pastPosts, kb, memoBlock] = await Promise.all([
      recentGroupActivity(deps, profile.chat_id),
      latestInsights(deps, profile.chat_id),
      recentPostBodies(deps, profile.chat_id),
      loadKnowledge(supabase, `${post.pillar ?? ""} ${post.prompt ?? ""} ${profile.purpose ?? ""}`),
      latestRecommendationsBlock(supabase, profile.chat_id),
    ]);

    // Draft.
    const draftSystem =
      (settings.system_prompt || "") +
      buildHumanizeRules() +
      buildDateContext() +
      groupPromptBlock(profile) +
      memoBlock +
      (kb.count ? `\n\nמאגר ידע מאומת (עובדות עסקיות מותרות רק מכאן):\n${kb.block}` : "") +
      articleBlock +
      `

משימה: כתוב פוסט אחד לקבוצה, בשפה ${profile.language}.
${post.pillar ? `- עמוד תוכן: ${post.pillar}` : ""}
${post.prompt ? `- הנחיה לפוסט: ${post.prompt}` : ""}
- מטרת הפוסט: להניע שיחה אמיתית בקבוצה, לא "תוכן שיווקי".
- אורך וואטסאפ טבעי: 2-5 משפטים. מותר אימוג'י אחד-שניים. בלי כותרות מודגשות מוגזמות.
- אל תחזור על פוסטים קודמים.

פורמט פלט (חובה): החזר JSON בלבד:
{"post": "טקסט הפוסט (או מחרוזת ריקה אם הכל בסקר)", "poll": {"question": "שאלת הסקר", "options": ["אפשרות", ...], "multi": false} או null}

חוקי סקר (קריטי):
- כלול poll רק אם ההנחיה לפוסט / הוראות המנהל מבקשות סקר או הצבעה. אחרת poll=null.
- סקר נשלח כסקר וואטסאפ אמיתי (לחיץ) — לעולם אל תכתוב את הסקר או את האפשרויות בתוך טקסט הפוסט, בלי 1️⃣2️⃣3️⃣ ובלי רשימות ממוספרות של אפשרויות.
- 2 עד 12 אפשרויות, קצרות וייחודיות, בשפת הקבוצה. multi=true רק אם הגיוני לבחור כמה תשובות.`;

    const draftUser = `פעילות אחרונה בקבוצה:
${activity || "(שקט בקבוצה)"}

תובנות שמורות:
${insights || "(אין עדיין)"}

פוסטים אחרונים שכבר פורסמו (אל תחזור עליהם):
${pastPosts.map((p, i) => `[${i + 1}] ${p.slice(0, 150)}`).join("\n") || "(אין)"}`;

    const draft = storedDraft
      ? null
      : await callLLM({
          role: "strong",
          source: "agent_post_draft",
          overrides: rotated ? { ...overrides, model_strong: rotated } : overrides,
          timeoutMs: DRAFT_TIMEOUT_MS,
          budgetMs: DRAFT_BUDGET_MS,
          messages: [
            { role: "system", content: draftSystem },
            { role: "user", content: draftUser },
          ],
        });

    if (draft) {
      // Parse the structured draft ({post, poll}); tolerate plain-text output.
      try {
        const parsedDraft = parseJsonLoose<{ post?: unknown; poll?: unknown }>(draft.content);
        final = String(parsedDraft.post ?? "").trim();
        poll = normalizePoll(parsedDraft.poll);
      } catch {
        final = draft.content.trim();
      }
      // Persist the draft the moment it exists — if this request dies in the
      // review or send below, the next tick sends it instead of re-drafting.
      // Built on `owned` so the live lease rides along: dropping it here
      // would hand the post back to a concurrent drain mid-generation.
      owned = { ...owned, draft: { post: final, poll } };
      await supabase
        .from("planned_posts")
        .update({
          engagement: owned as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", post.id);
    }

    // Self-review — skipped for recovered drafts, and skipped when drafting
    // already ate the review's share of the wall budget: a slow draft leaves
    // no time for a second roundtrip before the runtime kills the request,
    // and an unreviewed post beats a dead isolate. Sanitize still runs below.
    if (!storedDraft && Date.now() - claimedAtMs < REVIEW_SKIP_AFTER_MS)
      try {
        const review = await callLLM({
          role: "strong",
          source: "agent_post_review",
          json: true,
          overrides,
          timeoutMs: REVIEW_TIMEOUT_MS,
          budgetMs: REVIEW_BUDGET_MS,
          messages: [
            {
              role: "system",
              content: `אתה עורך תוכן קפדן. בדוק את הפוסט והחזר JSON בלבד: {"ok": true/false, "post": "הגרסה הסופית של הטקסט", "poll": {"question": "...", "options": [...], "multi": false} או null, "note": "what was fixed, in English — or empty"}.
בדוק: מתאים למטרת הקבוצה ולטון (${profile.tone ?? "מקצועי-חם"}), בשפה ${profile.language}, לא חוזר על פוסטים קודמים, בלי עובדות עסקיות שאינן במאגר הידע, בלי רמז לבוט/AI, אורך וואטסאפ סביר.
כלל סקרים: אם יש poll — הטקסט אסור שיכיל את שאלת הסקר או את האפשרויות (בלי 1️⃣2️⃣3️⃣ ובלי רשימות אפשרויות בטקסט); הסקר נשלח בנפרד כסקר לחיץ. אם הטקסט מכיל סקר-בטקסט — העבר אותו לשדה poll ונקה את הטקסט. שמור על ה-poll אם הוא תקין. תקן בעצמך אם צריך.`,
            },
            {
              role: "user",
              content: `הפוסט:\n"""${final}"""\n\nסקר מצורף:\n${poll ? JSON.stringify(poll) : "(אין)"}\n\nפוסטים קודמים:\n${pastPosts.map((p) => p.slice(0, 120)).join("\n") || "(אין)"}${kb.count ? `\n\nמאגר הידע:\n${kb.block}` : ""}`,
            },
          ],
        });
        const parsed = parseJsonLoose<{
          ok?: boolean;
          post?: unknown;
          poll?: unknown;
          note?: string;
        }>(review.content);
        if (parsed.post !== undefined) final = String(parsed.post ?? "").trim();
        if (parsed.poll !== undefined) poll = normalizePoll(parsed.poll) ?? poll;
        reviewNote = String(parsed.note ?? "");
      } catch (e) {
        console.warn("[posting] review failed, using draft:", e);
      }
    final = sanitizeParts([final]).parts[0] ?? "";
    if (!final && !poll) throw new Error("post generation returned neither text nor poll");
    // Deterministic link guarantee for article posts: whatever the models did,
    // the post that reaches the group carries the clean article link — and
    // never the raw percent-encoded URL (the model can copy it out of the
    // article text even when the prompt only showed the clean one).
    if (article && articleLink && final) {
      if (articleLink !== article.url) final = final.split(article.url).join(articleLink);
      if (!final.includes(articleLink)) final = `${final}\n\n${articleLink}`;
    }
    const bodyForRecord = [final, poll ? pollAsHistoryText(poll) : ""].filter(Boolean).join("\n\n");

    // Approval gate — the GROUP's own toggle is the ONLY thing that matters
    // for a group; the global setting covers 1-on-1 chats exclusively.
    const { groupRequiresApproval } = await import("./groups.server");
    if (groupRequiresApproval(profile)) {
      const { data: adminRole } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin")
        .limit(1)
        .maybeSingle();
      if (!adminRole?.user_id) throw new Error("no approval owner");
      // Fresh media read at queue time: the steering chat may have attached a
      // generated image AFTER this row was claimed, and the approval row must
      // carry it — approvePending sends approval.media as the WhatsApp image
      // (2026-07-26 lion post shipped text-only over exactly this gap).
      const { parseMedia: parseApprovalMedia } = await import("@/lib/media");
      const { data: freshMediaRow } = await supabase
        .from("planned_posts")
        .select("media" as never)
        .eq("id", post.id)
        .maybeSingle();
      const approvalMedia = parseApprovalMedia(
        (freshMediaRow as { media?: unknown } | null)?.media,
      );
      const { channelStamp: approvalStamp } = await import("./channel.server");
      const approvalRow = {
        user_id: adminRole.user_id,
        target_chat_id: profile.chat_id,
        target_name: profile.name ?? profile.chat_id,
        body: final || poll!.question,
        source: "group_post",
        status: "pending",
        ...(await approvalStamp(supabase)),
        ...(approvalMedia ? { media: approvalMedia } : {}),
      };
      const { error: apprErr } = await supabase
        .from("scheduled_approvals")
        .insert({ ...approvalRow, poll: poll as unknown as Json, planned_post_id: post.id });
      if (apprErr) {
        // planned_post_id column absent (its migration not applied yet):
        // keep the native poll, drop only the link — approve falls back to
        // matching the queued post by group + body.
        console.warn("[posting] approval insert with link failed, retrying:", apprErr.message);
        const { error: pollErr } = await supabase
          .from("scheduled_approvals")
          .insert({ ...approvalRow, poll: poll as unknown as Json });
        if (pollErr) {
          // poll column absent too: embed the poll as text so nothing is lost.
          console.warn(
            "[posting] approval insert with poll failed, falling back:",
            pollErr.message,
          );
          await supabase.from("scheduled_approvals").insert({
            ...approvalRow,
            body: bodyForRecord,
          });
        }
      }
      await supabase
        .from("planned_posts")
        .update({
          body: bodyForRecord,
          reasoning: reviewNote,
          status: "queued_approval",
          // Release the lease — the approve flow owns the post from here.
          engagement: releaseLease(owned) as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      // A queued group post is IMMEDIATE-tier news for the WhatsApp admins —
      // they can approve it from the chat without opening the dashboard.
      if (deps.trigger !== "simulation") {
        try {
          const { isDemoTarget } = await import("@/lib/whapi.server");
          const { notifyWaAdmins } = await import("./admin-notify.server");
          if (!isDemoTarget(profile.chat_id))
            await notifyWaAdmins(
              supabase,
              [
                `🕓 פוסט חדש ממתין לאישור`,
                `קבוצה: ${profile.name ?? profile.chat_id}`,
                `תוכן: ${(final || poll?.question || "").slice(0, 250)}`,
                `אפשר לאשר או לדחות כאן — פשוט תכתוב לי.`,
              ].join("\n"),
              { whapi: deps.whapi },
            );
        } catch (e) {
          console.warn("[posting] admin approval notify failed:", e);
        }
      }
      return "queued_approval";
    }

    // Last ownership check before anything reaches WhatsApp: the supersede
    // pass skips leased groups, but if this row was cancelled anyway (manual
    // action, or a pass that ran before our claim landed), the message must
    // not go out and the terminal status must not be clobbered to 'sent'.
    const { data: stillPlanned } = await supabase
      .from("planned_posts")
      .select("id")
      .eq("id", post.id)
      .eq("status", "planned")
      .maybeSingle();
    if (!stillPlanned) {
      logDecision(supabase, {
        chat_id: profile.chat_id,
        trigger: "scheduled",
        stage: "skipped",
        status: "skip",
        summary: "Post was cancelled while its reply was being generated — nothing sent",
        data: { planned_post_id: post.id },
      });
      return "cancelled_midflight";
    }

    // DUPLICATE GUARD: never send content near-identical to something this
    // chat already received in the last hour (same URL, or ≥60% token
    // overlap). This is the deterministic net under the idempotency marker —
    // whatever path produced the duplicate, it dies here, visibly.
    {
      const candidateBody = [final, poll ? pollAsHistoryText(poll) : ""]
        .filter(Boolean)
        .join("\n\n");
      const recentDupe = await findRecentNearDuplicate(supabase, profile.chat_id, candidateBody);
      if (recentDupe) {
        const { send_started_at: _g1, send_body: _g2, ...guardEngagement } = releaseLease(owned);
        await supabase
          .from("planned_posts")
          .update({
            status: "failed",
            reasoning: `Duplicate guard blocked the send: near-identical to a message delivered to this chat at ${recentDupe.at} (${recentDupe.source}). Nothing was sent.`,
            engagement: guardEngagement as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("id", post.id);
        logDecision(supabase, {
          chat_id: profile.chat_id,
          trigger: "scheduled",
          stage: "error",
          status: "error",
          summary: `Duplicate guard blocked a ${post.source} post to ${profile.name ?? profile.chat_id} — near-identical content was sent at ${recentDupe.at}`,
          data: { planned_post_id: post.id, matched_at: recentDupe.at, source: recentDupe.source },
        });
        return "duplicate_blocked";
      }
    }

    // SEND MARKER, awaited, BEFORE anything leaves for WhatsApp: if this
    // request dies between the send and the record there is no catch path —
    // this marker is what tells the next attempt "a send may have happened;
    // record it, never resend" (the idempotency check at the top).
    owned = {
      ...owned,
      send_started_at: new Date().toISOString(),
      send_body: [final, poll ? pollAsHistoryText(poll) : ""]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 1500),
    };
    await supabase
      .from("planned_posts")
      .update({ engagement: owned as Json, updated_at: new Date().toISOString() })
      .eq("id", post.id);

    // Send: media-with-caption when the post carries an attachment (one
    // WhatsApp message), else text — then the native tappable poll. The drain
    // query deliberately omits the media column (it may predate its
    // migration), so the attachment is fetched here in a FENCED single-row
    // read — a missing column just means "no media", never a failed post.
    const { parseMedia } = await import("@/lib/media");
    // ALWAYS a fresh single-row read, never the row snapshot from claim time:
    // the steering chat can attach a generated image seconds after the claim,
    // and a stale null here silently ships the post without its image. A
    // missing column (pre-migration) just means "no media", never a failure.
    let postMediaRaw: unknown;
    {
      const { data: mediaRow } = await supabase
        .from("planned_posts")
        .select("media" as never)
        .eq("id", post.id)
        .maybeSingle();
      postMediaRaw = (mediaRow as { media?: unknown } | null)?.media;
    }
    const postMedia = parseMedia(postMediaRaw);
    let textSendId: string | null = null;
    if (postMedia) {
      const { sendMediaMessage } = await import("@/lib/media.server");
      const sendRes = (await sendMediaMessage(profile.chat_id, postMedia, final || undefined)) as {
        message?: { id?: string };
      };
      textSendId = sendRes?.message?.id ?? null;
    } else if (final) {
      const sendRes = (await deps.whapi.sendText(profile.chat_id, final)) as {
        message?: { id?: string };
      };
      textSendId = sendRes?.message?.id ?? null;
    }
    // A poll failure after the text went out must not mark the post failed
    // (it was delivered) — record the send and surface the poll error.
    let pollSendId: string | null = null;
    let pollSent = false;
    let pollError = "";
    if (poll) {
      try {
        const pollRes = (await deps.whapi.sendPoll(
          profile.chat_id,
          poll.question,
          poll.options,
          pollCount(poll),
        )) as { message?: { id?: string } };
        pollSendId = pollRes?.message?.id ?? null;
        pollSent = true;
      } catch (e) {
        pollError = String((e as Error)?.message ?? e);
        console.warn("[posting] poll send failed:", pollError);
        // Nothing was delivered at all — let the normal failure path handle it.
        if (!final) throw new Error(`poll send failed: ${pollError}`);
      }
    }

    const { mediaLabel } = await import("@/lib/media");
    const sentBody = [
      final,
      postMedia ? mediaLabel(postMedia) : "",
      poll && pollSent ? pollAsHistoryText(poll) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // The stored draft and the send marker have served their purpose — drop
    // them, and release the lease, so the engagement jsonb goes back to
    // holding only stats (gen_attempts and gen_last_model kept for record).
    const {
      draft: _sentDraft,
      send_started_at: _sentMarker,
      send_body: _sentMarkerBody,
      ...doneEngagement
    } = releaseLease(owned);
    // Conditional on 'planned': a cancel that slipped between the ownership
    // check and the send must keep its terminal status — the delivery is then
    // recorded via the conversation mirror + an error decision only.
    const { data: sentRows } = await supabase
      .from("planned_posts")
      .update({
        body: sentBody,
        reasoning: [reviewNote, pollError ? `poll send failed: ${pollError}` : ""]
          .filter(Boolean)
          .join(" | "),
        status: "sent",
        sent_at: new Date().toISOString(),
        whapi_message_id: textSendId ?? pollSendId,
        engagement: doneEngagement as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id)
      .eq("status", "planned")
      .select("id");
    if (!sentRows?.length) {
      // NO INVISIBLE SENDS: the row was cancelled concurrently, but the
      // message HAS been delivered — the Sent list must show it anyway.
      await supabase
        .from("planned_posts")
        .update({
          body: sentBody,
          status: "sent",
          sent_at: new Date().toISOString(),
          whapi_message_id: textSendId ?? pollSendId,
          reasoning:
            "Was cancelled concurrently, but the message had ALREADY been delivered — recorded as sent",
          engagement: doneEngagement as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", post.id);
      logDecision(supabase, {
        chat_id: profile.chat_id,
        trigger: "scheduled",
        stage: "error",
        status: "error",
        summary:
          "Post was cancelled concurrently but had already been delivered — forced the row to 'sent' so the send stays visible",
        data: { planned_post_id: post.id, whapi_message_id: textSendId ?? pollSendId },
      });
    }

    // Mirror into the conversation so the chat view shows it.
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("whapi_chat_id", profile.chat_id)
      .maybeSingle();
    if (conv) {
      if (final) {
        await supabase.from("messages").insert({
          conversation_id: conv.id,
          whapi_message_id: textSendId,
          direction: "outbound",
          sender_name: settings.bot_name || "Bot",
          sender_id: "bot",
          body: final,
        });
      }
      if (poll && pollSent) {
        await supabase.from("messages").insert({
          conversation_id: conv.id,
          whapi_message_id: pollSendId,
          direction: "outbound",
          sender_name: settings.bot_name || "Bot",
          sender_id: "bot",
          body: pollAsHistoryText(poll),
        });
      }
    }

    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "post",
      status: pollError ? "error" : "ok",
      summary: pollError
        ? `Published a ${post.source} post in ${profile.name ?? profile.chat_id}, but its poll failed: ${pollError.slice(0, 150)}`
        : `Published a ${post.source} post${post.pillar ? ` (${post.pillar})` : ""}${poll ? " with a native poll" : ""} in ${profile.name ?? profile.chat_id}`,
      data: {
        post: final,
        poll: poll as unknown as Record<string, unknown>,
        review_note: reviewNote,
        planned_post_id: post.id,
      },
    });
    return pollError ? "sent_poll_failed" : "sent";
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // Transient errors below the attempt cap keep status 'planned' so the
    // next tick retries; gen_attempts (already bumped) bounds the retries.
    const retryable = isTransientGenError(msg) && attempt.attempts < MAX_GEN_ATTEMPTS;
    // Send-marker hygiene on a CAUGHT error: a definite failure clears the
    // marker so the retry may genuinely resend; a TIMEOUT does not — Whapi
    // may still deliver after the timeout (approvals learned this live), and
    // the marker then makes the retry record instead of double-sending.
    const sendMayHaveLanded = /took too long|timed out/i.test(msg);
    const caughtEngagement = releaseLease(owned);
    if (!sendMayHaveLanded) {
      delete caughtEngagement.send_started_at;
      delete caughtEngagement.send_body;
    }
    await supabase
      .from("planned_posts")
      .update({
        ...(retryable ? {} : { status: "failed" }),
        reasoning: msg.slice(0, 300),
        // Release the lease on the way out: a CAUGHT failure should retry on
        // the very next tick, not wait out GEN_LEASE_MS. A draft persisted
        // before the error survives inside `owned` for that retry to send.
        engagement: caughtEngagement as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id);
    logDecision(supabase, {
      chat_id: profile.chat_id,
      trigger: "scheduled",
      stage: "error",
      status: "error",
      summary: `Post publishing failed (attempt ${attempt.attempts}/${MAX_GEN_ATTEMPTS}${retryable ? ", will retry" : ""}): ${msg.slice(0, 150)}`,
      data: { planned_post_id: post.id },
    });
    return retryable ? "retrying" : "failed";
  }
}

// ---------------------------------------------------------------------------
// Research loop
// ---------------------------------------------------------------------------
async function maybeRefreshInsights(
  deps: AgentDeps,
  settings: AgentSettings,
  profile: GroupProfile,
): Promise<boolean> {
  const { supabase } = deps;
  const { data: last } = await supabase
    .from("group_insights")
    .select("created_at")
    .eq("group_chat_id", profile.chat_id)
    .eq("kind", "activity")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < INSIGHTS_EVERY_MS) return false;

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("whapi_chat_id", profile.chat_id)
    .maybeSingle();
  if (!conv) return false;

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: weekMsgs } = await supabase
    .from("messages")
    .select("sender_id, created_at, direction")
    .eq("conversation_id", conv.id)
    .gte("created_at", weekAgo)
    .limit(2000);
  const inbound = (weekMsgs ?? []).filter((m) => m.direction === "inbound");
  const perDay = Math.round((inbound.length / 7) * 10) / 10;
  const activeMembers = new Set(inbound.map((m) => m.sender_id)).size;

  const { channelStamp: insightStamp } = await import("./channel.server");
  await supabase.from("group_insights").insert({
    group_chat_id: profile.chat_id,
    ...(await insightStamp(supabase)),
    kind: "activity",
    content: `Last 7 days: ${inbound.length} messages (${perDay}/day average) from ${activeMembers} active members.`,
    data: { messages_7d: inbound.length, per_day: perDay, active_members: activeMembers },
  });

  // Engagement for posts sent in the last 48h: replies within 24h of the post.
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: recentPosts } = await supabase
    .from("planned_posts")
    .select("id, sent_at, body")
    .eq("group_chat_id", profile.chat_id)
    .eq("status", "sent")
    .gte("sent_at", twoDaysAgo);
  for (const p of recentPosts ?? []) {
    if (!p.sent_at) continue;
    const until = new Date(new Date(p.sent_at).getTime() + 24 * 3600_000).toISOString();
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.id)
      .eq("direction", "inbound")
      .gt("created_at", p.sent_at)
      .lte("created_at", until);
    await supabase
      .from("planned_posts")
      .update({
        engagement: { replies_24h: count ?? 0, checked_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
  }

  // Topics read (fast model) — also the reactive-post trigger.
  if (inbound.length >= 10) {
    const activity = await recentGroupActivity(deps, profile.chat_id, 50);
    try {
      const res = await callLLM({
        role: "fast",
        source: "agent_insights",
        json: true,
        overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
        messages: [
          {
            role: "system",
            content: `נתח את השיחות האחרונות בקבוצה והחזר JSON בלבד:
{"topics": "one-two sentences IN ENGLISH: what members are discussing and what interests them", "hot_topic": "a hot topic that justifies a post right now (in English), or null"}`,
          },
          { role: "user", content: activity.slice(0, 6000) },
        ],
      });
      const parsed = parseJsonLoose<{ topics?: string; hot_topic?: string | null }>(res.content);
      if (parsed.topics) {
        await supabase.from("group_insights").insert({
          group_chat_id: profile.chat_id,
          ...(await insightStamp(supabase)),
          kind: "topics",
          content: String(parsed.topics),
          data: { hot_topic: parsed.hot_topic ?? null },
        });
      }
      // Reactive post: hot topic + profile allows + no recent post.
      if (parsed.hot_topic && profile.allow_reactive_posts) {
        const { data: lastPost } = await supabase
          .from("planned_posts")
          .select("sent_at")
          .eq("group_chat_id", profile.chat_id)
          .eq("status", "sent")
          .order("sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastSent = lastPost?.sent_at ? new Date(lastPost.sent_at).getTime() : 0;
        if (Date.now() - lastSent > REACTIVE_MIN_GAP_MS) {
          await supabase.from("planned_posts").insert({
            group_chat_id: profile.chat_id,
            ...(await insightStamp(supabase)),
            source: "reactive",
            prompt: `תגובה לנושא חם שעולה עכשיו בקבוצה: ${parsed.hot_topic}. הצטרף לשיחה בצורה שמוסיפה ערך.`,
          });
          logDecision(supabase, {
            chat_id: profile.chat_id,
            trigger: "scheduled",
            stage: "insight",
            summary: `Hot topic detected ("${parsed.hot_topic}") — reactive post planned`,
          });
        }
      }
    } catch (e) {
      console.warn("[posting] topics read failed:", e);
    }
  }

  logDecision(supabase, {
    chat_id: profile.chat_id,
    trigger: "scheduled",
    stage: "insight",
    summary: `Insights refreshed: ${perDay} messages/day, ${activeMembers} active members`,
  });
  return true;
}
