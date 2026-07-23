import { describe, expect, it } from "vitest";
import { handleInboundMessage } from "../inbound-handler.server";
import { parseWhapiMessage } from "../inbound";
import type { AgentDeps, AgentSettings, AgentTrigger, WhapiPort } from "../types";

// ---------------------------------------------------------------------------
// A tiny in-memory Supabase stand-in — just enough of the query-builder surface
// that handleInboundMessage (and the anti-ban/reply-gate helpers it calls) use.
// It records every insert/update per table so tests can assert what was — and,
// crucially, what was NOT — persisted.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

function makeFakeSupabase(seed: { conversations?: Row[]; groupProfiles?: Row[] } = {}) {
  const state: Record<string, Row[]> = {
    conversations: [...(seed.conversations ?? [])],
    group_profiles: [...(seed.groupProfiles ?? [])],
    messages: [],
    bot_jobs: [],
    bot_decisions: [],
  };
  const inserts: Record<string, Row[]> = {
    conversations: [],
    messages: [],
    bot_jobs: [],
    bot_decisions: [],
  };
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  class QB {
    op: "select" | "insert" | "update" | "delete" = "select";
    filters: Array<[string, unknown]> = [];
    rows: Row[] = [];
    patch: Row = {};
    returning = false;
    wantSingle = false;
    constructor(private table: string) {}
    select() {
      if (this.op === "insert") this.returning = true;
      else this.op = "select";
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.rows = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    gt() {
      return this;
    }
    gte() {
      return this;
    }
    lt() {
      return this;
    }
    in() {
      return this;
    }
    like() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this.run();
    }
    single() {
      this.wantSingle = true;
      return this.run();
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return this.run().then(onF, onR);
    }
    private matches(row: Row) {
      return this.filters.every(([c, v]) => row[c] === v);
    }
    private async run(): Promise<{ data: unknown; error: unknown }> {
      const table = this.table;
      if (this.op === "insert") {
        const created = this.rows.map((r) => {
          const prefix =
            table === "conversations"
              ? "conv"
              : table === "bot_jobs"
                ? "job"
                : table === "messages"
                  ? "msg"
                  : "row";
          const row: Row = { id: (r.id as string) ?? nextId(prefix), ...r };
          if (table === "conversations") {
            row.inbound_count = (row.inbound_count as number) ?? 0;
            row.first_inbound_at = (row.first_inbound_at as string) ?? null;
            state.conversations.push(row);
          }
          (inserts[table] ??= []).push(row);
          return row;
        });
        const data = this.wantSingle ? (created[0] ?? null) : this.returning ? created : null;
        return { data, error: null };
      }
      if (this.op === "update") {
        for (const row of state[table] ?? []) if (this.matches(row)) Object.assign(row, this.patch);
        return { data: null, error: null };
      }
      if (this.op === "delete") return { data: null, error: null };
      const found = (state[table] ?? []).filter((row) => this.matches(row));
      if (this.wantSingle) return { data: found[0] ?? null, error: null };
      return { data: found, error: null };
    }
  }

  return {
    client: { from: (table: string) => new QB(table) } as unknown as AgentDeps["supabase"],
    inserts,
    state,
  };
}

const whapiStub: WhapiPort = {
  sendText: async () => ({ message: { id: "sent" } }),
  sendPoll: async () => ({}),
  markRead: async () => {},
  react: async () => {},
  presence: async () => {},
};

function makeDeps(supabase: AgentDeps["supabase"], trigger: AgentTrigger): AgentDeps {
  return {
    supabase,
    whapi: whapiStub,
    trigger,
    workerId: "test",
    humanPacing: trigger !== "simulation",
  };
}

