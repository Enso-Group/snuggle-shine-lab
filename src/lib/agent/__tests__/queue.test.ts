import { describe, expect, it } from "vitest";
import { jobPayloadCoversTs, supersedeJobsByIds, supersedePendingReplies } from "../queue.server";
import type { Supa } from "../types";

// Captures the exact update+filter shape sent to bot_jobs — these helpers are
// the pipeline's tools for retiring pending jobs after consolidation, so a
// wrong filter would either kill claimed jobs or leave a second cycle to run.
function makeUpdateCapture() {
  const calls: Array<{
    table: string;
    patch: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }> = [];
  const client = {
    from(table: string) {
      const call = { table, patch: {} as Record<string, unknown>, filters: [] as Array<[string, unknown]> };
      const builder = {
        update(patch: Record<string, unknown>) {
          call.patch = patch;
          return builder;
        },
        eq(col: string, val: unknown) {
          call.filters.push([col, val]);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          call.filters.push([col, vals]);
          return builder;
        },
        then<T>(resolve: (v: { data: unknown; error: unknown }) => T) {
          calls.push(call);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as Supa, calls };
}

describe("supersedePendingReplies", () => {
  it("supersedes ONLY pending inbound_reply jobs for the given chat", async () => {
    const { client, calls } = makeUpdateCapture();
    await supersedePendingReplies(client, "972500000001@s.whatsapp.net");

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("bot_jobs");
    expect(calls[0].patch.status).toBe("superseded");
    expect(typeof calls[0].patch.updated_at).toBe("string");
    expect(calls[0].filters).toEqual([
      ["chat_id", "972500000001@s.whatsapp.net"],
      ["kind", "inbound_reply"],
      // Never 'processing' — the in-flight job (there is at most one per chat,
      // serialized by the claim RPC) must be able to finish its own send.
      ["status", "pending"],
    ]);
  });
});

describe("supersedeJobsByIds", () => {
  it("supersedes exactly the given ids — and still only while pending", async () => {
    const { client, calls } = makeUpdateCapture();
    await supersedeJobsByIds(client, ["job-a", "job-b"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("bot_jobs");
    expect(calls[0].patch.status).toBe("superseded");
    expect(typeof calls[0].patch.updated_at).toBe("string");
    // An explicit id list, never chat-wide: a job enqueued during the
    // pipeline's consolidation call answers a message the consolidated reply
    // does not cover, and a chat-wide supersede would kill it.
    expect(calls[0].filters).toEqual([
      ["id", ["job-a", "job-b"]],
      ["status", "pending"],
    ]);
  });

  it("issues no update at all for an empty snapshot", async () => {
    const { client, calls } = makeUpdateCapture();
    await supersedeJobsByIds(client, []);
    expect(calls).toHaveLength(0);
  });
});

describe("jobPayloadCoversTs", () => {
  const TS = 1_800_000_000_000;

  it("covers when payload.ts is at or after the inbound ts", () => {
    expect(jobPayloadCoversTs({ ts: TS }, TS)).toBe(true);
    expect(jobPayloadCoversTs({ ts: TS + 1 }, TS)).toBe(true);
    expect(jobPayloadCoversTs({ ts: TS - 1 }, TS)).toBe(false);
  });

  it("parses a jsonb payload that surfaces as a JSON string", () => {
    expect(jobPayloadCoversTs(JSON.stringify({ ts: TS }), TS)).toBe(true);
    expect(jobPayloadCoversTs(JSON.stringify({ ts: TS - 1 }), TS)).toBe(false);
  });

  it("never covers on junk — a job we can't read must not be trusted to own a reply", () => {
    expect(jobPayloadCoversTs(null, TS)).toBe(false);
    expect(jobPayloadCoversTs(undefined, TS)).toBe(false);
    expect(jobPayloadCoversTs({}, TS)).toBe(false);
    expect(jobPayloadCoversTs({ ts: "not-a-number" }, TS)).toBe(false);
    expect(jobPayloadCoversTs("{broken json", TS)).toBe(false);
  });
});
