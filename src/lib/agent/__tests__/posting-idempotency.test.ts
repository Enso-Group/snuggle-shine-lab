// The 2026-07-28 double-send, pinned: a post whose previous attempt reached
// the WhatsApp send and died before recording must NEVER resend — the retry
// records it as sent. And the duplicate guard blocks near-identical content
// to the same chat within an hour. Both run through the REAL drain.
import { describe, expect, it } from "vitest";
import { drainPlannedPosts } from "../posting.server";
import type { AgentDeps } from "../types";
import { makeFakeSupa, makeFakeWhapi, type FakeSupa, type Row } from "./fake-supa";

const GROUP = "120363000000000001@g.us";
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function seed(extra: { planned: Row[]; sent?: Row[] }): Record<string, Row[]> {
  return {
    bot_settings: [
      {
        id: "settings-1",
        enabled: true,
        system_prompt: "אתה מנהל קהילה.",
        bot_name: "נציג",
        require_approval_all: true, // must NOT affect groups
        model_strong: null,
        model_fast: null,
        agent_config: {},
        created_at: iso(86_400_000),
      },
    ],
    group_profiles: [
      {
        id: "gp-1",
        chat_id: GROUP,
        name: "קבוצת בדיקה",
        enabled: true,
        language: "he",
        content_pillars: [],
        posting_schedule: [],
        rules: [],
        forbidden_topics: [],
        moderation: {},
        welcome: {},
        reply_when_mentioned: true,
        reply_to_questions: false,
        allow_reactive_posts: false,
        require_approval: null,
        updated_at: iso(3_600_000),
      },
    ],
    planned_posts: [...extra.planned, ...(extra.sent ?? [])],
    conversations: [],
    messages: [],
    bot_decisions: [],
    scheduled_approvals: [],
    user_roles: [{ id: "r1", user_id: "admin-user-1", role: "admin", created_at: iso(0) }],
    group_insights: [],
    strategy_memos: [],
    knowledge_base: [],
  };
}

function makeDeps(fake: FakeSupa, whapi: ReturnType<typeof makeFakeWhapi>): AgentDeps {
  return {
    supabase: fake.client,
    whapi: whapi.port,
    trigger: "inbound",
    workerId: "test-worker",
    humanPacing: false,
  };
}

const postRow = (fake: FakeSupa, id: string) =>
  (fake.state.planned_posts ?? []).find((p) => p.id === id);

describe("idempotent group sends", () => {
  it("retry after an unrecorded send records it WITHOUT resending", async () => {
    const fake = makeFakeSupa(
      seed({
        planned: [
          {
            id: "post-1",
            group_chat_id: GROUP,
            source: "schedule",
            pillar: null,
            prompt: "פוסט על השקעות",
            body: null,
            status: "planned",
            engagement: {
              gen_attempts: 1,
              draft: { post: "הטיוטה ששוחזרה", poll: null },
              send_started_at: iso(90_000),
              send_body: "ההודעה שכבר נשלחה לוואטסאפ",
            },
            reasoning: null,
            created_at: iso(300_000),
            scheduled_for: iso(300_000),
            sent_at: null,
            updated_at: iso(90_000),
          },
        ],
      }),
    );
    const whapi = makeFakeWhapi();
    const results = await drainPlannedPosts(makeDeps(fake, whapi), { max: 1 });

    expect(whapi.sends).toHaveLength(0); // NOTHING resent
    expect(whapi.polls).toHaveLength(0);
    expect(results).toEqual([{ group: "קבוצת בדיקה", status: "recovered_sent" }]);
    const row = postRow(fake, "post-1")!;
    expect(row.status).toBe("sent"); // …but the send IS recorded
    expect(row.body).toBe("ההודעה שכבר נשלחה לוואטסאפ");
    expect(String(row.reasoning)).toContain("WITHOUT resending");
  });

  it("duplicate guard blocks a near-identical post to the same chat within an hour", async () => {
    const url = "https://blog.glidaiproperties.com/blog/bluewaters.html";
    const fake = makeFakeSupa(
      seed({
        planned: [
          {
            id: "post-dupe",
            group_chat_id: GROUP,
            source: "schedule",
            pillar: null,
            prompt: "עוד פוסט",
            body: null,
            status: "planned",
            engagement: {
              gen_attempts: 1,
              draft: { post: `ניסוח שונה לגמרי על אותו מאמר ${url}`, poll: null },
            },
            reasoning: null,
            created_at: iso(60_000),
            scheduled_for: iso(60_000),
            sent_at: null,
            updated_at: iso(60_000),
          },
        ],
        sent: [
          {
            id: "post-sent-before",
            group_chat_id: GROUP,
            source: "schedule",
            pillar: null,
            prompt: null,
            body: `סיכום המאמר על Bluewaters — כל הפרטים כאן ${url}`,
            status: "sent",
            engagement: {},
            reasoning: null,
            created_at: iso(1_800_000),
            scheduled_for: iso(1_800_000),
            sent_at: iso(1_500_000),
            updated_at: iso(1_500_000),
          },
        ],
      }),
    );
    const whapi = makeFakeWhapi();
    const results = await drainPlannedPosts(makeDeps(fake, whapi), { max: 1 });

    expect(whapi.sends).toHaveLength(0); // blocked, nothing sent
    expect(results).toEqual([{ group: "קבוצת בדיקה", status: "duplicate_blocked" }]);
    const row = postRow(fake, "post-dupe")!;
    expect(row.status).toBe("failed");
    expect(String(row.reasoning)).toContain("Duplicate guard");
  });

  it("a clean stored draft still sends exactly once and is recorded once", async () => {
    const fake = makeFakeSupa(
      seed({
        planned: [
          {
            id: "post-clean",
            group_chat_id: GROUP,
            source: "schedule",
            pillar: null,
            prompt: "פוסט חדש לגמרי",
            body: null,
            status: "planned",
            engagement: {
              gen_attempts: 1,
              draft: { post: "תוכן חדש שמעולם לא נשלח לקבוצה הזאת", poll: null },
            },
            reasoning: null,
            created_at: iso(60_000),
            scheduled_for: iso(60_000),
            sent_at: null,
            updated_at: iso(60_000),
          },
        ],
      }),
    );
    const whapi = makeFakeWhapi();
    const results = await drainPlannedPosts(makeDeps(fake, whapi), { max: 1 });

    expect(whapi.sends).toHaveLength(1); // exactly one real send
    expect(results).toEqual([{ group: "קבוצת בדיקה", status: "sent" }]);
    const row = postRow(fake, "post-clean")!;
    expect(row.status).toBe("sent");
    expect(row.whapi_message_id).toBeTruthy();
    // Marker cleaned up after the successful record.
    expect((row.engagement as Record<string, unknown>).send_started_at).toBeUndefined();
  });
});
