import { describe, expect, it, vi } from "vitest";
import type { TaskStore, Task } from "@fusion/core";
import {
  RestartRecoveryCoordinator,
  extractMissingWorktreePathFromSessionStartFailure,
  isInReviewMissingWorktreeSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
  isMergeActiveMissingWorktreeSessionStartFailure,
  isRecoverableMissingWorktreeReviewFailure,
  isRecoverableMissingWorktreeReviewFailureNoProgress,
  isRecoverableMissingWorktreeReviewFailureWithProgress,
} from "../restart-recovery-coordinator.js";

function createTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-1",
    description: "test",
    column: "in-progress",
    priority: "normal",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    log: [],
    dependencies: [],
    attachments: [],
    ...overrides,
  } as Task;
}

/*
FNXC:MissingWorktreeRetry 2026-07-31-06:10 (PR #2728 review — greptile):
The classifier hardcoded `in-review`, so on a renamed board a card stranded by an unusable-worktree
session start was not recognised as retryable — while every guard AROUND it had already been
converted. A disagreement between neighbouring checks is harder to diagnose than the original inert
literal, because each one individually looks right.

`reviewColumns` is optional and defaults to the legacy id, so the three existing call sites are
unchanged until each passes its own resolved set.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-11:20 (fleet: restart-recovery roles):
`reviewColumns` is REQUIRED now. It was optional with a `task.column === "in-review"` fallback that
production never took — `self-healing.ts` supplies the resolved set at every call site — so the
literal survived only because these tests omitted the argument. Passing the set preserves exactly
what each case asserts while removing the last thing keeping the fallback alive.

Worth recording: making the parameter required produced ZERO tsc errors, because the engine
tsconfig covers `src` and not `__tests__`. A clean typecheck was not evidence here; only running
the tests found these call sites.
*/
const REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);

describe("isInReviewMissingWorktreeSessionStartFailure", () => {
  /*
  FNXC:MissingWorktreeRetry 2026-07-30-10:05 (PR #2728, aligned to #2736's signature):
  The second parameter is the caller's already-RESOLVED answer, not a lane set. Both PRs widened this
  function and each typechecked on its own branch; whichever merged second would have overwritten the
  other's signature and broken its call site without git flagging a conflict. This file now matches
  #2736 exactly, so the second merge is a no-op here.

  Recording why these cases were rewritten rather than left: they were written against the SET form,
  so after the switch `["signoff"]` was simply a truthy value and two of them passed for the wrong
  reason. Engine tsconfig excludes `src/__tests__`, so tsc could not see the mismatch — only reading
  them could.
  */
  const stranded = (column: string): Task => ({
    id: "FN-1",
    column,
    error: "Refusing to start coding agent in missing worktree: /repo/.worktrees/FN-1",
  } as unknown as Task);

  it("recognises a stranded card when the caller resolved the lane as review", () => {
    expect(isInReviewMissingWorktreeSessionStartFailure(stranded("signoff"), true)).toBe(true);
  });

  it("refuses when the caller resolved the lane as NOT review, even on the legacy id", () => {
    /* The resolved answer wins over the literal — otherwise a board that renamed `in-review` to
       something else, and kept `in-review` as an ordinary column, would retry cards sitting there. */
    expect(isInReviewMissingWorktreeSessionStartFailure(stranded("in-review"), false)).toBe(false);
  });

  it("keeps the legacy id when the caller supplies nothing", () => {
    expect(isInReviewMissingWorktreeSessionStartFailure(stranded("in-review"))).toBe(true);
    expect(isInReviewMissingWorktreeSessionStartFailure(stranded("signoff"))).toBe(false);
  });

  it("still requires the worktree failure, so resolving the lane did not widen the classifier", () => {
    const healthy = { id: "FN-2", column: "signoff", error: "something else entirely" } as unknown as Task;

    expect(isInReviewMissingWorktreeSessionStartFailure(healthy, true)).toBe(false);
  });
});

