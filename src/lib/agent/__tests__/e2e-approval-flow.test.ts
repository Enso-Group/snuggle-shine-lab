// Approval reconcile flow: REAL reconcileDecidedApprovals over the fake
// Supabase — decided approvals must flip their queued_approval posts to the
// matching terminal status, pending ones must leave the post alone, and the
// approval-age rule (an approval older than the post is never its approval)
// must hold end-to-end, not just in the pure matcher.
//
// Driven through runGroupEngine, the sweeper entry point that runs the
// reconcile pass first: with zero enabled group profiles the engine returns
// right after it, so the reconcile is the ONLY thing these runs exercise
// (reconcileDecidedApprovals itself is module-private).
import { beforeEach, describe, expect, it, vi } from "vitest";

// The reconcile pass never calls the LLM — mock callLLM to throw so any
// accidental model call fails the test loudly instead of hitting the network.
const { callLLMMock } = vi.hoisted(() => ({ callLLMMock: vi.fn() }));
vi.mock("@/lib/llm.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm.server")>();
  return { ...actual, callLLM: callLLMMock };
});

import { runGroupEngine } from "../posting.server";
import type { AgentDeps } from "../types";
import { makeFakeSupa, makeFakeWhapi, type FakeSupa, type Row } from "./fake-supa";

const GROUP_ID = "120363000000000042@g.us";
const T_POST = "2026-07-25T08:00:00.000Z";
const T_APPROVAL = "2026-07-25T08:00:10.000Z"; // after the post rows
const T_DECIDED = "2026-07-25T09:00:00.000Z";

/**
 * Engine preconditions only: enabled settings so runGroupEngine reaches the
 * reconcile pass, and NO enabled group profiles so it exits right after it —
 * no slot claiming, no drain, no insights, no LLM.
 */
function engineSeed(): Record<string, Row[]> {
  return {
    bot_settings: [
      {
        id: "settings-1",
        enabled: true,
        system_prompt: "אתה נציג קהילה.",
        bot_name: "נציג",
        require_approval_all: true,
        model_strong: null,
        model_fast: null,
        agent_config: {},
        created_at: "2026-07-25T00:00:00.000Z",
      },
    ],
    group_profiles: [],
  };
}

function queuedPost(id: string, body: string): Row {
  return {
    id,
    group_chat_id: GROUP_ID,
    source: "schedule",
    status: "queued_approval",
    body,
    reasoning: "",
    engagement: {},
    created_at: T_POST,
    updated_at: T_POST,
  };
}

function approval(id: string, status: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: "admin-user-1",
    source: "group_post",
    target_chat_id: GROUP_ID,
    target_name: "קבוצת הקהילה",
    status,
    planned_post_id: null,
    body: "",
    created_at: T_APPROVAL,
    decided_at: status === "pending" ? null : T_DECIDED,
    ...overrides,
  };
}

function makeDeps(fake: FakeSupa): AgentDeps {
  return {
    supabase: fake.client,
    whapi: makeFakeWhapi().port,
    trigger: "inbound",
    workerId: "worker-test",
    humanPacing: false,
  };
}

/** logDecision writes are fire-and-forget — give their microtasks a beat. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function postState(fake: FakeSupa, id: string): Row | undefined {
  return fake.state.planned_posts.find((p) => p.id === id);
}

beforeEach(() => {
  callLLMMock.mockReset();
  callLLMMock.mockRejectedValue(new Error("reconcile must not call the LLM"));
});

describe("reconcileDecidedApprovals", () => {
  it("approved → sent (+ a 'post' decision), rejected → cancelled, pending → untouched", async () => {
    const fake = makeFakeSupa({
      ...engineSeed(),
      planned_posts: [
        queuedPost("post-approved", "פוסט על תמחור נכון"),
        queuedPost("post-rejected", "פוסט על גיוס חברים"),
        queuedPost("post-pending", "פוסט על אירוע קהילה"),
      ],
      scheduled_approvals: [
        approval("appr-approved", "approved", { planned_post_id: "post-approved" }),
        approval("appr-rejected", "rejected", { planned_post_id: "post-rejected" }),
        approval("appr-pending", "pending", { planned_post_id: "post-pending" }),
      ],
      bot_decisions: [],
    });

    await runGroupEngine(makeDeps(fake));
    await flush();

    // Approved: the post is really sent — status, sent_at from the decision.
    const sent = postState(fake, "post-approved");
    expect(sent?.status).toBe("sent");
    expect(sent?.sent_at).toBe(T_DECIDED);

    // Rejected: cancelled, and no sent_at was invented.
    const cancelled = postState(fake, "post-rejected");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.sent_at).toBeUndefined();

    // Pending: the approve flow still owns it — no update touched the row.
    expect(postState(fake, "post-pending")?.status).toBe("queued_approval");
    expect(fake.updates.filter((u) => u.table === "planned_posts" && u.match.id === "post-pending")).toHaveLength(0);

    // Exactly one 'post' decision, for the approved publish only — the
    // Activity page's Posts count is built from these rows.
    const postDecisions = (fake.inserts.bot_decisions ?? []).filter((d) => d.stage === "post");
    expect(postDecisions).toHaveLength(1);
    expect((postDecisions[0].data as Record<string, unknown>).planned_post_id).toBe("post-approved");
  });

  it("an approval created BEFORE the post never matches it (legacy body-match path)", async () => {
    const olderThanPost = "2026-07-25T07:59:00.000Z";
    const fake = makeFakeSupa({
      ...engineSeed(),
      planned_posts: [queuedPost("post-orphan", "פוסט על סדנת בוקר")],
      scheduled_approvals: [
        // Same group, body contained in the post body, APPROVED — but created
        // before the post row, so it belongs to some older post.
        approval("appr-stale", "approved", {
          planned_post_id: null,
          body: "פוסט על סדנת בוקר",
          created_at: olderThanPost,
        }),
      ],
      bot_decisions: [],
    });

    await runGroupEngine(makeDeps(fake));
    await flush();

    // The queued post must stay queued — flipping it to 'sent' off a stale
    // approval would fake a publish that never happened.
    expect(postState(fake, "post-orphan")?.status).toBe("queued_approval");
    expect(fake.updates.filter((u) => u.table === "planned_posts")).toHaveLength(0);
    expect((fake.inserts.bot_decisions ?? []).filter((d) => d.stage === "post")).toHaveLength(0);
  });

  it("a matching decided approval via the legacy body path (no link column) still heals the post", async () => {
    const fake = makeFakeSupa({
      ...engineSeed(),
      planned_posts: [queuedPost("post-legacy", "פוסט על שאלות נפוצות\n\n📊 סקר\n▫️ כן\n▫️ לא")],
      scheduled_approvals: [
        // Legacy row: no planned_post_id; approval body is the post text and
        // the planned body appends the poll rendered as text.
        approval("appr-legacy", "approved", { planned_post_id: null, body: "פוסט על שאלות נפוצות" }),
      ],
      bot_decisions: [],
    });

    await runGroupEngine(makeDeps(fake));
    await flush();

    expect(postState(fake, "post-legacy")?.status).toBe("sent");
  });
});
