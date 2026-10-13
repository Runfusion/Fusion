/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(tmpDir)` harness to the
 * PostgreSQL extension harness. `runTaskRetry` resolves its store through the
 * CLI command path (`project-context.resolveProject`), which is independent of
 * the extension store cache the harness injects — so `resolveProject` is
 * redirected to the harness's PG-backed store, and the full retry lifecycle
 * (moveTask / updateTask / getTask / logEntry) runs against real PostgreSQL
 * state instead of the removed SQLite runtime.
 *
 * FNXC:CliTests 2026-07-16-08:45:
 * FN-8102 repairs stale retry scaffolding left after the PG migration: every
 * lifecycle seed and verification read must use the initialized harness store,
 * rather than the removed `createStore()` helper.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness } from "./pg-extension-harness.js";

// `runTaskRetry` resolves its store via resolveProject() (commands/task.ts →
// project-context.ts), a separate cache from the extension store the harness
// injects. Redirect resolveProject to the harness PG store so the command path
// and the seeded task share one isolated PostgreSQL database.
const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  // FNXC:CliTests 2026-07-16-08:47: FN-8102 keeps command-finally cleanup
  // awaitable while the PG harness retains ownership of the test store lifecycle.
  closeProjectStore: closeProjectStoreMock,
  /*
  FNXC:ProjectRoutingVisibility 2026-09-23-00:12 (RUFU-269): `runTaskRetry` reaches
  `getBoardCommandContext`'s cwd-fallback branch when `resolveProject` has no answer, and that branch now
  wraps its store with the SHARED `project-context.ts` `asLocalProjectContext` (task.ts's private copy is
  gone). A double that omits the export turns the fallback into a call of `undefined`.
  */
  asLocalProjectContext: (store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    resolvedFrom: "cwd-fallback",
    store,
  }),
}));

import { runTaskRetry } from "../commands/task.js";

const pgTest = pgDescribe;

pgTest("runTaskRetry", () => {
  const h = createPgExtensionHarness("fn-task-retry");

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
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    closeProjectStoreMock.mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("retries merge-active missing-worktree session failures by clearing phantom metadata", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "missing worktree merge-active task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
      worktree: "/tmp/fusion-missing-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: FN-107 requires branchWriteOrigin provenance on every branch write; this engine-simulated fixture predates that guard.
      branchWriteOrigin: "engine" as const,
      sessionFile: "/tmp/fusion-session.json",
      steps: [{ name: "implemented", status: "done" }, { name: "fix", status: "pending" }],
      worktreeSessionRetryCount: 3,
      mergeRetries: 3,
    });

    await runTaskRetry(task.id);

    const verificationStore = h.store();
    const updated = await verificationStore.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.worktree).toBeUndefined();
    expect(updated.branch).toBeUndefined();
    expect(updated.sessionFile).toBeUndefined();
    expect(updated.worktreeSessionRetryCount).toBe(0);
    expect(updated.mergeRetries).toBe(0);
    expect(updated.steps?.[0]?.status).toBe("done");
  });

  it("rejects unrelated merge-active tasks without the missing-worktree signature", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "ordinary merge", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "ordinary merge still running",
      steps: [{ name: "implemented", status: "done" }],
    });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state/);
  });

  it("clears the deadlock auto-pause when retrying a failed task", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    expect(updated.mergeRetries).toBe(0);
  });

  /*
  FNXC:StrandedGateRetry 2026-10-13-04:40 (STAS-299 req 4 + Invariant C):
  The STAS-281 card at the CLI. Before this, `fn task retry FN-XXXX` on a card stranded by self-heal's
  FN-8492 orphan flip answered either "not in a retryable state" (the card carries no `failed`
  status — its failure is a step row) or, if the card had been re-stamped `failed`, ran the generic
  fallthrough below the stranded branch: that clears `worktree`, `branch`, `baseBranch` and
  `baseCommitSha`, i.e. it discards the branch and the approved plan to re-run a review session that
  was never asked to be re-planned. These two cases pin both halves: the shape that used to be
  refused is now retryable, and retrying it keeps the work.
  */
  const verdictlessPlanGateRow = {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    phase: "pre-merge" as const,
    source: "optional-group" as const,
    status: "failed" as const,
    reviewKind: "plan" as const,
    startedAt: "2026-09-24T00:16:39.000Z",
    output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
  };

  async function seedStrandedCard(store: ReturnType<typeof h.store>, status: "failed" | null) {
    const task = await store.createTask({
      title: "plan-review stranded in the hold lane",
      description: "test",
      column: "todo",
    });
    await store.updateTask(task.id, {
      status,
      error: status === "failed" ? "1 workflow step result(s) marked failed by self-healing (FN-8492)" : null,
      approvedPlanFingerprint: "7a73aaff",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Await the plan-review verdict", status: "pending" },
      ],
      currentStep: 1,
      worktree: "/tmp/fusion-stranded-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: branch writes need provenance; this fixture simulates an engine-written branch.
      branchWriteOrigin: "engine" as const,
      baseBranch: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workflowStepResults: [verdictlessPlanGateRow],
    });
    return task;
  }

  it("discharges a hold-lane verdict-less plan gate in place, keeping the approved plan and worktree", async () => {
    const store = h.store();
    const task = await seedStrandedCard(store, "failed");

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    // The card is not re-queued anywhere: it already sat in the lane a re-queue would target.
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    // The gate row is discharged, which is what lets Plan Review re-run as a `missing` gate.
    expect(updated.workflowStepResults ?? []).toEqual([]);
    // Invariant C: nothing that constitutes the approved work is touched.
    expect(updated.approvedPlanFingerprint).toBe("7a73aaff");
    expect(updated.steps?.map((step) => step.status)).toEqual(["done", "pending"]);
    expect(updated.currentStep).toBe(1);
    expect(updated.worktree).toBe("/tmp/fusion-stranded-worktree");
    expect(updated.branch).toBe(`fusion/${task.id}`);
    expect(updated.baseBranch).toBe("main");
    expect(updated.baseCommitSha).toBe("0123456789abcdef0123456789abcdef01234567");
    const log = (updated.log ?? []) as Array<{ action?: string }>;
    expect(log.some((entry) => entry.action?.includes("gate row(s) discharged in todo"))).toBe(true);
  });

  it("reaches the stranded cards self-heal parked before the lifecycle fix, which carried no status", async () => {
    const store = h.store();
    /* Every card stranded by this defect BEFORE the fix has this shape: hold lane, approved plan,
       failed gate row, and no card-level failure at all. Those operators had no escape hatch, which
       is what made STAS-281 stall for 2.2 days with nobody owning it. */
    const task = await seedStrandedCard(store, null);

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.workflowStepResults ?? []).toEqual([]);
    expect(updated.approvedPlanFingerprint).toBe("7a73aaff");
    expect(updated.worktree).toBe("/tmp/fusion-stranded-worktree");
  });
});