describe("RestartRecoveryCoordinator", () => {
  it("classifies missing-worktree session-start failures across all assertValidWorktreeSession variants", () => {
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in missing worktree: /tmp/wt")).toBe(true);
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in incomplete worktree: /tmp/wt")).toBe(true);
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in unregistered git worktree: /tmp/wt")).toBe(true);

    expect(isMissingWorktreeSessionStartFailure("Deterministic test verification failed")).toBe(false);
    expect(isMissingWorktreeSessionStartFailure("")).toBe(false);
    expect(isMissingWorktreeSessionStartFailure(null)).toBe(false);
    expect(isMissingWorktreeSessionStartFailure(undefined)).toBe(false);
    expect(isMissingWorktreeSessionStartFailure({ message: "Refusing to start coding agent in missing worktree: /tmp/wt" })).toBe(false);
  });

  it("extracts missing-worktree path from every session-start failure variant", () => {
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in missing worktree: /tmp/wt")).toBe("/tmp/wt");
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in incomplete worktree: /tmp/wt")).toBe("/tmp/wt");
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in unregistered git worktree: /tmp/wt")).toBe("/tmp/wt");
    expect(extractMissingWorktreePathFromSessionStartFailure("other error")).toBeNull();
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in incomplete worktree:")).toBeNull();
  });

  it("identifies recoverable in-review missing-worktree failures with and without step progress", () => {
    const baseTask = createTask({
      column: "in-review",
      paused: false,
      status: "failed",
      steps: [{ id: "s1", title: "step", status: "done" }] as any,
    });

    expect(isRecoverableMissingWorktreeReviewFailure({ ...baseTask, error: "Refusing to start coding agent in missing worktree: /tmp/wt" }, REVIEW_LANES)).toBe(true);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...baseTask, error: "Refusing to start coding agent in incomplete worktree: /tmp/wt" }, REVIEW_LANES)).toBe(true);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...baseTask, error: "Refusing to start coding agent in unregistered git worktree: /tmp/wt" }, REVIEW_LANES)).toBe(true);

    expect(isRecoverableMissingWorktreeReviewFailureWithProgress({ ...baseTask, paused: true, error: "Refusing to start coding agent in missing worktree: /tmp/wt" }, REVIEW_LANES)).toBe(false);
    expect(isRecoverableMissingWorktreeReviewFailureWithProgress({ ...baseTask, error: "other" }, REVIEW_LANES)).toBe(false);
    expect(isRecoverableMissingWorktreeReviewFailureWithProgress({ ...baseTask, steps: [{ id: "s2", title: "y", status: "pending" }] as any, error: "Refusing to start coding agent in missing worktree: /tmp/wt" }, REVIEW_LANES)).toBe(false);

    const errors = [
      "Refusing to start coding agent in missing worktree: /tmp/wt",
      "Refusing to start coding agent in incomplete worktree: /tmp/wt",
      "Refusing to start coding agent in unregistered git worktree: /tmp/wt",
    ];
    for (const error of errors) {
      const withProgressTask = { ...baseTask, error };
      const noProgressTask = { ...baseTask, steps: [{ id: "s2", title: "y", status: "pending" }] as any, error };
      expect(isRecoverableMissingWorktreeReviewFailureWithProgress(withProgressTask, REVIEW_LANES)).toBe(true);
      expect(isRecoverableMissingWorktreeReviewFailureNoProgress(noProgressTask, REVIEW_LANES)).toBe(true);
      expect(isRecoverableMissingWorktreeReviewFailure(noProgressTask, REVIEW_LANES)).toBe(true);
    }
  });

  it("recognizes missing-worktree failures in every merge-active review status", () => {
    const baseTask = createTask({
      column: "in-review",
      paused: false,
      error: "Refusing to start coding agent in missing worktree: /tmp/wt",
      steps: [{ id: "s1", title: "step", status: "done" }] as any,
    });

    for (const status of ["merging", "merging-pr", "merging-fix"] as const) {
      const task = { ...baseTask, status };
      expect(isMergeActiveMissingWorktreeSessionStartFailure(task, REVIEW_LANES)).toBe(true);
      expect(isRecoverableMissingWorktreeReviewFailure(task, REVIEW_LANES)).toBe(true);
    }

    expect(isMergeActiveMissingWorktreeSessionStartFailure({ ...baseTask, status: "failed" }, REVIEW_LANES)).toBe(false);
    expect(isMergeActiveMissingWorktreeSessionStartFailure({ ...baseTask, status: null as any }, REVIEW_LANES)).toBe(false);
    expect(isMergeActiveMissingWorktreeSessionStartFailure({ ...baseTask, status: "merging", error: "ordinary merge failure" }, REVIEW_LANES)).toBe(false);
  });

  it("requeues interrupted failed tasks with no progress, then resumes remaining orphans", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        createTask({ id: "FN-1", status: "failed", error: "Agent finished without calling fn_task_done", steps: [] }),
        createTask({ id: "FN-2", steps: [{ id: "s1", title: "x", status: "done" }] as any }),
      ]),
      updateTask: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;

    const executor = {
      resumeOrphaned: vi.fn().mockResolvedValue(undefined),
    } as any;

    const coordinator = new RestartRecoveryCoordinator(store, executor);
    await coordinator.recoverInterruptedRuns();

    expect(store.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "stuck-killed" }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo");
    expect(executor.resumeOrphaned).toHaveBeenCalledTimes(1);
  });

  it("does not requeue when step progress exists", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        createTask({
          id: "FN-9",
          status: "failed",
          error: "Agent finished without calling fn_task_done",
          steps: [{ id: "s1", title: "x", status: "in-progress" }] as any,
        }),
      ]),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      moveTask: vi.fn(),
    } as unknown as TaskStore;

    const executor = { resumeOrphaned: vi.fn().mockResolvedValue(undefined) } as any;
    const coordinator = new RestartRecoveryCoordinator(store, executor);
    await coordinator.recoverInterruptedRuns();

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(executor.resumeOrphaned).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-23:20:

