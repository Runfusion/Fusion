import { describe, expect, it } from "vitest";
import { AGENT_BROWSER_WORKFLOW_STEPS } from "../workflow-steps.js";

describe("workflow steps", () => {
  it("declares browser evidence review template", () => {
    const step = AGENT_BROWSER_WORKFLOW_STEPS[0];
    expect(step?.stepId).toBe("browser-evidence-review");
    expect(step?.mode).toBe("prompt");
    expect(step?.prompt).toContain('"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE"');
    expect(step?.prompt).not.toContain('"verdict":"PASS"');
    expect(step?.prompt).not.toContain('"verdict":"FAIL"');
    expect(step?.prompt).not.toMatch(/task_done\(|task_log\(/);
    expect(step?.prompt).toMatch(/out of scope|Diff Scope/i);
  });
});
