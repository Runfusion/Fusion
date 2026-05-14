import { describe, expect, it, vi } from "vitest";
import { enforceTaskTokenBudget, resolveTaskTokenBudget } from "../token-budget-enforcer.js";

describe("resolveTaskTokenBudget", () => {
  it("prefers task override", () => {
    const result = resolveTaskTokenBudget(
      { id: "FN-1", description: "x", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "", updatedAt: "", tokenBudgetOverride: { soft: 10, hard: 20 } } as any,
      { taskTokenBudget: { soft: 100, hard: 200 } } as any,
      { taskTokenBudget: { soft: 1000, hard: 2000 } } as any,
    );
    expect(result).toEqual({ soft: 10, hard: 20, source: "task-override" });
  });
});

describe("enforceTaskTokenBudget", () => {
  it("fires soft once and hard pause once", async () => {
    const updateTask = vi.fn(async () => undefined);
    const pauseTask = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const task = {
      id: "FN-1",
      description: "x",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: "",
      updatedAt: "",
      tokenUsage: { totalTokens: 150 },
    } as any;

    await enforceTaskTokenBudget({
      store: { updateTask, pauseTask },
      task,
      projectSettings: { taskTokenBudget: { soft: 100, hard: 140 } } as any,
      globalSettings: {} as any,
      notify,
    });

    expect(updateTask).toHaveBeenCalled();
    expect(pauseTask).toHaveBeenCalledWith("FN-1", true, undefined);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "hard" }));
  });
});
