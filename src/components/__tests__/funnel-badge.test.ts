// Node-env tests (no DOM): function components are called directly and
// assertions run against the returned element's props.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { FUNNEL_STAGE_STYLES, FunnelStageBadge } from "@/components/funnel-badge";

function render(props: Parameters<typeof FunnelStageBadge>[0]) {
  return FunnelStageBadge(props) as ReactElement<{ className?: string; children?: unknown }>;
}

describe("FUNNEL_STAGE_STYLES", () => {
  it("covers every funnel stage with its assigned color", () => {
    expect(FUNNEL_STAGE_STYLES.unknown).toContain("bg-muted");
    expect(FUNNEL_STAGE_STYLES.lead).toContain("sky");
    expect(FUNNEL_STAGE_STYLES.customer).toContain("green");
    expect(FUNNEL_STAGE_STYLES.community).toContain("violet");
    expect(FUNNEL_STAGE_STYLES.vip).toContain("amber");
    expect(FUNNEL_STAGE_STYLES.churned).toContain("red");
  });

  it("pairs a light-mode and a dark-mode text color for each tinted stage", () => {
    for (const [stage, cls] of Object.entries(FUNNEL_STAGE_STYLES)) {
      if (stage === "unknown") continue;
      expect(cls).toMatch(/bg-\w+-500\/15 text-\w+-600 dark:text-\w+-400/);
    }
  });
});

describe("FunnelStageBadge", () => {
  it("renders the stage name with its stage color", () => {
    const el = render({ stage: "vip" });
    expect(el.props.children).toBe("vip");
    expect(el.props.className).toContain("amber");
  });

  it("falls back to the muted style for unrecognized stages", () => {
    const el = render({ stage: "something-new" });
    expect(el.props.children).toBe("something-new");
    expect(el.props.className).toContain("bg-muted");
  });

  it("defaults to the small size and grows with size='md'", () => {
    expect(render({ stage: "lead" }).props.className).toContain("text-[10px]");
    expect(render({ stage: "lead", size: "md" }).props.className).toContain("text-xs");
  });
});
