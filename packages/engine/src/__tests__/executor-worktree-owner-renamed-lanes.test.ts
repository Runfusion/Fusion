/*
FNXC:WorkflowResolvedColumns 2026-07-30-17:05 (executor — the worktree-owner scan):
DIFFERENTIAL: one worktree path, one owning task, two column VOCABULARIES.

`findActiveWorktreeOwner` answers "is anyone else actively working in this checkout?". Its in-memory
`activeWorktrees` leg is vocabulary-independent, but the DURABLE leg — the one that survives an engine
restart, when `activeWorktrees` is empty — filtered candidates with `t.column !== "in-progress"`.

On a board whose wip lane is renamed that matched NOBODY, so the worktree read as UNOWNED and a second
task could be handed a checkout another task is live in. That is the failure mode this function exists to
prevent, and it is exactly the state after a restart.

NOT the query-filter class: the `listTasks` call here passes no `column`, so the predicate is the only
lane gate on the path. (Contrast `executor.ts`'s in-progress limbo sweep, which IS query-bounded.)

WHY IT REACHES THROUGH A PRIVATE: `findActiveWorktreeOwner` is private, and the public routes into it
(`handleBranchConflict`) need a real `BranchConflictError` and a git repo. Calling the seam directly keeps
this a test about the lane predicate instead of a git fixture — the alternative was no coverage at all,
which is what the conversion originally shipped with.

REVERT CHECK, measured: with `if (t.column !== "in-progress") continue;` restored, the RENAMED case fails
— the owner comes back `null` and the checkout reads as free. The DEFAULT case passes both ways, which is
why both are run.
*/
import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import type { Task, TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

const WORKTREE = "/tmp/worktrees/FN-OWNER";

/** A card carrying merge evidence from a previous pass, as `resetMergeStateIfNeeded` looks for. */
function mergedOnceTask(vocab: Vocabulary): Task {
  return {
    ...ownerTask(vocab),
    id: "FN-REENTER",
    column: vocab.wip,
    mergeDetails: { commitSha: "abc123" },
    mergeRetries: 1,
  } as unknown as Task;
}

function ownerTask(vocab: Vocabulary): Task {
  return {
    id: "FN-OWNER",
    title: "holds the checkout",
    description: "",
    column: vocab.wip,
    worktree: WORKTREE,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  } as unknown as Task;
}

function storeFor(seed: Task[], vocab: Vocabulary): TaskStore {
  const tasks = [...seed];
  const ir = lifecycleIr(vocab, "executor-owner-lifecycle");
  return {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    getSettings: vi.fn(async () => ({})),
    /*
    `cleanupMergeStateForReverification` writes via updateTask and then RE-READS through getTask, so the
    fake has to actually persist — a non-mutating updateTask hands the re-read a stale row and the test
    sees "nothing changed" for the wrong reason. (It did, first time round.)
    */
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const index = tasks.findIndex((t) => t.id === id);
      tasks[index] = { ...tasks[index], ...patch } as unknown as Task;
      return tasks[index];
    }),
    logEntry: vi.fn(async () => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "executor-owner-lifecycle", stepIds: [] })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "executor-owner-lifecycle", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "executor-owner-lifecycle" ? { ir } : undefined)),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

/** The private seam under test; see the header for why this is reached directly. */
function findOwner(executor: TaskExecutor, requestingTaskId: string): Promise<string | null> {
  return (executor as unknown as {
    findActiveWorktreeOwner: (worktreePath: string, requestingTaskId: string) => Promise<string | null>;
  }).findActiveWorktreeOwner(WORKTREE, requestingTaskId);
}

describe("findActiveWorktreeOwner resolves the WIP lane by ROLE, not by id", () => {
  for (const [label, vocab] of [["DEFAULT", DEFAULT_VOCAB], ["RENAMED", RENAMED_VOCAB]] as const) {
    it(`sees the durable owner of a checkout on a ${label} wip lane (${vocab.wip})`, async () => {
      const store = storeFor([ownerTask(vocab)], vocab);
      const executor = new TaskExecutor(store, "/tmp/test", {});

      // `activeWorktrees` is empty — the post-restart state, where only the durable leg can answer.
      await expect(findOwner(executor, "FN-REQUESTER")).resolves.toBe("FN-OWNER");
    });
  }

  it("does not report an owner whose card has left the wip lane on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a predicate that matched every column would satisfy both cases
    above. Same renamed board, same checkout — only the holder's lane changes.
    */
    const shipped = { ...ownerTask(RENAMED_VOCAB), column: RENAMED_VOCAB.complete } as Task;
    const store = storeFor([shipped], RENAMED_VOCAB);
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await expect(findOwner(executor, "FN-REQUESTER")).resolves.toBeNull();
  });

  it("never reports the requesting task as its own blocker", async () => {
    const store = storeFor([ownerTask(RENAMED_VOCAB)], RENAMED_VOCAB);
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await expect(findOwner(executor, "FN-OWNER")).resolves.toBeNull();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-17:20 (executor — the merge-state reset):
The second conversion in the same commit, and it needs its own differential: `resetMergeStateIfNeeded`
clears merge state when a card LEAVES a lane where a merge could have been recorded (the review and
complete roles). Keyed on `in-review`/`done`, a renamed board matched neither, so a card re-entering
execution carried STALE mergeDetails — a commit sha from a previous pass — into its next run.

Reached through the same private seam and for the same reason as above: the public route is the
`task:moved` listener, which would drag in the whole execute() path.

REVERT CHECK, measured: with `from !== "in-review" && from !== "done"` restored, the RENAMED case fails
— the task comes back with its stale `mergeDetails` intact. The DEFAULT case passes both ways.
*/
function resetMergeState(executor: TaskExecutor, task: Task, from: string): Promise<Task> {
  return (executor as unknown as {
    resetMergeStateIfNeeded: (task: Task, from: string) => Promise<Task>;
  }).resetMergeStateIfNeeded(task, from);
}

describe("resetMergeStateIfNeeded resolves the merge-bearing lanes by ROLE, not by id", () => {
  for (const [label, vocab] of [["DEFAULT", DEFAULT_VOCAB], ["RENAMED", RENAMED_VOCAB]] as const) {
    it(`clears stale merge state for a card returning from a ${label} review lane (${vocab.review})`, async () => {
      const task = mergedOnceTask(vocab);
      const store = storeFor([task], vocab);
      const executor = new TaskExecutor(store, "/tmp/test", {});

      const result = await resetMergeState(executor, task, vocab.review);

      expect(result).not.toBe(task);
      expect(result.mergeDetails?.commitSha).toBeUndefined();
    });
  }

  it("leaves merge state alone for a card returning from a lane that bears no merge on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a gate matching every column would satisfy both cases above. The
    renamed HOLD lane is a real column — just not one where a merge could have been recorded.
    */
    const task = mergedOnceTask(RENAMED_VOCAB);
    const store = storeFor([task], RENAMED_VOCAB);
    const executor = new TaskExecutor(store, "/tmp/test", {});

    const result = await resetMergeState(executor, task, RENAMED_VOCAB.hold);

    expect(result).toBe(task);
    expect(result.mergeDetails?.commitSha).toBe("abc123");
  });
});
