import { describe, expect, it } from "vitest";
import { AGENT_BROWSER_WORKFLOW_STEPS } from "../workflow-steps.js";

describe("workflow steps", () => {
  it("declares browser evidence review template", () => {
    const step = AGENT_BROWSER_WORKFLOW_STEPS[0];
    expect(step?.stepId).toBe("browser-evidence-review");
    expect(step?.mode).toBe("prompt");
  });
});
