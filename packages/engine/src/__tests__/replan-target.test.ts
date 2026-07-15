import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { hasAdvancedPastPlanning, isTaskStillInPlanningStage, moveTaskToReplanColumn, resolveReplanTargetColumn } from "../replan-target.js";

/*
FNXC:WorkflowReplan 2026-07-12-23:55:
Engine replan rebounds must target a column the task's OWN workflow declares. The default
Coding workflow replans in "triage"; Coding (Ideas) has no "triage" column and replans in
place in its merged "todo" planner column. The old hardcoded moveTask(id, "triage") orphaned
Coding (Ideas) cards in an undeclared column (rendered back in the "Ideas" intake lane).
*/

function storeWithSelection(workflowId: string | undefined): TaskStore {
  return {
    getTaskWorkflowSelection: vi.fn().mockReturnValue(workflowId ? { workflowId, stepIds: [] } : undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("planning-stage guard", () => {
  it.each([
    [{ column: "triage", worktree: null, steps: [] }, true, "empty triage task"],
    [{ column: "todo", worktree: null, steps: [] }, true, "unplanned todo seed"],
    [{ column: "todo", worktree: "/tmp/FN-1", steps: [] }, false, "todo task with a worktree"],
    [{ column: "todo", worktree: null, steps: [{ id: "step-1" }] }, false, "todo task with materialized steps"],
    [{ column: "in-progress", worktree: null, steps: [] }, false, "in-progress task"],
    [{ column: "in-review", worktree: null, steps: [] }, false, "in-review task"],
    [{ column: "done", worktree: null, steps: [] }, false, "completed task"],
  ] as const)("recognizes %s", (task, expected) => {
    expect(isTaskStillInPlanningStage(task)).toBe(expected);
    expect(hasAdvancedPastPlanning(task)).toBe(!expected);
  });
});

describe("resolveReplanTargetColumn", () => {
  it("targets triage for the default Coding workflow", async () => {
    const store = storeWithSelection("builtin:coding");
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });

  it("targets triage when the task has no workflow selection", async () => {
    const store = storeWithSelection(undefined);
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });

  it("targets todo for Coding (Ideas), which declares no triage column", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("todo");
  });

  it("falls back to triage for workflows declaring neither triage nor todo (never a custom column)", async () => {
    // builtin:marketing declares ideation/backlog/drafting/... — no triage, no todo.
    // A custom entry column would strand the needs-replan card (triage only scans
    // "triage" and "todo") and the legacy move path throws on custom targets.
    const store = storeWithSelection("builtin:marketing");
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });

  it("falls back to triage when workflow resolution throws", async () => {
    const store = {
      getTaskWorkflowSelection: vi.fn(() => {
        throw new Error("boom");
      }),
      getWorkflowDefinition: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as TaskStore;
    await expect(resolveReplanTargetColumn(store, "FN-1")).resolves.toBe("triage");
  });
});

describe("moveTaskToReplanColumn", () => {
  it("moves a Coding (Ideas) card to todo, not triage", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    const target = await moveTaskToReplanColumn(store, { id: "FN-1", column: "in-progress" });
    expect(target).toBe("todo");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo");
  });

  it("skips the move when the card is already in the replan column (plan-in-place)", async () => {
    const store = storeWithSelection("builtin:coding-ideas");
    const target = await moveTaskToReplanColumn(store, { id: "FN-1", column: "todo" });
    expect(target).toBe("todo");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
