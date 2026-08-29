import { describe, expect, it } from "vitest";
import { evaluateTaskDoneRefusal } from "../executor.js";

function createTask(stepStatuses: Array<"done" | "skipped" | "pending" | "in-progress">) {
  return {
    id: "FN-4851",
    title: "Bulk guard",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: stepStatuses.map((status, index) => ({ name: `Step ${index + 1}`, status })),
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

describe("FN-4851 bulk-step-completion guard", () => {
  it("refuses when 2+ steps would be auto-completed without full APPROVE evidence", () => {
    const task = createTask(["done", "done", "pending", "pending", "pending", "pending", "pending"]);
    const result = evaluateTaskDoneRefusal(task, { summary: "Implemented all requested work and verified." }, new Map());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalClass).toBe("bulk-step-completion-without-review");
    }
  });

  it("allows a single pending step without review evidence", () => {
    const task = createTask(["done", "done", "done", "done", "done", "done", "pending"]);
    const result = evaluateTaskDoneRefusal(task, { summary: "All tasks complete." }, new Map());

    expect(result).toEqual({ ok: true });
  });

  it("allows bulk completion when all pending steps are APPROVE", () => {
    const task = createTask(["done", "done", "done", "done", "pending", "pending", "pending"]);
    const verdicts = new Map<number, "APPROVE">([
      [4, "APPROVE"],
      [5, "APPROVE"],
      [6, "APPROVE"],
    ]);

    const result = evaluateTaskDoneRefusal(task, { summary: "All tasks complete." }, verdicts as any);

    expect(result).toEqual({ ok: true });
  });

  it("refuses when even one pending step lacks APPROVE", () => {
    const task = createTask(["done", "done", "done", "done", "done", "pending", "pending"]);
    const verdicts = new Map<number, "APPROVE">([[5, "APPROVE"]]);

    const result = evaluateTaskDoneRefusal(task, { summary: "All tasks complete." }, verdicts as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalClass).toBe("bulk-step-completion-without-review");
    }
  });
});
