// Per-group approval toggle — RULE (2026-07-28): groups are governed
// EXCLUSIVELY by their own toggle; the global require_approval_all covers
// private chats only and has NO effect on groups. This matrix is the contract
// the posting engine and the group-reply pipeline both gate on.
import { describe, expect, it } from "vitest";

import { groupRequiresApproval } from "../groups.server";
import { sanitizeProfilePatch } from "../profile-patch";

describe("groupRequiresApproval", () => {
  it("group ON → send waits for approval", () => {
    expect(groupRequiresApproval({ require_approval: true })).toBe(true);
  });

  it("group OFF → send goes out immediately", () => {
    expect(groupRequiresApproval({ require_approval: false })).toBe(false);
  });

  it("no explicit toggle (null / missing / no profile) → NO approval — the global setting never applies to groups", () => {
    expect(groupRequiresApproval({ require_approval: null })).toBe(false);
    expect(groupRequiresApproval({})).toBe(false);
    expect(groupRequiresApproval(null)).toBe(false);
    expect(groupRequiresApproval(undefined)).toBe(false);
  });
});

describe("steering-chat patch accepts the toggle", () => {
  it("require_approval boolean is whitelisted; junk is rejected", () => {
    const ok = sanitizeProfilePatch({ require_approval: true });
    expect(ok.applied).toContain("require_approval");
    expect(ok.patch.require_approval).toBe(true);

    const off = sanitizeProfilePatch({ require_approval: false });
    expect(off.patch.require_approval).toBe(false);

    const junk = sanitizeProfilePatch({ require_approval: "yes" });
    expect(junk.rejected).toContain("require_approval");
    expect(junk.patch.require_approval).toBeUndefined();
  });
});
