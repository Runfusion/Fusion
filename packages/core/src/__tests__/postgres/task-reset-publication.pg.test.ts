import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { __setResetPublicationFailureForTesting } from "../../task-store/reset-lifecycle.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:TaskReset 2026-08-28-20:50:
These PostgreSQL tests pin the reset publication boundary rather than a sequence of facade calls. A failure after continuation retirement must roll back the retired row, foreach instance deletion, and task-row reset together; success exposes a null-status, empty-plan fresh planning row only after graph cleanup and discarded-run presentation state commit together.
*/

pgDescribe("TaskStore reset publication", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_reset_publication" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedPopulatedResetState() {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    const populated = await store.updateTask(task.id, {
      column: "in-progress",
      status: "failed",
      worktree: "/tmp/owned-worktree",
      branch: "fusion/fn-reset",
      branchWriteOrigin: "engine",
      checkedOutBy: "agent-reset",
      workflowIrPin: "pin-before-reset",
      workflowStepResults: [{ workflowStepId: "plan-review", status: "failed" }],
      awaitingApprovalReason: "plan-review-replan-cap",
      size: "M",
      prInfo: { number: 239, url: "https://example.invalid/pull/239", state: "open" },
      prInfos: [{ number: 239, url: "https://example.invalid/pull/239", state: "open" }],
      tokenUsage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 30, firstUsedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), byModel: {} },
      tokenBudgetSoftAlertedAt: new Date().toISOString(),
      tokenBudgetHardAlertedAt: new Date().toISOString(),
      stepReports: [{ stepIndex: 0, summary: "Discarded report", filesChanged: [] }],
      workflowTransitionNotification: { transitionId: "transition-239", toColumn: "in-progress", createdAt: new Date().toISOString() },
    } as never);
    const continuation = await store.upsertWorkflowWorkItem({
      taskId: task.id,
      runId: `${task.id}:run:active`,
      nodeId: "execute",
      kind: "task",
      state: "running",
      leaseOwner: "executor-reset",
      leaseExpiresAt: null,
    });
    await store.saveWorkflowRunStepInstance({
      taskId: task.id,
      runId: `${task.id}:run:active`,
      foreachNodeId: "steps",
      stepIndex: 0,
      pinnedStepCount: populated.steps.length,
      currentNodeId: "step-execute",
      status: "running",
      reworkCount: 0,
      updatedAt: new Date().toISOString(),
    });
    return { store, task: populated, continuation };
  }

  it("publishes task, continuation retirement, and foreach cleanup together", async () => {
    const { store, task } = await seedPopulatedResetState();

    const reset = await store.resetTaskPublication(task.id, "todo");

    expect(reset.column).toBe("todo");
    expect(reset.status).toBeUndefined();
    expect(reset.steps).toEqual([]);
    expect(reset.size).toBeUndefined();
    expect(reset.prInfo).toBeUndefined();
    expect(reset.prInfos).toBeUndefined();
    expect(reset.tokenUsage).toBeUndefined();
    expect(reset.tokenBudgetSoftAlertedAt).toBeUndefined();
    expect(reset.tokenBudgetHardAlertedAt).toBeUndefined();
    expect(reset.stepReports ?? []).toEqual([]);
    expect(reset.workflowTransitionNotification).toBeUndefined();
    expect(reset.worktree).toBeUndefined();
    expect(reset.branch).toBeUndefined();
    expect(reset.checkedOutBy).toBeUndefined();
    expect(reset.workflowIrPin).toBeUndefined();
    expect(reset.workflowStepResults ?? []).toEqual([]);
    expect(reset.reviewState).toBeUndefined();
    expect(reset.awaitingApprovalReason).toBeUndefined();
    expect(await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(await store.hasWorkflowRunStepInstancesForTask(task.id)).toBe(false);
  });

  it("commits a description override with intake state and preserves description without options", async () => {
    const overridden = await seedPopulatedResetState();
    const resetWithOverride = await overridden.store.resetTaskPublication(
      overridden.task.id,
      "todo",
      { description: "  corrected original request  " },
    );

    expect(resetWithOverride).toMatchObject({
      column: "todo",
      description: "corrected original request",
      steps: [],
    });
    expect(resetWithOverride.status).toBeUndefined();
    const [durableOverride] = await h.layer().db.select({
      status: schema.project.tasks.status,
      steps: schema.project.tasks.steps,
    }).from(schema.project.tasks).where(eq(schema.project.tasks.id, overridden.task.id));
    expect(durableOverride).toEqual({ status: null, steps: [] });
    const persistedOverride = await overridden.store.getTask(overridden.task.id);
    expect(persistedOverride).toMatchObject({
      column: "todo",
      description: "corrected original request",
    });
    expect(persistedOverride?.status).toBeUndefined();

    const preserved = await seedPopulatedResetState();
    const resetWithoutOptions = await preserved.store.resetTaskPublication(preserved.task.id, "todo");
    expect(resetWithoutOptions.description).toBe(preserved.task.description);
  });

  it("clears workspace worktrees, acquire leases, and land intents with publication", async () => {
    const { store, task } = await seedPopulatedResetState();
    const now = new Date().toISOString();
    await store.updateTask(task.id, {
      workspaceWorktrees: { api: { worktreePath: "/tmp/fn-reset/api", branch: "fusion/fn-reset" } },
    });
    const db = h.layer().db;
    await db.insert(schema.project.workspaceCoordinationLeases).values({
      leaseKey: `${task.id}:api`, kind: "acquire", ownerTaskId: task.id, ownerNodeId: "execute",
      ownerIncarnationId: "test", status: "held", acquiredAt: now, renewedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now, updatedAt: now,
    });
    await db.insert(schema.project.workspaceLandIntents).values({
      taskId: task.id, repoRelPath: "api", remoteUrl: "https://example.invalid/api.git", integrationRef: "main",
      intendedSha: "a".repeat(40), expectedTip: "b".repeat(40), fenceRefName: "refs/fusion/test",
      fenceRefSha: "c".repeat(40), ownerTaskId: task.id, ownerNodeId: "execute", ownerIncarnationId: "test",
      fenceToken: 0n, status: "pending", createdAt: now, updatedAt: now,
    });

    const reset = await store.resetTaskPublication(task.id, "todo");

    expect(reset.column).toBe("todo");
    expect(reset.status).toBeUndefined();
    expect(reset.workspaceWorktrees).toBeUndefined();
    await expect(db.select().from(schema.project.workspaceCoordinationLeases).where(eq(schema.project.workspaceCoordinationLeases.ownerTaskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.workspaceLandIntents).where(eq(schema.project.workspaceLandIntents.taskId, task.id))).resolves.toEqual([]);
  });

  it("clears run projections while retaining operator documents, attachments, and released symbol-lock history", async () => {
    const { store, task } = await seedPopulatedResetState();
    const originalTitle = task.title;
    const originalDescription = task.description;
    const now = new Date().toISOString();
    await store.upsertTaskDocument(task.id, { key: "agent-only", content: "discard", author: "agent" });
    await store.upsertTaskDocument(task.id, { key: "operator", content: "keep", author: "user" });
    await store.upsertTaskDocument(task.id, { key: "operator", content: "agent update", author: "agent" });
    await store.updateTask(task.id, { declaredSymbols: ["src/reset.ts#freshStart"] });
    await store.acquireSymbolLocks(["src/reset.ts#freshStart"], { ownerTaskId: task.id }, 60_000);
    const db = h.layer().db;
    await db.insert(schema.project.artifacts).values([
      { id: `${task.id}-run`, type: "document", title: "run", authorId: "agent", taskId: task.id, createdAt: now, updatedAt: now },
      { id: `${task.id}-attachment`, type: "image", title: "attachment", authorId: "user", taskId: task.id, metadata: { source: "attachment" }, createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.project.currentPlanEvidence).values({ taskId: task.id, version: 1, sourceRevision: 1, sourceHash: `${task.id}-plan`, capturedAt: now, snapshot: {} });
    await db.insert(schema.project.specDriftReports).values({ taskId: task.id, reportHash: `${task.id}-drift`, executionHash: "execution", report: {}, createdAt: now });
    await db.insert(schema.project.taskVerificationRequests).values({ taskId: task.id, requestId: `${task.id}-verify`, status: "pending", profile: "default", command: "true", scope: "package", requestedBy: "agent", requestedAt: now });
    await db.insert(schema.project.unplannedExecutionBlocks).values({ taskId: task.id, episode: "episode", createdAt: now });
    await db.insert(schema.project.completionHandoffMarkers).values({ taskId: task.id, acceptedAt: now, source: "test" });
    await db.insert(schema.project.mergeQueue).values({ taskId: task.id, enqueuedAt: now });
    await db.insert(schema.project.mergeRequests).values({ taskId: task.id, state: "pending", createdAt: now, updatedAt: now });

    const reset = await store.resetTaskPublication(task.id, "todo");

    expect(reset.title).toBe(originalTitle);
    expect(reset.description).toBe(originalDescription);
    expect(reset.declaredSymbols ?? []).toEqual([]);
    expect((await db.select().from(schema.project.taskDocuments).where(eq(schema.project.taskDocuments.taskId, task.id))).map((row) => row.key)).toEqual(["operator"]);
    expect((await db.select().from(schema.project.taskDocumentRevisions).where(eq(schema.project.taskDocumentRevisions.taskId, task.id))).map((row) => row.key)).toEqual(["operator"]);
    expect(await db.select().from(schema.project.artifacts).where(eq(schema.project.artifacts.taskId, task.id))).toEqual([expect.objectContaining({ id: `${task.id}-attachment` })]);
    await expect(db.select().from(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.specDriftReports).where(eq(schema.project.specDriftReports.taskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.taskVerificationRequests).where(eq(schema.project.taskVerificationRequests.taskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.unplannedExecutionBlocks).where(eq(schema.project.unplannedExecutionBlocks.taskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.completionHandoffMarkers).where(eq(schema.project.completionHandoffMarkers.taskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.mergeQueue).where(eq(schema.project.mergeQueue.taskId, task.id))).resolves.toEqual([]);
    await expect(db.select().from(schema.project.mergeRequests).where(eq(schema.project.mergeRequests.taskId, task.id))).resolves.toEqual([]);
    expect(await db.select().from(schema.project.symbolLocks).where(eq(schema.project.symbolLocks.ownerTaskId, task.id))).toEqual([expect.objectContaining({ status: "released" })]);
  });

  it("rolls back every publication participant after workflow mutation failure", async () => {
    const { store, task, continuation } = await seedPopulatedResetState();
    const now = new Date().toISOString();
    await store.upsertTaskDocument(task.id, { key: "agent-only", content: "must survive rollback", author: "agent" });
    await h.layer().db.insert(schema.project.artifacts).values({ id: `${task.id}-rollback-artifact`, type: "document", title: "rollback", authorId: "agent", taskId: task.id, createdAt: now, updatedAt: now });
    await store.updateTask(task.id, { workspaceWorktrees: { api: { worktreePath: "/tmp/fn-reset/api", branch: "fusion/fn-reset" } } });
    await h.layer().db.insert(schema.project.workspaceCoordinationLeases).values({
      leaseKey: `${task.id}:rollback`, kind: "acquire", ownerTaskId: task.id, ownerNodeId: "execute",
      ownerIncarnationId: "test", status: "held", acquiredAt: now, renewedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now, updatedAt: now,
    });
    await h.layer().db.insert(schema.project.workspaceLandIntents).values({
      taskId: task.id, repoRelPath: "api", remoteUrl: "https://example.invalid/api.git", integrationRef: "main",
      intendedSha: "a".repeat(40), expectedTip: "b".repeat(40), fenceRefName: "refs/fusion/test",
      fenceRefSha: "c".repeat(40), ownerTaskId: task.id, ownerNodeId: "execute", ownerIncarnationId: "test",
      fenceToken: 0n, status: "pending", createdAt: now, updatedAt: now,
    });
    const [beforeFailure] = await h.layer().db.select({
      column: schema.project.tasks.column,
      status: schema.project.tasks.status,
      worktree: schema.project.tasks.worktree,
    }).from(schema.project.tasks).where(eq(schema.project.tasks.id, task.id));
    let injected = false;
    const release = __setResetPublicationFailureForTesting(() => {
      injected = true;
      throw new Error("injected reset publication failure");
    });
    try {
      await expect(store.resetTaskPublication(task.id, "todo")).rejects.toThrow("injected reset publication failure");
    } finally {
      release();
    }

    expect(injected).toBe(true);
    const [durable] = await h.layer().db.select({
      column: schema.project.tasks.column,
      status: schema.project.tasks.status,
      worktree: schema.project.tasks.worktree,
    }).from(schema.project.tasks).where(eq(schema.project.tasks.id, task.id));
    expect(durable).toEqual(beforeFailure);
    expect((await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).find((item) => item.id === continuation.id)?.state).toBe("running");
    expect(await store.hasWorkflowRunStepInstancesForTask(task.id)).toBe(true);
    expect(await h.layer().db.select().from(schema.project.taskDocuments).where(eq(schema.project.taskDocuments.taskId, task.id))).toEqual([expect.objectContaining({ key: "agent-only" })]);
    expect(await h.layer().db.select().from(schema.project.artifacts).where(eq(schema.project.artifacts.taskId, task.id))).toEqual([expect.objectContaining({ id: `${task.id}-rollback-artifact` })]);
    expect(await h.layer().db.select().from(schema.project.workspaceCoordinationLeases).where(eq(schema.project.workspaceCoordinationLeases.ownerTaskId, task.id))).toEqual([expect.objectContaining({ leaseKey: `${task.id}:rollback` })]);
    expect(await h.layer().db.select().from(schema.project.workspaceLandIntents).where(eq(schema.project.workspaceLandIntents.taskId, task.id))).toEqual([expect.objectContaining({ repoRelPath: "api" })]);
  });
});
