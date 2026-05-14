import { describe, expect, it } from "vitest";
import { WORKFLOW_STEP_TEMPLATES } from "../types";

const TARGET_IDS = [
  "documentation-review",
  "qa-check",
  "security-audit",
  "performance-review",
  "accessibility-check",
  "browser-verification",
  "frontend-ux-design",
] as const;

describe("workflow step template verdict contracts", () => {
  it.each(TARGET_IDS)("%s uses canonical structured verdict output", (id) => {
    const template = WORKFLOW_STEP_TEMPLATES.find((entry) => entry.id === id);
    expect(template).toBeTruthy();

    const prompt = template!.prompt;
    expect(prompt).toMatch(/"verdict":"APPROVE\|APPROVE_WITH_NOTES\|REVISE"/);
    expect(prompt).not.toContain('"verdict":"PASS"');
    expect(prompt).not.toContain('"verdict":"FAIL"');
    expect(prompt).not.toContain("task_done(");
    expect(prompt).not.toContain("task_log(");
    expect(prompt).toMatch(/Diff Scope|out of scope/i);
  });
});
