import { describe, expect, it } from "vitest";
import { evaluateTaskDoneRefusal } from "../executor.js";

function createTask(stepStatuses: Array<"done" | "skipped" | "pending" | "in-progress">) {
  return {
    id: "FN-PREMISE-STALE",
    title: "Premise stale",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: stepStatuses.map((status, index) => ({ name: `Step ${index + 1}`, status })),
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

describe("fn_task_done summary-independent refusal checks", () => {
  it("allows fn_task_done when summary starts with PREMISE STALE:", () => {
    const task = createTask(["done", "skipped", "skipped", "skipped", "skipped"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: the task has no remaining work — implementation is already done on HEAD" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("allows fn_task_done when summary contains blocked-work phrasing", () => {
    const task = createTask(["done", "skipped", "skipped"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: targeted reproduction passes on HEAD; nothing to unblock and no further work required" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("allows a lowercase PREMISE STALE sentinel", () => {
    const task = createTask(["done", "skipped"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "premise stale: this task is not done because main already shipped it" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("does not reject incomplete-work prose when PREMISE STALE appears later", () => {
    const task = createTask(["done"]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "The task is not done yet, but PREMISE STALE: I think it's stale anyway" },
      new Map(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("still enforces pending-code-review-revise even with the sentinel", () => {
    // The bypass only relaxes the summary-text checks. A genuine REVISE verdict
    // on an in-progress step must still block fn_task_done.
    const task = createTask(["done", "in-progress"]);
    const verdicts = new Map<number, "REVISE">([[1, "REVISE"]]);
    const result = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: already done on HEAD" },
      verdicts as any,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalClass).toBe("pending-code-review-revise");
    }
  });
});
