/*
FNXC:PlanningDependencyReseed 2026-08-04-04:30:
Production-shaped regression for reporter #3325. A real PostgreSQL TaskStore owns
the planning episode, dependency invalidation, continuation rows, refusal dedupe,
and release move. Only the planner/reviewer callback is replaced by a deterministic
function; no polling, network AI, or wall-clock waits participate.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  PLAN_REVIEW_GROUP_ID,
  type Task,
  type TaskStore,
  type WorkflowStepResult,
} from "@fusion/core";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { getPromptPath } from "../../execution/spec-staleness.js";
import { promoteHeldTask, runHoldReleaseSweep } from "../../execution/hold-release.js";
import { SelfHealingManager } from "../../self-healing.js";
import { TriageProcessor } from "../../triage.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_planning_dependency_release",
});

function planReviewPass(): WorkflowStepResult {
  return {
    workflowStepId: PLAN_REVIEW_GROUP_ID,
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    status: "passed",
    completedAt: new Date().toISOString(),
  };
}

pgDescribe("FN-8768 planning dependency release interactions", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    vi.useRealTimers();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  async function seedDependency(id: string): Promise<void> {
    await h.store().createTaskWithReservedId(
      { description: `dependency ${id}`, column: "done" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
  }

  async function seedPlannedTask(
    id: string,
    overrides: Parameters<TaskStore["updateTask"]>[1] = {},
  ): Promise<Task> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `planned ${id}`, column: "todo" },
      { taskId: id, applyDefaultWorkflowSteps: true },
    );
    const prompt = `# ${id}\n\n## Context\nReporter #3325 plan.\n\n## Steps\n\n### Step 1: Implement\n- [ ] work\n`;
    const promptPath = getPromptPath(store.getTasksDir(), id);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    await store.updateTask(id, {
      steps: [{ name: "Implement", status: "pending" }],
      status: null,
      approvedPlanFingerprint: "approved-episode",
      workflowStepResults: [planReviewPass()],
      ...overrides,
    });
    store.taskCache.delete(id);
    return store.getTask(id);
  }

  it("finalizes a persisted plan without reacquiring its PostgreSQL lifecycle lock", async () => {
    const store = h.store();
    const taskId = "FN-8998-PG";
    const prompt = [
      `# ${taskId}: Planning lifecycle lock regression`,
      "",
      "## Mission",
      "",
      "Finalize a persisted plan while the task planning lifecycle lock is held.",
      "",
      "## Steps",
      "",
      "### Step 1: Implement",
      "- [ ] Preserve the single-lock finalization invariant.",
      "",
    ].join("\n");

    await store.updateSettings({ planApprovalMode: "auto-approve-all" });
    await store.createTaskWithReservedId(
      { description: "Planning lifecycle lock regression", column: "todo" },
      { taskId, applyDefaultWorkflowSteps: true },
    );
    const promptPath = getPromptPath(store.getTasksDir(), taskId);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    await store.updateTask(taskId, { status: "planning", steps: [] });
    store.taskCache.delete(taskId);

    const task = await store.getTask(taskId);
    await expect(
      new TriageProcessor(store, h.rootDir()).recoverApprovedTask(task),
    ).resolves.toBe(true);

    store.taskCache.delete(taskId);
    const released = await store.getTask(taskId);
    const currentPlan = await store.getLatestCurrentPlanEvidence(taskId);
    const latestLock = await store.getLatestSpecLock(taskId);

    expect(released.column).toBe("todo");
    expect(released.status).toBeUndefined();
    expect(released.approvedPlanFingerprint).toEqual(expect.any(String));
    expect(currentPlan).toMatchObject({
      plan: { status: "available", contentHash: expect.any(String) },
    });
    expect(latestLock).toMatchObject({
      approvalFingerprint: released.approvedPlanFingerprint,
      currentPlanVersion: currentPlan?.version,
      currentPlanHash: currentPlan?.plan.contentHash,
    });
    await expect(store.getActiveSpecLock(taskId)).resolves.toEqual(latestLock);
  });

  it.each([
    {
      label: "dependency mutation API",
      taskId: "FN-8768-A",
      dependencyId: "FN-8768-DA",
      mutate: async (taskId: string, depId: string) => {
        await h.store().updateTaskDependencies(taskId, { operation: "add", dependency: depId });
      },
    },
    {
      label: "combined task update API",
      taskId: "FN-8768-B",
      dependencyId: "FN-8768-DB",
      mutate: async (taskId: string, depId: string) => {
        await h.store().updateTask(taskId, {
          dependencies: [depId],
          nodeId: null,
          // Stale fields from the same dashboard PATCH must not undo invalidation.
          status: null,
          approvedPlanFingerprint: "stale-writer",
          workflowStepResults: [planReviewPass()],
        });
      },
    },
  ])("$label invalidates the current approval episode", async ({ taskId, dependencyId, mutate }) => {
    await seedDependency(dependencyId);
    await seedPlannedTask(taskId);

    await mutate(taskId, dependencyId);

    h.store().taskCache.delete(taskId);
    const updated = await h.store().getTask(taskId);
    expect(updated).toMatchObject({ status: "needs-replan", dependencies: [dependencyId] });
    expect(updated.approvedPlanFingerprint).toBeUndefined();
    expect(updated.workflowStepResults).toEqual([
      expect.objectContaining({
        workflowStepId: PLAN_REVIEW_GROUP_ID,
        status: "passed",
        supersededReason: "dependency-change",
        supersededAt: expect.any(String),
      }),
    ]);
  });

  it("serializes dependency-first and lifecycle-first orderings without continuation theft", async () => {
    await seedDependency("FN-8768-DC");
    const task = await seedPlannedTask("FN-8768-C", {
      approvedPlanFingerprint: null,
      workflowStepResults: [],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60_000);

    const recover = vi.fn(async (candidate: Task) => {
      await h.store().updateTask(candidate.id, { status: "awaiting-approval" });
      return true;
    });
    const manager = new SelfHealingManager(h.store(), {
      rootDir: h.store().getRootDir(),
      recoverApprovedTriageTask: recover,
      getPlanningTaskIds: () => new Set(),
    });

    // Continuation recovery sees the same durable row but defers the exact
    // legacy persisted-plan shape to lifecycle recovery.
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    await expect(manager.recoverApprovedTriageTasks()).resolves.toBe(1);
    expect(recover).toHaveBeenCalledOnce();

    // Reset the episode, then hold the lifecycle lock while dependency mutation
    // queues behind it. The mutation cannot publish until the owner releases.
    await h.store().updateTask(task.id, { status: null, steps: [{ name: "Implement", status: "pending" }] });
    let releaseOwner!: () => void;
    const ownerReleased = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let ownerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { ownerEntered = resolve; });
    const completionOrder: string[] = [];
    const owner = h.store().withPlanningLifecycleLock(task.id, async () => {
      completionOrder.push("owner-entered");
      ownerEntered();
      await ownerReleased;
      completionOrder.push("owner-released");
    }).then(() => { completionOrder.push("owner-completed"); });
    await entered;
    const mutation = h.store().updateTaskDependencies(task.id, {
      operation: "add",
      dependency: "FN-8768-DC",
    }).then(() => { completionOrder.push("dependency-mutation-completed"); });
    expect(completionOrder).toEqual(["owner-entered"]);
    completionOrder.push("release-requested");
    releaseOwner();
    await Promise.all([owner, mutation]);
    expect(completionOrder).toEqual([
      "owner-entered",
      "release-requested",
      "owner-released",
      "owner-completed",
      "dependency-mutation-completed",
    ]);

    h.store().taskCache.delete(task.id);
    expect(await h.store().getTask(task.id)).toMatchObject({
      status: "needs-replan",
      dependencies: ["FN-8768-DC"],
    });
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
  });

  it("rechecks after acquiring the lifecycle lock when dependency mutation lands after discovery", async () => {
    await seedDependency("FN-8768-DE");
    const task = await seedPlannedTask("FN-8768-E", {
      approvedPlanFingerprint: null,
      workflowStepResults: [],
      // No parsed steps: this is an ordinary continuation-owned null episode,
      // not the conservative legacy lifecycle-recovery shape.
      steps: [],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60_000);

    const store = h.store();
    const originalLock = store.withPlanningLifecycleLock.bind(store);
    let injectDependency = true;
    store.withPlanningLifecycleLock = (async <T>(id: string, callback: () => Promise<T>) => {
      if (injectDependency) {
        injectDependency = false;
        await store.updateTaskDependencies(id, { operation: "add", dependency: "FN-8768-DE" });
      }
      return originalLock(id, callback);
    }) as typeof store.withPlanningLifecycleLock;
    try {
      const manager = new SelfHealingManager(store, { rootDir: store.getRootDir() });

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
      expect(await store.listWorkflowWorkItemsForTask(task.id)).toHaveLength(0);
      store.taskCache.delete(task.id);
      expect(await store.getTask(task.id)).toMatchObject({
        status: "needs-replan",
        dependencies: ["FN-8768-DE"],
      });
    } finally {
      store.withPlanningLifecycleLock = originalLock;
    }
  });

  it("dedupes refusal evidence by episode across sweep and promote, then force-promotes", async () => {
    await seedDependency("FN-8768-DD");
    const task = await seedPlannedTask("FN-8768-D", {
      status: "needs-replan",
      approvedPlanFingerprint: null,
      workflowStepResults: [],
    });

    const sweep = await runHoldReleaseSweep(h.store(), { now: () => Date.now() });
    expect(sweep.released).not.toContain(task.id);
    await expect(promoteHeldTask(h.store(), task.id)).resolves.toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });
    await promoteHeldTask(h.store(), task.id);

    h.store().taskCache.delete(task.id);
    let live = await h.store().getTask(task.id);
    expect(live.log?.filter((entry) => entry.action.includes("Execution dispatch refused"))).toHaveLength(1);

    // A new dependency changes the durable episode and permits one new refusal.
    await h.store().updateTaskDependencies(task.id, { operation: "add", dependency: "FN-8768-DD" });
    await promoteHeldTask(h.store(), task.id);
    h.store().taskCache.delete(task.id);
    live = await h.store().getTask(task.id);
    expect(live.log?.filter((entry) => entry.action.includes("Execution dispatch refused"))).toHaveLength(2);

    await expect(promoteHeldTask(h.store(), task.id, {}, { force: true })).resolves.toMatchObject({
      released: true,
      toColumn: "in-progress",
      forcedUnplanned: true,
    });
    h.store().taskCache.delete(task.id);
    expect((await h.store().getTask(task.id)).column).toBe("in-progress");
  });
});
