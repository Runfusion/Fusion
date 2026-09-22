import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createTaskDoneTool } from "../executor/create-task-done-tool.js";
import { handleImplicitTaskDoneRefusal } from "../executor/task-done-refusal-handler.js";
import { evaluateTaskDoneRefusal } from "../executor/task-done-refusal.js";

vi.mock("../executor/lifecycle-columns.js", () => ({ resolveReboundColumnFor: async () => "in-progress" }));

describe("completion refusal preserves recoverable checkout", () => {
  it.each(["explicit", "implicit"] as const)("preserves checkout and pending work through %s retry exhaustion", async (surface) => {
    const task = {
      id: "FN-9349", column: "in-progress", taskDoneRetryCount: 0,
      worktree: "/repo/.worktrees/repair", branch: "fusion/fn-9349",
      steps: [{ name: "Required evidence", status: "in-progress" }, { name: "Verification", status: "pending" }],
    } as Task;
    const originalSteps = structuredClone(task.steps);
    const store = {
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
      logEntry: vi.fn(),
      moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; }),
    } as unknown as TaskStore;
    const onDone = vi.fn();
    const deps = {
      store, getRunContextFor: () => undefined, persistTokenUsage: vi.fn(),
      markGraphExecuteSelfRequeued: vi.fn(), deleteActiveSession: vi.fn(), clearTokenUsageBaseline: vi.fn(),
      workflowLifecycleMovesInFlight: new Set<string>(), getTaskCompletionBlocker: async () => undefined,
      evaluateTaskVerdictProviders: async () => ({ ok: true as const }),
      verifyWorktreeInvariants: async () => ({ ok: true as const }),
      evaluateTaskDoneScopeLeak: async () => ({ blocked: false as const }),
      scheduleCompletedTaskWatchdog: vi.fn(), finalizeAcceptedNoOpCompletion: vi.fn(),
    };
    const tool = createTaskDoneTool(deps, task.id, task.worktree!, "", new Map(), onDone);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (surface === "explicit") {
        await tool.execute("done", { summary: "Pending evidence" });
      } else {
        const refusal = evaluateTaskDoneRefusal(task, {}, new Map());
        if (refusal.ok) throw new Error("Expected pending-step refusal");
        await handleImplicitTaskDoneRefusal(deps, task, refusal);
      }
      expect(task.worktree).toBe("/repo/.worktrees/repair");
      expect(task.branch).toBe("fusion/fn-9349");
      expect(task.steps).toEqual(originalSteps);
      expect(task.status).toBe(attempt < 3 ? "queued" : "failed");
      expect(task.taskDoneRetryCount).toBe(Math.min(attempt + 1, 3));
    }
    expect(onDone).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledTimes(3);
    expect(task.error).toContain("bulk-step-completion-without-review");
  });
});
