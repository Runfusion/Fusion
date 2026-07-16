import { describe, expect, it, vi } from "vitest";
import { enforceTaskTokenBudget, getTokenBudgetUsage, resolveTaskTokenBudget } from "../token-budget-enforcer.js";

const task = (patch: Record<string, unknown> = {}) => ({
  id: "FN-1", description: "x", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "", updatedAt: "", ...patch,
}) as any;

describe("resolveTaskTokenBudget", () => {
  it.each([
    ["task override", task({ size: "M", tokenBudgetOverride: { soft: 1, hard: 2 } }), { taskTokenBudget: { soft: 10, hard: 20, perSize: { M: { soft: 11 } } } }, { taskTokenBudget: { soft: 100 } }, { soft: 1, hard: 2, source: "task-override" }],
    ["project per-size", task({ size: "M" }), { taskTokenBudget: { soft: 10, hard: 20, perSize: { M: { soft: 11 } } } }, { taskTokenBudget: { soft: 100 } }, { soft: 11, hard: 20, source: "project-per-size" }],
    ["project base", task(), { taskTokenBudget: { soft: 10, hard: 20 } }, { taskTokenBudget: { soft: 100 } }, { soft: 10, hard: 20, source: "project" }],
    ["global per-size", task({ size: "M" }), {}, { taskTokenBudget: { soft: 100, hard: 200, perSize: { M: { hard: 201 } } } }, { soft: 100, hard: 201, source: "global-per-size" }],
    ["global base", task(), {}, { taskTokenBudget: { soft: 100, hard: 200 } }, { soft: 100, hard: 200, source: "global" }],
    ["none", task(), {}, {}, { source: "none" }],
  ])("uses %s precedence", (_name, subject, project, global, expected) => {
    expect(resolveTaskTokenBudget(subject, project as any, global as any)).toEqual(expected);
  });
});

describe("enforceTaskTokenBudget", () => {
  it("claims soft and hard caps once and pauses through pauseTask", async () => {
    const current = task({ tokenUsage: { inputTokens: 150, outputTokens: 0, cacheWriteTokens: 0 } });
    const updateTaskAtomic = vi.fn(async (_id, updater) => {
      const patch = await updater(current);
      if (patch) Object.assign(current, patch);
      return current;
    });
    const pauseTask = vi.fn(async () => current);
    const notify = vi.fn(async () => undefined);

    await enforceTaskTokenBudget({ store: { updateTaskAtomic, pauseTask } as any, task: current, projectSettings: { taskTokenBudget: { soft: 100, hard: 140 } } as any, globalSettings: {} as any, notify });
    await enforceTaskTokenBudget({ store: { updateTaskAtomic, pauseTask } as any, task: current, projectSettings: { taskTokenBudget: { soft: 100, hard: 140 } } as any, globalSettings: {} as any, notify });

    expect(pauseTask).toHaveBeenCalledOnce();
    expect(pauseTask).toHaveBeenCalledWith("FN-1", true, undefined, { pausedReason: "token_budget_exceeded" });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("releases a hard claim when pause fails so a later persist retries", async () => {
    const current = task({ tokenUsage: { inputTokens: 25 } });
    const updateTaskAtomic = vi.fn(async (_id, updater) => {
      const patch = await updater(current);
      if (patch) Object.assign(current, patch);
      return current;
    });
    const pauseTask = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(current);
    const notify = vi.fn(async () => undefined);
    const params = { store: { updateTaskAtomic, pauseTask } as any, task: current, projectSettings: { taskTokenBudget: { hard: 20 } } as any, globalSettings: {} as any, notify };

    await expect(enforceTaskTokenBudget(params)).rejects.toThrow("transient");
    expect(current.tokenBudgetHardAlertedAt).toBeNull();
    await enforceTaskTokenBudget(params);
    expect(pauseTask).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("excludes cache reads from the budget basis", () => {
    expect(getTokenBudgetUsage({ inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cachedTokens: 9_999, totalTokens: 10_059 } as any)).toBe(60);
  });
});