THE INVARIANT: restart recovery sweeps the board's OWN wip lane.

THE FLAGGED QUERY, NOW CONVERTED. The note this replaces was correct that the `listTasks({ column })`
QUERY was the live filter and the `.filter` beneath it a redundant re-assertion — so converting the
predicate alone would have dropped a census count and changed nothing, because the board's wip rows
were never listed. On a renamed board this recovery did not run at all: an engine restart left
interrupted tasks stuck with no requeue.

THREE LAYERS, and naming them is the point, because the previous two conversions in this class each
hid a second one behind the first:

  1. the QUERY — fixed here, project-level (`resolveProjectColumnsForRoles`), since no task is in hand
     before the read;
  2. the redundant `.filter` — DELETED rather than converted; re-asserting the column the query just
     selected on adds nothing, and a second copy of a rule is how a read and its filter drift;
  3. the move DESTINATION — already resolved via `resolveReboundTargetForTask`; only its comment was
     stale, still describing the pre-fix state, and is corrected in place.

REVERT PROOF, measured: restore `listTasks({ column: "in-progress" })` and the renamed case requeues
nothing.
*/
describe("restart recovery resolves the board's own wip lane", () => {
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
  };

  function renamedStore(tasksByColumn: Record<string, unknown[]>) {
    const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
    return {
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ ir: RENAMED_IR }),
      listTasks: vi.fn(async ({ column }: { column: string }) => tasksByColumn[column] ?? []),
      updateTask: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
  }

  const interrupted = (id: string, column: string) =>
    createTask({ id, column, status: "failed", error: "Agent finished without calling fn_task_done", steps: [] } as never);

  it("requeues an interrupted task sitting in a RENAMED wip lane", async () => {
    // Pre-fix: the query asked for "in-progress", got nothing, and the restart recovery no-opped.
    const store = renamedStore({ building: [interrupted("FN-1", "building")] });
    const coordinator = new RestartRecoveryCoordinator(store, { resumeOrphaned: vi.fn().mockResolvedValue(undefined) } as never);

    await coordinator.recoverInterruptedRuns();

    expect(store.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "stuck-killed" }));
  });

  it("still skips a PAUSED task — the only thing the deleted filter contributed", async () => {
    // Removing the redundant column re-assertion must not remove the pause guard with it.
    const paused = { ...interrupted("FN-2", "building"), paused: true };
    const store = renamedStore({ building: [paused] });
    const coordinator = new RestartRecoveryCoordinator(store, { resumeOrphaned: vi.fn().mockResolvedValue(undefined) } as never);

    await coordinator.recoverInterruptedRuns();

    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
