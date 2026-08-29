import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BADGE_CSS_PATH = "app/components/workflow-phase-badge.css";
const BADGE_HELPER_PATH = "app/components/workflow-phase-badge.tsx";
const WORKFLOW_RESULTS_CSS_PATH = "app/components/WorkflowResultsTab.css";

const BADGE_CSS = readFileSync(BADGE_CSS_PATH, "utf8");
const BADGE_HELPER = readFileSync(BADGE_HELPER_PATH, "utf8");
const WORKFLOW_RESULTS_CSS = readFileSync(WORKFLOW_RESULTS_CSS_PATH, "utf8");

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return BADGE_CSS.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("workflow phase badge CSS", () => {
  it("co-locates the shared phase badge styles with the helper", () => {
    expect(existsSync(BADGE_CSS_PATH)).toBe(true);
    expect(BADGE_HELPER).toContain('import "./workflow-phase-badge.css";');
  });

  it("themes pre-merge and post-merge badges with workflow phase tokens only", () => {
    const preMergeRule = cssRule(".phase-badge--pre-merge");
    const postMergeRule = cssRule(".phase-badge--post-merge");

    expect(preMergeRule).toContain("background-color: color-mix(in srgb, var(--ws-pre-merge) 15%, transparent);");
    expect(preMergeRule).toContain("color: var(--ws-pre-merge);");
    expect(postMergeRule).toContain("background-color: color-mix(in srgb, var(--ws-post-merge) 15%, transparent);");
    expect(postMergeRule).toContain("color: var(--ws-post-merge);");

    for (const rule of [preMergeRule, postMergeRule]) {
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(rule).not.toMatch(/\brgba?\(/i);
    }
  });

  it("removes phase badge styling from WorkflowResultsTab to avoid duplicate sources", () => {
    expect(WORKFLOW_RESULTS_CSS).not.toMatch(/\.phase-badge(?:--pre-merge|--post-merge)?\s*\{/);
  });
});
