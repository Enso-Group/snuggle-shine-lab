// Per-group approval toggle: the group's explicit setting fully overrides the
// global require_approval_all in BOTH directions; only groups that never set
// one follow the global. This matrix is the contract the posting engine and
// the group-reply pipeline both gate on.
import { describe, expect, it } from "vitest";

import { groupRequiresApproval } from "../groups.server";
import { sanitizeProfilePatch } from "../profile-patch";

describe("groupRequiresApproval", () => {
  const globalOn = { require_approval_all: true };
  const globalOff = { require_approval_all: false };

  it("group ON overrides global OFF (send waits for approval)", () => {
    expect(groupRequiresApproval({ require_approval: true }, globalOff)).toBe(true);
  });

  it("group OFF overrides global ON (send goes out immediately)", () => {
    expect(groupRequiresApproval({ require_approval: false }, globalOn)).toBe(false);
  });

  it("group toggle agrees with global — same answer", () => {
    expect(groupRequiresApproval({ require_approval: true }, globalOn)).toBe(true);
    expect(groupRequiresApproval({ require_approval: false }, globalOff)).toBe(false);
  });

  it("no explicit toggle (null / missing / no profile) falls back to global", () => {
    expect(groupRequiresApproval({ require_approval: null }, globalOn)).toBe(true);
    expect(groupRequiresApproval({ require_approval: null }, globalOff)).toBe(false);
    expect(groupRequiresApproval({}, globalOn)).toBe(true);
    expect(groupRequiresApproval(null, globalOn)).toBe(true);
    expect(groupRequiresApproval(undefined, globalOff)).toBe(false);
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
