// Shared in-memory Supabase stand-in for the e2e-style agent tests.
//
// Honest enough that assertions reach REAL pipeline behavior instead of
// echoing mocks: filters (eq/neq/gt/gte/lt/lte/in/like/or) actually filter,
// order/limit actually apply, updates mutate seeded state, and every
// insert/update is recorded per table so tests can assert what was — and,
// crucially, what was NOT — persisted.
//
// Deliberately NOT a Supabase reimplementation: only the query surface the
// agent pipeline + posting reconcile actually use is supported, and anything
// unsupported throws loudly so a contract drift fails the test instead of
// silently returning empty data.
import type { AgentDeps, WhapiPort } from "../types";

export type Row = Record<string, unknown>;

type Filter = { kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like"; col: string; val: unknown };

export type UpdateEntry = {
  table: string;
  patch: Row;
  /** eq filters the update carried, as {col: value} — enough to assert intent. */
  match: Row;
  /** How many state rows the update actually touched. */
  applied: number;
};

export type FakeSupa = {
  client: AgentDeps["supabase"];
  /** Live table state (seeded rows + inserts, mutated by updates). */
  state: Record<string, Row[]>;
  /** Every inserted row, per table, in insertion order. */
  inserts: Record<string, Row[]>;
  /** Every update call, in order. */
  updates: UpdateEntry[];
  /** Optional hook fired before each query runs (table + op) — lets a test
   * inject mid-flight state changes (e.g. a newer inbound arriving). */
  onQuery?: (table: string, op: string) => void;
};

function likeToRegExp(pattern: string): RegExp {
  // Supabase LIKE: % = any run, _ = any char. Escape everything else.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`);
}

function cmp(a: unknown, b: unknown): number {
  // ISO timestamps compare correctly as strings; numbers as numbers.
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function rowMatches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.kind) {
    case "eq":
      return v === f.val;
    case "neq":
      return v !== f.val;
    case "gt":
      return cmp(v, f.val) > 0;
    case "gte":
      return cmp(v, f.val) >= 0;
    case "lt":
      return cmp(v, f.val) < 0;
    case "lte":
      return cmp(v, f.val) <= 0;
    case "like":
      return likeToRegExp(String(f.val)).test(String(v ?? ""));
  }
}

