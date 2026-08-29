import { describe, expect, it } from "vitest";
import { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "../workflow-steps.js";

describe("cli-printing-press workflow step verdict contract", () => {
  it("exports a non-empty workflow step contribution list", () => {
    expect(CLI_PRINTING_PRESS_WORKFLOW_STEPS.length).toBeGreaterThan(0);
  });

  it("requires script-mode steps to declare a non-empty scriptName", () => {
    const scriptSteps = CLI_PRINTING_PRESS_WORKFLOW_STEPS.filter((step) => step.mode === "script");
    expect(scriptSteps.length).toBeGreaterThan(0);

    for (const step of scriptSteps) {
      expect(step.scriptName?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  const promptSteps = CLI_PRINTING_PRESS_WORKFLOW_STEPS.filter((step) => step.mode === "prompt");

  // Prompt-mode slice may be empty today; invariant activates automatically when prompt entries are added.
  if (promptSteps.length === 0) {
    it("has no prompt-mode steps today; invariant guard is dormant", () => {
      expect(promptSteps).toHaveLength(0);
    });
  }

  it.each(promptSteps.map((step) => [step.stepId, step] as const))(
    "enforces structured verdict prompt contract for %s",
    (_stepId, step) => {
      expect(typeof step.prompt).toBe("string");
      expect(step.prompt?.trim().length ?? 0).toBeGreaterThan(0);

      const prompt = step.prompt ?? "";
      expect(prompt).toMatch(/\{\s*"verdict"\s*:\s*"APPROVE\|APPROVE_WITH_NOTES\|REVISE"\s*,\s*"notes"\s*:/);
      expect(prompt).not.toContain('"verdict":"PASS"');
      expect(prompt).not.toContain('"verdict":"FAIL"');
      expect(prompt).not.toContain("task_done(");
      expect(prompt).not.toContain("task_log(");
      expect(prompt).toMatch(/out of scope|Diff Scope/i);
    },
  );
});
