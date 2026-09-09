import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";
import {
  evaluateStepLedgerSeal,
  resolveStepReopenPolicy,
  STEP_LEDGER_REOPEN_MARKER_PREFIX,
} from "@fusion/core";

import { cleanupMergeStateForReverification } from "../executor/cleanup-merge-state.js";
import { reopenLastStepForRevision } from "../executor/reopen-last-step-for-revision.js";
import { sendTaskBackForFix } from "../executor/send-task-back-for-fix.js";
import { countOptionalStepRevisionAttempts } from "../executor/optional-step-revision.js";
import { reviewInputSignature } from "../executor/request-pre-merge-optional-step-fix.js";

function task(steps: Task["steps"]): Task {
  return {
    id: "FN-180",
    column: "in-progress",
    worktree: "/tmp/fn-180",
    steps,
    log: [],
  } as Task;
}

const COMPLETION_MARKER = "Task marked done by agent";

function reopenActions(task: Task): string[] {
  return (task.log ?? [])
    .map((entry) => entry.action)
    .filter((action) => action.startsWith(STEP_LEDGER_REOPEN_MARKER_PREFIX));
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

  it("reopens a completed ledger exactly once with the trailing replay append", async () => {
    const live = task([
      { name: "Implementation", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ]);
    live.log = [{ timestamp: "2026-09-01T00:00:00.000Z", action: COMPLETION_MARKER }];
    const store = {
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (patch) Object.assign(live, patch);
        return live;
      }),
    };

    expect(evaluateStepLedgerSeal(live.log).sealed).toBe(true);
    await reopenLastStepForRevision(store as never, live.id, live);

    expect(reopenActions(live)).toHaveLength(1);
    expect(evaluateStepLedgerSeal(live.log).sealed).toBe(false);
    expect(live.steps.at(-1)).toEqual({ name: "Testing & Verification", status: "pending" });
  });

  it("does not stamp a live implementation session", async () => {
    const live = task([{ name: "Implementation", status: "done" }]);
    live.log = [{ timestamp: "2026-09-01T00:00:00.000Z", action: "Executor using model: test/model" }];
    const store = {
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (patch) Object.assign(live, patch);
        return live;
      }),
    };

    await reopenLastStepForRevision(store as never, live.id, live);

    expect(reopenActions(live)).toEqual([]);
    expect(live.steps.at(-1)).toEqual({ name: "Implementation", status: "pending" });
  });

  it("does not append or stamp a replay while pending work is already queued", async () => {
    const live = task([
      { name: "Implementation", status: "done" },
      { name: "Existing correction", status: "pending" },
    ]);
    live.log = [{ timestamp: "2026-09-01T00:00:00.000Z", action: COMPLETION_MARKER }];
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
    expect(reopenActions(live)).toEqual([]);
    expect(evaluateStepLedgerSeal(live.log).sealed).toBe(true);
  });

  it("resets the cursor without growing or stamping an all-pending checklist", async () => {
    const live = task([{ name: "Queued work", status: "pending" }]);
    live.currentStep = 8;
    live.log = [{ timestamp: "2026-09-01T00:00:00.000Z", action: COMPLETION_MARKER }];
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
    expect(reopenActions(live)).toEqual([]);
  });

  it("atomically charges only a newly appended trailing replay", async () => {
    const live = task([{ name: "Implementation", status: "done" }]);
    const failed = {
      workflowStepId: "browser-verification",
      workflowStepName: "Browser Verification",
      phase: "pre-merge" as const,
      status: "failed" as const,
      output: "failed",
      startedAt: "2026-09-08T00:00:00.000Z",
    };
    live.workflowStepResults = [failed];
    live.postReviewFixCount = 0;
    const store = {
      publishReviewRemediationFenced: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (!patch) return { applied: false as const, reason: "refused" as const };
        Object.assign(live, patch);
        return { applied: true as const, task: live };
      }),
    };
    const accounting = {
      revisionKey: "browser-verification",
      stepName: "Browser Verification",
      status: "failed",
      maxRevisions: 1 as const,
      expectedWorkflowStepId: "browser-verification",
      expectedReviewSignature: reviewInputSignature(failed) ?? "",
    };

    await expect(reopenLastStepForRevision(store as never, live.id, live, accounting)).resolves.toMatchObject({ kind: "appended" });
    expect(live.steps.filter((step) => step.status === "pending")).toHaveLength(1);
    expect(countOptionalStepRevisionAttempts(live, accounting.revisionKey, accounting.stepName)).toBe(1);
    expect(live.postReviewFixCount).toBe(1);

    await expect(reopenLastStepForRevision(store as never, live.id, live, accounting)).resolves.toEqual({ kind: "already-committed" });
    expect(live.steps.filter((step) => step.status === "pending")).toHaveLength(1);
    expect(countOptionalStepRevisionAttempts(live, accounting.revisionKey, accounting.stepName)).toBe(1);
    expect(live.postReviewFixCount).toBe(1);
    expect(live.log?.some((entry) => entry.outcome?.includes("Workflow revision ledger reset:"))).toBe(false);
  });

  it("does not charge duplicate pending replay work with remaining budget", async () => {
    const live = task([
      { name: "Implementation", status: "done" },
      { name: "Implementation", status: "pending" },
    ]);
    const failed = { workflowStepId: "browser-verification", status: "failed" as const, output: "failed" };
    live.workflowStepResults = [failed];
    live.postReviewFixCount = 4;
    const store = {
      publishReviewRemediationFenced: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (!patch) return { applied: false as const, reason: "refused" as const };
        Object.assign(live, patch);
        return { applied: true as const, task: live };
      }),
    };

    await expect(reopenLastStepForRevision(store as never, live.id, live, {
      revisionKey: "browser-verification",
      stepName: "Browser Verification",
      status: "failed",
      maxRevisions: 5,
      expectedWorkflowStepId: "browser-verification",
      expectedReviewSignature: reviewInputSignature(failed) ?? "",
    })).resolves.toEqual({ kind: "duplicate-no-new-work" });
    expect(countOptionalStepRevisionAttempts(live, "browser-verification", "Browser Verification")).toBe(0);
    expect(live.postReviewFixCount).toBe(4);
  });

  it("keeps a trailing replay paired when scheduling fails after commit", async () => {
    const live = task([{ name: "Implementation", status: "done" }]);
    const failed = { workflowStepId: "browser-verification", workflowStepName: "Browser Verification", status: "failed" as const, output: "failed" };
    live.workflowStepResults = [failed];
    live.postReviewFixCount = 0;
    const store = {
      getTask: vi.fn(async () => live),
      getSettings: vi.fn(async () => ({})),
      addTaskComment: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(live, patch); return live; }),
      publishReviewRemediationFenced: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(live);
        if (!patch) return { applied: false as const, reason: "refused" as const };
        Object.assign(live, patch);
        return { applied: true as const, task: live };
      }),
    };
    const scheduleWorkflowRerun = vi.fn()
      .mockImplementationOnce(() => { throw new Error("injected scheduling failure"); })
      .mockImplementation(() => undefined);
    const deps = {
      store: store as never,
      clearCompletedTaskWatchdog: vi.fn(),
      injectWorkflowStepFailureInstructions: vi.fn(async () => undefined),
      reopenLastStepForRevision: (taskId: string, current: Task, accounting?: any) =>
        accounting
          ? reopenLastStepForRevision(store as never, taskId, current, accounting)
          : reopenLastStepForRevision(store as never, taskId, current),
      scheduleWorkflowRerun,
      maxWorkflowStepRetries: 3,
    };
    const accounting = {
      revisionKey: "browser-verification",
      stepName: "Browser Verification",
      status: "failed",
      maxRevisions: 3,
      expectedWorkflowStepId: "browser-verification",
      expectedReviewSignature: reviewInputSignature(failed) ?? "",
    };
    const invoke = () => sendTaskBackForFix(
      deps, live, live.worktree!, "failed", "Browser Verification", "review failed",
      true, false, { attempt: 1, max: 3 }, undefined, undefined, "reopen-trailing", accounting,
    );

    await expect(invoke()).rejects.toThrow("injected scheduling failure");
    await expect(invoke()).resolves.toEqual({ kind: "scheduled", remediationCommitted: true });

    expect(live.steps.filter((step) => step.status === "pending")).toHaveLength(1);
    expect(countOptionalStepRevisionAttempts(live, accounting.revisionKey, accounting.stepName)).toBe(1);
    expect(live.postReviewFixCount).toBe(1);
    expect(scheduleWorkflowRerun).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["pause", (current: Task) => ({ ...current, paused: true })],
    ["user pause", (current: Task) => ({ ...current, userPaused: true })],
    ["manual-review hold", (current: Task) => ({ ...current, autoMerge: false })],
    ["lane replacement", (current: Task) => ({ ...current, column: "todo" })],
    ["failed-round replacement", (current: Task) => ({
      ...current,
      workflowStepResults: current.workflowStepResults?.map((result) => ({
        ...result,
        output: "new failed occurrence",
        completedAt: "2026-09-08T00:01:00.000Z",
      })),
    })],
  ])("refuses a trailing replay when %s wins before fenced publication", async (_case, mutateLive) => {
    let live = task([{ name: "Implementation", status: "done" }]);
    live.column = "in-review";
    const failed = {
      workflowStepId: "browser-verification",
      workflowStepName: "Browser Verification",
      status: "failed" as const,
      output: "failed",
      completedAt: "2026-09-08T00:00:00.000Z",
    };
    live.workflowStepResults = [failed];
    const initial = live;
    const store = {
      publishReviewRemediationFenced: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        live = mutateLive(live) as Task;
        const patch = mutate(live);
        if (!patch) return { applied: false as const, reason: "refused" as const };
        live = { ...live, ...patch } as Task;
        return { applied: true as const, task: live };
      }),
    };

    await expect(reopenLastStepForRevision(store as never, initial.id, initial, {
      revisionKey: "browser-verification",
      stepName: "Browser Verification",
      status: "failed",
      maxRevisions: 3,
      expectedWorkflowStepId: "browser-verification",
      expectedReviewSignature: reviewInputSignature(failed),
      expectedColumn: "in-review",
    })).resolves.toEqual({ kind: "superseded" });

    expect(live.steps.some((step) => step.status === "pending")).toBe(false);
    expect(live.postReviewFixCount).toBeUndefined();
    expect(live.log).toEqual([]);
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
