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
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (patch) Object.assign(live, patch);
        return live;
      }),
    };

    await expect(reopenLastStepForRevision(store as never, live.id, live)).resolves.toEqual({
      index: 3,
      name: "Documentation & Delivery",
      indexes: [3],
    });
    expect(store.updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(live.steps.map((step) => [step.name, step.status])).toEqual([
      ["Implementation", "done"],
      ["Testing & Verification", "done"],
      ["Documentation & Delivery", "done"],
      ["Documentation & Delivery", "pending"],
    ]);
    expect(live.currentStep).toBe(3);
  });

  it("does not append a replay while pending work is already queued", async () => {
    const live = task([
      { name: "Implementation", status: "done" },
      { name: "Existing correction", status: "pending" },
    ]);
    const originalSteps = live.steps;
    const store = {
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (patch) Object.assign(live, patch);
        return live;
      }),
    };

    await expect(reopenLastStepForRevision(store as never, live.id, live)).resolves.toBeNull();
    expect(live.steps).toBe(originalSteps);
    expect(live.steps).toHaveLength(2);
  });

  it("resets the cursor without growing an all-pending checklist", async () => {
    const live = task([{ name: "Queued work", status: "pending" }]);
    live.currentStep = 8;
    const store = {
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (patch) Object.assign(live, patch);
        return live;
      }),
    };

    await expect(reopenLastStepForRevision(store as never, live.id, live)).resolves.toBeNull();
    expect(live.steps).toHaveLength(1);
    expect(live.currentStep).toBe(0);
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