function makeSettings(): AgentSettings {
  return {
    id: "s1",
    enabled: true,
    system_prompt: "פרסונה",
    bot_name: "בוט",
    require_approval_all: false,
    model_strong: null,
    model_fast: null,
    agent_config: {},
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe("handleInboundMessage — participation-gated persistence", () => {
  it("does NOT save a group chat the bot only observes (not addressed)", async () => {
    const fake = makeFakeSupabase();
    const m = parseWhapiMessage({
      chat_id: "120363000000000001@g.us",
      from: "972500000001@s.whatsapp.net",
      from_name: "חבר קבוצה",
      id: "wamid-observed-1",
      text: { body: "מישהו יודע מה השעה עכשיו?" },
      timestamp: nowSec(),
    })!;

    const outcome = await handleInboundMessage(
      makeDeps(fake.client, "simulation"),
      makeSettings(),
      m,
      {
        observed: true,
      },
    );

    expect(outcome.action).toBe("group_not_addressed");
    expect(fake.inserts.conversations).toHaveLength(0);
    expect(fake.inserts.messages).toHaveLength(0);
    expect(fake.inserts.bot_jobs).toHaveLength(0);
  });

  it("does NOT save a brand-new chat whose only message is stale replay", async () => {
    const fake = makeFakeSupabase();
    const staleSec = Math.floor((Date.now() - 30 * 60 * 1000) / 1000); // > 15min DM horizon
    const m = parseWhapiMessage({
      chat_id: "972500000004@s.whatsapp.net",
      from: "972500000004@s.whatsapp.net",
      from_name: "יוסי",
      id: "wamid-stale-1",
      text: { body: "הודעה ישנה מהעבר" },
      timestamp: staleSec,
    })!;

    const outcome = await handleInboundMessage(
      makeDeps(fake.client, "inbound"),
      makeSettings(),
      m,
      {},
    );

    expect(outcome.action).toBe("stored_stale");
    expect(fake.inserts.conversations).toHaveLength(0);
    expect(fake.inserts.messages).toHaveLength(0);
  });

  it("SAVES a DM the bot participates in, and schedules a durable 15-120s delay", async () => {
    const fake = makeFakeSupabase();
    const m = parseWhapiMessage({
      chat_id: "972500000002@s.whatsapp.net",
      from: "972500000002@s.whatsapp.net",
      from_name: "דנה",
      id: "wamid-dm-1",
      text: { body: "היי, אשמח לקבל פרטים על השירות שלכם" },
      timestamp: nowSec(),
    })!;

    const before = Date.now();
    const outcome = await handleInboundMessage(
      makeDeps(fake.client, "inbound"),
      makeSettings(),
      m,
      {},
    );

    expect(outcome.action).toBe("enqueued");
    expect(fake.inserts.conversations).toHaveLength(1);
    expect(fake.inserts.messages).toHaveLength(1);
    expect(fake.inserts.bot_jobs).toHaveLength(1);

    const job = fake.inserts.bot_jobs[0] as {
      run_after: string;
      conversation_id: string;
      payload: { target_reply_at: number };
    };

    // The human delay is randomized within the required 15s-2min window,
    // measured from when the message was sent.
    const delayFromMessage = job.payload.target_reply_at - m.ts;
    expect(delayFromMessage).toBeGreaterThanOrEqual(15_000);
    expect(delayFromMessage).toBeLessThanOrEqual(120_000);

    // The delay is DURABLE: run_after is in the future so the queue delivers it,
    // rather than the webhook holding the request open (which used to strand it).
    const runAfter = new Date(job.run_after).getTime();
    expect(runAfter).toBeGreaterThan(before);

    // inbound_count was bumped so the pipeline won't refuse the reply as a cold contact.
    const conv = fake.state.conversations.find((c) => c.id === job.conversation_id) as Row;
    expect(conv.inbound_count as number).toBeGreaterThanOrEqual(1);
  });

  it("returns promptly for a DM — never sleeps out the human delay inline", async () => {
    const fake = makeFakeSupabase();
    const m = parseWhapiMessage({
      chat_id: "972500000005@s.whatsapp.net",
      from: "972500000005@s.whatsapp.net",
      from_name: "רון",
      id: "wamid-dm-2",
      text: { body: "אפשר לקבוע פגישה לשבוע הבא?" },
      timestamp: nowSec(),
    })!;

    const start = Date.now();
    await handleInboundMessage(makeDeps(fake.client, "inbound"), makeSettings(), m, {});
    // The whole call must be fast (no 15-120s inline wait). Generous bound to
    // avoid flakiness while still catching any accidental multi-second sleep.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("SAVES the chat when we send from the linked phone (participation), without replying", async () => {
    const fake = makeFakeSupabase();
    const m = parseWhapiMessage({
      chat_id: "972500000003@s.whatsapp.net",
      from: "972500000003@s.whatsapp.net",
      from_me: true,
      id: "wamid-me-1",
      text: { body: "היי, אני זמין מחר בבוקר" },
      timestamp: nowSec(),
    })!;

    const outcome = await handleInboundMessage(
      makeDeps(fake.client, "inbound"),
      makeSettings(),
      m,
      {},
    );

    expect(outcome.action).toBe("stored_own");
    expect(fake.inserts.conversations).toHaveLength(1);
    expect(fake.inserts.messages).toHaveLength(1);
    expect(fake.inserts.bot_jobs).toHaveLength(0);
  });
});
