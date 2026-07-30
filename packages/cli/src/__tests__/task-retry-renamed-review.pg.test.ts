/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:40 (fleet — CLI retry classifier):

`fn task retry` classified a stalled card with `task.column === "in-review"`. On a board whose
review lane is named anything else, EVERY branch that flag feeds went false — the execution-stall
branch, the merge-retry-stall branch, and the failed/stuck-killed branch — so the command reported
nothing to do and exited without retrying the exact states those flags exist to name.

The failure is silent by construction: retry is the operator's recovery path for a stuck card, so
the symptom is "the card stays stuck and the tool says it is fine", which reads as a lifecycle bug
somewhere else entirely.

Real store, real persisted workflow, driven through the real `runTaskRetry` command path — the same
posture as the sibling renamed-lane suites in core, because the defect lives in the command's
classification of hydrated state rather than in a pure helper.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import { createPgExtensionHarness } from "./pg-extension-harness.js";

const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  closeProjectStore: closeProjectStoreMock,
}));

import { runTaskRetry } from "../commands/task.js";

pgDescribe("runTaskRetry under a renamed review column", () => {
  const h = createPgExtensionHarness("fn-task-retry-renamed");

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resolveProjectMock.mockResolvedValue({
      store: h.store(),
      projectId: h.rootDir(),
      projectPath: h.rootDir(),
      projectName: "test",
      isRegistered: false,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    closeProjectStoreMock.mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  /**
   * A workflow whose review column is `checking` and which has NO `in-review` column, so a surviving
   * literal cannot match by luck. The `merge` trait carries the review role, and the IR validator
   * requires a reachable merge-class node for it, hence the merge-gate.
   */
  /**
   * The BUILTIN coding workflow with its column ids renamed — nothing else changed.
   *
   * Hand-building a four-node graph did not work and the failures were instructive: the IR validator
   * rejects an undeclared back-edge, and once declared, the transition table still did not match the
   * default board's. A hand-rolled fixture tests the fixture's shape as much as the code. Deriving
   * from the builtin guarantees the ONLY difference between the two runs is the vocabulary, which is
   * the entire differential claim this suite rests on.
   */
  async function seedRenamedWorkflow(): Promise<string> {
    const RENAME: Record<string, string> = {
      todo: "drafting",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
    };
    const rename = (id: string | undefined) => (id && RENAME[id]) ?? id;
    const builtin = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    builtin.id = "custom:cli-renamed-review";
    for (const node of builtin.nodes ?? []) node.column = rename(node.column);
    for (const column of builtin.columns ?? []) column.id = rename(column.id) as string;

    /* Prove the rename actually landed: if `checking` were absent, a surviving `in-review` literal
       would pass by accident and this suite would assert nothing. */
    const ids = (builtin.columns ?? []).map((column) => column.id);
    expect(ids).toContain("checking");
    expect(ids).not.toContain("in-review");

    const created = await h.store().createWorkflowDefinition({
      name: "Renamed Review",
      kind: "workflow",
      ir: builtin,
    } as never);
    return (created as { id: string }).id;
  }

  /**
   * A failed card resting in the board's review lane, optionally bound to a custom workflow.
   *
   * `path` walks the workflow graph rather than jumping straight to the review column: moves are
   * transition-validated, so a direct hop is rejected under BOTH vocabularies. Walking it also means
   * the card arrives the way a real one does.
   */
  async function seedFailedInReviewLane(path: readonly string[], workflowId?: string): Promise<string> {
    const store = h.store();
    const column = path[path.length - 1];
    const task = await store.createTask({
      title: "stalled in the review lane",
      description: "test",
      column: "todo",
    });
    if (workflowId) await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of path) await store.moveTask(task.id, step as never);
    await store.updateTask(task.id, { status: "failed" } as never);
    store.taskCache.delete(task.id);

    /*
    Prove the fixture before asserting on it. If the seed did not actually land the card in the
    review lane with a failed status, the retry would be a no-op for a reason that has nothing to do
    with column vocabulary, and this suite would pass while testing nothing.
    */
    const seeded = await store.getTask(task.id);
    expect(seeded.column).toBe(column);
    expect(seeded.status).toBe("failed");
    return task.id;
  }

  /** Retry is observable as the card leaving the review lane, or its failure being cleared. */
  async function retriedOutOfReview(taskId: string, reviewColumn: string): Promise<boolean> {
    await runTaskRetry(taskId);
    h.store().taskCache.delete(taskId);
    const after = await h.store().getTask(taskId);
    return after.column !== reviewColumn || after.status !== "failed";
  }

  /* Control: the default vocabulary retries. Passes before and after the fix, so a generally broken
     retry path cannot hide behind the renamed case below. */
  it("default vocabulary: a failed card in the review lane is retried", async () => {
    const id = await seedFailedInReviewLane(["in-progress", "in-review"]);

    expect(await retriedOutOfReview(id, "in-review")).toBe(true);
  });

  /*
  The defect. Before the fix `checking` failed `task.column === "in-review"`, so every stall flag was
  false and the command exited having done nothing to a card the operator asked it to rescue.
  */
  it("renamed vocabulary: a failed card in the RENAMED review lane is retried", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedFailedInReviewLane(["drafting", "building", "checking"], wf);

    expect(await retriedOutOfReview(id, "checking")).toBe(true);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-01:15 (PR #2736 review — greptile P1):
  THE TWO CLASSIFIERS MUST AGREE ON WHAT "IN REVIEW" MEANS.

  Converting only the GENERIC retry classifier split the two: on a renamed lane the generic branch
  fires while `isInReviewMissingWorktreeSessionStartFailure` (literal) does not.

  MEASURED, because the reported consequence did not reproduce. The claim was that the generic branch
  leaves `worktree`/`branch` intact so the next run repeats the failure. It does not: BOTH branches
  end with them cleared, because the backward move to the hold column clears them anyway. Reverting
  the fix leaves these cases green, so this suite does NOT prove that consequence and is not claimed
  to. It pins the outcome that matters — a missing-worktree failure in either vocabulary comes back
  retryable with no stale session metadata — and the classifiers are kept in agreement because two
  definitions of "in review" in one function is a latent split, not because a failing case was found.
  */
  async function seedMissingWorktreeFailure(path: readonly string[], workflowId?: string): Promise<string> {
    const store = h.store();
    const task = await store.createTask({
      title: "unusable worktree session start",
      description: "test",
      column: "todo",
    });
    if (workflowId) await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of path) await store.moveTask(task.id, step as never);
    await store.updateTask(task.id, {
      status: "failed",
      error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
      worktree: "/tmp/fusion-missing-worktree",
      branch: `fusion/${task.id}`,
    } as never);
    store.taskCache.delete(task.id);

    /* Prove the fixture: without the stale metadata actually present, "it was cleared" is vacuous.
       `worktree`/`branch` are the two the generic retry branch leaves ALONE, so they are exactly the
       signal that distinguishes the specialized path from it. */
    const seeded = await store.getTask(task.id);
    expect(seeded.worktree).toBe("/tmp/fusion-missing-worktree");
    expect(seeded.branch).toBe(`fusion/${task.id}`);
    return task.id;
  }

  async function retriedWithClearedSession(taskId: string): Promise<boolean> {
    await runTaskRetry(taskId);
    h.store().taskCache.delete(taskId);
    const after = await h.store().getTask(taskId);
    return !after.worktree && !after.branch;
  }

  /* Control: the default vocabulary takes the specialized branch and clears the stale session. */
  it("default vocabulary: a missing-worktree failure has its stale session metadata cleared", async () => {
    const id = await seedMissingWorktreeFailure(["in-progress", "in-review"]);

    expect(await retriedWithClearedSession(id)).toBe(true);
  });

  /* The P1. Before the fix this retried via the GENERIC branch and kept the stale metadata. */
  it("renamed vocabulary: a missing-worktree failure has its stale session metadata cleared", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedMissingWorktreeFailure(["drafting", "building", "checking"], wf);

    expect(await retriedWithClearedSession(id)).toBe(true);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-12:30 (PR #2752 review — greptile P1):
  THE GENERIC RETRY PATH — a plainly failed card outside the review lane.

  The cases above all enter through the in-review stall branches. The ordinary retry — a `failed`
  card sitting in the WIP lane — falls through to a fourth `moveTask` that my first pass missed
  because it was written with single quotes while its three siblings used double. Three of four
  converted, and the one left behind was the common path.

  Nothing automated would have caught that: the census counts comparisons and a move target has
  none, and a grep for the double-quoted form reports the file clean. So the suite now exercises the
  path by BEHAVIOUR rather than trusting that all the call sites were found.
  */
  async function seedFailedInWipLane(path: readonly string[], workflowId?: string): Promise<string> {
    const store = h.store();
    const column = path[path.length - 1];
    const task = await store.createTask({ title: "plain failure", description: "test", column: "todo" });
    if (workflowId) await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of path) await store.moveTask(task.id, step as never);
    await store.updateTask(task.id, { status: "failed" } as never);
    store.taskCache.delete(task.id);

    const seeded = await store.getTask(task.id);
    expect(seeded.column).toBe(column);
    expect(seeded.status).toBe("failed");
    return task.id;
  }

  /* Control: the generic path works under the default vocabulary. */
  it("default vocabulary: a plainly failed WIP card is retried to the hold column", async () => {
    const id = await seedFailedInWipLane(["in-progress"]);

    await runTaskRetry(id);
    h.store().taskCache.delete(id);
    expect((await h.store().getTask(id)).column).toBe("todo");
  });

  /* The P1: this threw `Invalid transition: 'building' -> 'todo'` before the fourth site moved. */
  it("renamed vocabulary: a plainly failed WIP card is retried to the board's OWN hold column", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedFailedInWipLane(["drafting", "building"], wf);

    await runTaskRetry(id);
    h.store().taskCache.delete(id);
    expect((await h.store().getTask(id)).column).toBe("drafting");
  });
});