export function makeFakeSupa(seed: Record<string, Row[]> = {}): FakeSupa {
  const state: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) state[table] = rows.map((r) => ({ ...r }));
  const inserts: Record<string, Row[]> = {};
  const updates: UpdateEntry[] = [];
  let seq = 0;

  const fake: FakeSupa = { client: null as unknown as AgentDeps["supabase"], state, inserts, updates };

  class QB {
    private op: "select" | "insert" | "update" | "delete" = "select";
    private filters: Filter[] = [];
    private inFilters: Array<{ col: string; vals: unknown[] }> = [];
    /** or() clauses — a row passes when ANY matches (only eq/like supported). */
    private orClauses: Filter[][] = [];
    private toInsert: Row[] = [];
    private patch: Row = {};
    private orderBy: Array<{ col: string; asc: boolean }> = [];
    private limitN: number | null = null;
    private returning = false;
    private wantSingle = false;
    private failSingleWhenMissing = false;

    constructor(private table: string) {}

    select(_cols?: string, _opts?: Record<string, unknown>) {
      if (this.op === "insert" || this.op === "update") this.returning = true;
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.toInsert = Array.isArray(rows) ? rows : [rows];
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
      this.filters.push({ kind: "eq", col, val });
      return this;
    }
    neq(col: string, val: unknown) {
      this.filters.push({ kind: "neq", col, val });
      return this;
    }
    gt(col: string, val: unknown) {
      this.filters.push({ kind: "gt", col, val });
      return this;
    }
    gte(col: string, val: unknown) {
      this.filters.push({ kind: "gte", col, val });
      return this;
    }
    lt(col: string, val: unknown) {
      this.filters.push({ kind: "lt", col, val });
      return this;
    }
    lte(col: string, val: unknown) {
      this.filters.push({ kind: "lte", col, val });
      return this;
    }
    like(col: string, val: unknown) {
      this.filters.push({ kind: "like", col, val });
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push({ col, vals });
      return this;
    }
    or(expr: string) {
      // e.g. "wa_id.eq.9725...,wa_id.like.9725...@%" — the people lookup shape.
      const clause: Filter[] = expr.split(",").map((part) => {
        const m = part.match(/^([^.]+)\.(eq|like)\.(.*)$/);
        if (!m) throw new Error(`fake-supa: unsupported or() clause: ${part}`);
        return { kind: m[2] as "eq" | "like", col: m[1], val: m[3] };
      });
      this.orClauses.push(clause);
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderBy.push({ col, asc: opts?.ascending !== false });
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this.run();
    }
    single() {
      this.wantSingle = true;
      this.failSingleWhenMissing = true;
      return this.run();
    }
    // Awaiting the builder directly (no maybeSingle/single) runs the query —
    // matching supabase-js's thenable builder.
    then<T1 = unknown, T2 = never>(
      onFulfilled?: (v: { data: unknown; error: unknown; count: number | null }) => T1 | PromiseLike<T1>,
      onRejected?: (e: unknown) => T2 | PromiseLike<T2>,
    ) {
      return this.run().then(onFulfilled, onRejected);
    }

    private matches(row: Row): boolean {
      if (!this.filters.every((f) => rowMatches(row, f))) return false;
      if (!this.inFilters.every(({ col, vals }) => vals.includes(row[col]))) return false;
      return this.orClauses.every((clause) => clause.some((f) => rowMatches(row, f)));
    }

    private async run(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      fake.onQuery?.(this.table, this.op);
      const rows = (state[this.table] ??= []);

      if (this.op === "insert") {
        const created = this.toInsert.map((r) => {
          const row: Row = {
            id: (r.id as string) ?? `${this.table}-${++seq}`,
            // Mirrors the DB default — gt(created_at) checks must see inserts.
            created_at: (r.created_at as string) ?? new Date().toISOString(),
            ...r,
          };
          rows.push(row);
          (inserts[this.table] ??= []).push(row);
          return row;
        });
        const data = this.wantSingle ? (created[0] ?? null) : this.returning ? created : null;
        return { data, error: null, count: created.length };
      }

      if (this.op === "update") {
        const touched = rows.filter((row) => this.matches(row));
        for (const row of touched) Object.assign(row, this.patch);
        updates.push({
          table: this.table,
          patch: this.patch,
          match: Object.fromEntries(this.filters.filter((f) => f.kind === "eq").map((f) => [f.col, f.val])),
          applied: touched.length,
        });
        const data = this.returning ? touched.map((r) => ({ ...r })) : null;
        return { data: this.wantSingle ? (touched[0] ?? null) : data, error: null, count: touched.length };
      }

      if (this.op === "delete") {
        state[this.table] = rows.filter((row) => !this.matches(row));
        return { data: null, error: null, count: rows.length - state[this.table].length };
      }

      let found = rows.filter((row) => this.matches(row));
      for (const { col, asc } of [...this.orderBy].reverse()) {
        found = [...found].sort((a, b) => (asc ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
      }
      if (this.limitN != null) found = found.slice(0, this.limitN);
      if (this.wantSingle) {
        if (this.failSingleWhenMissing && found.length !== 1) {
          return { data: null, error: { message: "single() row count mismatch", code: "PGRST116" }, count: null };
        }
        return { data: found[0] ? { ...found[0] } : null, error: null, count: null };
      }
      return { data: found.map((r) => ({ ...r })), error: null, count: found.length };
    }
  }

  fake.client = {
    from: (table: string) => new QB(table),
    rpc: async () => ({ data: [], error: null }),
    auth: { admin: { listUsers: async () => ({ data: { users: [{ id: "admin-user-1" }] } }) } },
  } as unknown as AgentDeps["supabase"];

  return fake;
}

// ---------------------------------------------------------------------------
// Fake Whapi port — records every send so tests can count real deliveries.
// ---------------------------------------------------------------------------
export type FakeWhapi = {
  port: WhapiPort;
  sends: Array<{ chatId: string; body: string }>;
  polls: Array<{ chatId: string; title: string; options: string[]; count: number }>;
};

export function makeFakeWhapi(): FakeWhapi {
  const sends: FakeWhapi["sends"] = [];
  const polls: FakeWhapi["polls"] = [];
  const port: WhapiPort = {
    sendText: async (chatId, body) => {
      sends.push({ chatId, body });
      return { message: { id: `wamid-out-${sends.length}` } };
    },
    sendPoll: async (chatId, title, options, count) => {
      polls.push({ chatId, title, options, count });
      return { message: { id: `wamid-poll-${polls.length}` } };
    },
    markRead: async () => {},
    react: async () => {},
    presence: async () => {},
  };
  return { port, sends, polls };
}

// ---------------------------------------------------------------------------
// Standard seed for a DM conversation the pipeline will reply in.
// ---------------------------------------------------------------------------
export const DM_CHAT_ID = "972500000777@s.whatsapp.net";
export const CONV_ID = "conv-dm-1";

export function seedDmTables(nowMs: number, opts: { requireApprovalAll?: boolean } = {}): Record<string, Row[]> {
  const earlier = new Date(nowMs - 60 * 60 * 1000).toISOString();
  return {
    bot_settings: [
      {
        id: "settings-1",
        enabled: true,
        system_prompt: "אתה נציג שירות אנושי וחם.",
        bot_name: "נציג",
        require_approval_all: opts.requireApprovalAll ?? false,
        model_strong: null,
        model_fast: null,
        agent_config: {},
        created_at: earlier,
      },
    ],
    conversations: [
      {
        id: CONV_ID,
        whapi_chat_id: DM_CHAT_ID,
        name: "דנה",
        is_group: false,
        inbound_count: 3,
        consecutive_outbound: 0,
        blocked: false,
        last_outbound_at: null,
        last_outbound_body: null,
        created_at: earlier,
      },
    ],
    messages: [
      {
        id: "msg-hist-1",
        conversation_id: CONV_ID,
        direction: "inbound",
        sender_id: DM_CHAT_ID,
        sender_name: "דנה",
        body: "היי, אשמח לשמוע פרטים",
        created_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
      },
    ],
    people: [
      {
        id: "person-1",
        wa_id: "972500000777",
        display_name: "דנה",
        language: "he",
        sentiment: null,
        funnel_stage: "lead",
        facts: [],
        tags: [],
        last_seen_at: earlier,
        created_at: earlier,
      },
    ],
    knowledge_base: [],
    bot_jobs: [],
    bot_decisions: [],
    scheduled_approvals: [],
    user_roles: [{ id: "role-1", user_id: "admin-user-1", role: "admin", created_at: earlier }],
  };
}
