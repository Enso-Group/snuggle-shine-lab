// Dead-job sweep: wall-killed reply jobs (status 'failed' via lock expiry,
// catch path never ran) must get the alert + canned fallback + research
// follow-up exactly once. REAL sweep code, fakes at the edges, no LLM needed.
import { describe, expect, it } from "vitest";

import { RESEARCH_JOB_KIND } from "../research";
import { PERMANENT_FAILURE_FALLBACK_LINE, sweepDeadReplyJobs } from "../worker.server";
import type { AgentDeps, BotJob, InboundJobPayload } from "../types";
import {
  CONV_ID,
  DM_CHAT_ID,
  makeFakeSupa,
  makeFakeWhapi,
  seedDmTables,
  type FakeSupa,
  type Row,
} from "./fake-supa";

function makeDeadJob(nowMs: number, overrides: Partial<BotJob> = {}): BotJob {
  const ts = nowMs - 10 * 60_000;
  const payload: InboundJobPayload = {
    whapi_message_id: "wamid-dead-1",
    body: "אתם יכולים למצוא לי דוח AI מעניין?",
    sender_id: DM_CHAT_ID,
    sender_name: "דנה",
    chat_name: "דנה",
    is_group: false,
    ts,
  };
  return {
    id: "dead-job-1",
    kind: "inbound_reply",
    chat_id: DM_CHAT_ID,
    conversation_id: CONV_ID,
    payload,
    status: "failed",
    attempts: 3,
    max_attempts: 3,
    run_after: new Date(ts).toISOString(),
    locked_until: null,
    locked_by: null,
    last_error: "worker lock expired",
    created_at: new Date(ts + 1_000).toISOString(),
    updated_at: new Date(nowMs - 2 * 60_000).toISOString(),
    ...overrides,
  };
}

function seedDead(nowMs: number, job: BotJob): FakeSupa {
  const fake = makeFakeSupa(seedDmTables(nowMs));
  fake.state.messages.push({
    id: "msg-dead-trigger",
    conversation_id: CONV_ID,
    direction: "inbound",
    sender_id: DM_CHAT_ID,
    sender_name: "דנה",
    body: job.payload.body,
    created_at: new Date(job.payload.ts).toISOString(),
  });
  fake.state.bot_jobs.push(job as unknown as Row);
  return fake;
}

function makeDeps(fake: FakeSupa, whapi: ReturnType<typeof makeFakeWhapi>): AgentDeps {
  return {
    supabase: fake.client,
    whapi: whapi.port,
    trigger: "inbound",
    workerId: "worker-test",
    humanPacing: false,
  };
}

describe("sweepDeadReplyJobs", () => {
  it("handles a wall-killed DM job exactly once: alert + canned fallback + research follow-up", async () => {
    const now = Date.now();
    const job = makeDeadJob(now);
    const fake = seedDead(now, job);
    const whapi = makeFakeWhapi();
    const deps = makeDeps(fake, whapi);

    const first = await sweepDeadReplyJobs(deps);

    expect(first.handled).toBe(1);
    // The contact heard the canned line — never-silent holds.
    expect(whapi.sends).toEqual([{ chatId: DM_CHAT_ID, body: PERMANENT_FAILURE_FALLBACK_LINE }]);
    // The admin was alerted (the catch path never ran for this job).
    const alert = (fake.inserts.commands_log ?? []).find((r) =>
      String(r.prompt).includes("died wall-killed"),
    );
    expect(alert).toBeTruthy();
    // The canned line's promise is tracked by a research job.
    const research = (fake.inserts.bot_jobs ?? []).filter((j) => j.kind === RESEARCH_JOB_KIND);
    expect(research).toHaveLength(1);
    // Marked handled — the sweep never double-acts.
    const row = fake.state.bot_jobs.find((j) => j.id === "dead-job-1")!;
    expect((row.payload as InboundJobPayload).fallback_handled).toBe(true);

    const second = await sweepDeadReplyJobs(deps);
    expect(second.handled).toBe(0);
    expect(whapi.sends).toHaveLength(1);
  });

  it("does not double-send when a previous attempt's marker matches an outbound", async () => {
    const now = Date.now();
    const job = makeDeadJob(now);
    (job.payload as InboundJobPayload).deliver_started = {
      at: now - 5 * 60_000,
      first_part: "תשובה שכבר נשלחה",
    };
    const fake = seedDead(now, job);
    fake.state.messages.push({
      id: "msg-already-sent",
      conversation_id: CONV_ID,
      direction: "outbound",
      sender_id: "bot",
      sender_name: "נציג",
      body: "תשובה שכבר נשלחה",
      created_at: new Date(now - 5 * 60_000).toISOString(),
    });
    const whapi = makeFakeWhapi();

    const run = await sweepDeadReplyJobs(makeDeps(fake, whapi));

    // Handled (flag set, alert raised) but no duplicate message to the contact.
    expect(run.handled).toBe(1);
    expect(whapi.sends).toEqual([]);
  });

  it("skips groups, simulation chats, and stale jobs outside the window", async () => {
    const now = Date.now();
    const groupJob = makeDeadJob(now, { id: "dead-group", chat_id: "12036300001@g.us" });
    const simJob = makeDeadJob(now, { id: "dead-sim", chat_id: "sim-1@simulation" });
    const staleJob = makeDeadJob(now, {
      id: "dead-stale",
      updated_at: new Date(now - 2 * 3_600_000).toISOString(),
    });
    const fake = makeFakeSupa(seedDmTables(now));
    fake.state.bot_jobs.push(
      groupJob as unknown as Row,
      simJob as unknown as Row,
      staleJob as unknown as Row,
    );
    const whapi = makeFakeWhapi();

    const run = await sweepDeadReplyJobs(makeDeps(fake, whapi));

    expect(run.handled).toBe(0);
    expect(whapi.sends).toEqual([]);
  });
});
