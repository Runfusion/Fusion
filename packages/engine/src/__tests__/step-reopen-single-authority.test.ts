import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";
import { resolveStepReopenPolicy } from "@fusion/core";

import { cleanupMergeStateForReverification } from "../executor/cleanup-merge-state.js";
import { reopenLastStepForRevision } from "../executor/reopen-last-step-for-revision.js";
import { sendTaskBackForFix } from "../executor/send-task-back-for-fix.js";

function task(steps: Task["steps"]): Task {
  return {
    id: "FN-180",
    column: "in-progress",
    worktree: "/tmp/fn-180",
    steps,
  } as Task;
}

/*
 * FNXC:WorkflowStepReopenAuthority 2026-08-23-08:51:
 * FN-180 protects the FN-175 remediation path from a second, title-driven replay authority.
 * These tests keep the workflow policy and the one-step bounce coupled while allowing review-gated
 * and editor-authored workflows to opt out through their IR.
 */
describe("FN-180 step reopen single authority", () => {
  it("reopens exactly the trailing completed step without inspecting its title", async () => {
    const live = task([
      { name: "Implementation", status: "done" },
      { name: "Testing & Verification", status: "done" },
      { name: "Documentation & Delivery", status: "done" },
    ]);
    const store = {
      updateStep: vi.fn(async (_id: string, index: number, status: string) => {
        live.steps[index]!.status = status as Task["steps"][number]["status"];
      }),
      updateTask: vi.fn(),
    };

    await expect(reopenLastStepForRevision(store as never, live.id, live)).resolves.toEqual({
      index: 2,
      name: "Documentation & Delivery",
      indexes: [2],
    });
    expect(store.updateStep).toHaveBeenCalledTimes(1);
    expect(store.updateStep).toHaveBeenCalledWith(live.id, 2, "pending");
    expect(live.steps.map((step) => step.status)).toEqual(["done", "done", "pending"]);
  });

  it("uses the editor-authored IR policy instead of a workflow id", () => {
    const reviewGated = {
      nodes: [{ id: "parse", type: "parse", config: { implementationOnlySteps: true, preserveRemediationSteps: true } }],
      edges: [],
      columns: [],
    } as unknown as WorkflowIr;
    const ordinary = {
      nodes: [{ id: "parse", type: "parse", config: {} }],
      edges: [],
      columns: [],
    } as unknown as WorkflowIr;

    expect(resolveStepReopenPolicy(reviewGated)).toBe("none");
    expect(resolveStepReopenPolicy(ordinary)).toBe("reopen-trailing");
  });

  it("does not compound cleanup and remediation bounce reopening", async () => {
    const live = task([{ name: "Implementation", status: "done" }]);
    const store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(live),
      logEntry: vi.fn().mockResolvedValue(undefined),
      addTaskComment: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({}),
    };
    await cleanupMergeStateForReverification({ store: store as never, getRunContextFor: () => undefined }, live, "cleanup", {
      stepReopenPolicy: "reopen-trailing",
    });
    expect(store.updateTask).toHaveBeenCalledWith(live.id, expect.not.objectContaining({ repositoryScope: expect.anything() }));

    const reopen = vi.fn().mockResolvedValue(undefined);
    await sendTaskBackForFix({
      store: store as never,
      clearCompletedTaskWatchdog: vi.fn(),
      injectWorkflowStepFailureInstructions: vi.fn().mockResolvedValue(undefined),
      reopenLastStepForRevision: reopen,
      scheduleWorkflowRerun: vi.fn(),
      maxWorkflowStepRetries: 3,
    }, live, live.worktree!, "fix", "Code Review", "revision requested", true, false, undefined, undefined, undefined, "reopen-trailing");

    expect(reopen).toHaveBeenCalledTimes(1);

    await sendTaskBackForFix({
      store: store as never,
      clearCompletedTaskWatchdog: vi.fn(),
      injectWorkflowStepFailureInstructions: vi.fn().mockResolvedValue(undefined),
      reopenLastStepForRevision: reopen,
      scheduleWorkflowRerun: vi.fn(),
      maxWorkflowStepRetries: 3,
    }, live, live.worktree!, "fix", "Code Review", "revision requested", true, false, undefined, undefined, undefined, "none");
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("keeps every production remediation caller on resolved policy and has no title heuristic", async () => {
    const { readFile } = await import("node:fs/promises");
    const reopenSource = await readFile(new URL("../executor/reopen-last-step-for-revision.ts", import.meta.url), "utf8");
    expect(reopenSource).not.toMatch(/testing\|verification\|documentation\|delivery/i);

    for (const file of [
      "../executor/request-pre-merge-optional-step-fix.ts",
      "../executor/run-implementation.ts",
      "../executor/recover-failed-pre-merge-step.ts",
      "../executor/review-convergence-ladder.ts",
    ]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source).toContain("resolveStepReopenPolicy");
    }
  });
});
