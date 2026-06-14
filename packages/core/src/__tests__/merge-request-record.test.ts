import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-merge-request-record-test-"));
}

describe("TaskStore merge request record + completion handoff marker", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTask(): Promise<string> {
    const task = await store.createTask({ description: "merge request test" });
    return task.id;
  }

  it("creates merge-request and marker tables on fresh schema", () => {
    const db = store.getDatabase();
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('merge_requests', 'completion_handoff_markers') ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tableRows).toEqual([{ name: "completion_handoff_markers" }, { name: "merge_requests" }]);
    expect(db.getSchemaVersion()).toBe(115);
  });

  it("upserts merge request records", async () => {
    const taskId = await createTask();
    const created = store.upsertMergeRequestRecord(taskId, {
      state: "queued",
      now: "2026-05-30T00:00:00.000Z",
    });
    expect(created).toMatchObject({ taskId, state: "queued", attemptCount: 0, lastError: null });

    const updated = store.upsertMergeRequestRecord(taskId, {
      state: "manual-required",
      now: "2026-05-30T00:00:01.000Z",
      attemptCount: 2,
      lastError: "waiting for user",
    });
    expect(updated).toMatchObject({ taskId, state: "manual-required", attemptCount: 2, lastError: "waiting for user" });
  });

  it("supports valid merge-request transitions", async () => {
    const taskId = await createTask();
    store.upsertMergeRequestRecord(taskId, { state: "queued", now: "2026-05-30T00:00:00.000Z" });

    expect(store.transitionMergeRequestState(taskId, "running", { now: "2026-05-30T00:00:01.000Z" }).state).toBe("running");
    expect(store.transitionMergeRequestState(taskId, "retrying", { now: "2026-05-30T00:00:02.000Z", attemptCount: 1 }).state).toBe("retrying");
    expect(store.transitionMergeRequestState(taskId, "queued", { now: "2026-05-30T00:00:03.000Z" }).state).toBe("queued");
    expect(store.transitionMergeRequestState(taskId, "running", { now: "2026-05-30T00:00:04.000Z" }).state).toBe("running");
    expect(store.transitionMergeRequestState(taskId, "succeeded", { now: "2026-05-30T00:00:05.000Z" }).state).toBe("succeeded");
  });

  it("projects merge request states onto workflow work items", async () => {
    const cases = [
      { mergeState: "queued", workState: "runnable", kind: "merge" },
      { mergeState: "running", workState: "running", kind: "merge" },
      { mergeState: "retrying", workState: "retrying", kind: "merge" },
      { mergeState: "manual-required", workState: "manual-required", kind: "manual-hold" },
      { mergeState: "succeeded", workState: "succeeded", kind: "merge" },
      { mergeState: "exhausted", workState: "exhausted", kind: "merge" },
      { mergeState: "cancelled", workState: "cancelled", kind: "merge" },
    ] as const;

    for (const { mergeState, workState, kind } of cases) {
      const taskId = await createTask();
      store.upsertMergeRequestRecord(taskId, {
        state: mergeState,
        attemptCount: 3,
        lastError: mergeState === "manual-required" ? "needs human" : "last failure",
        now: "2026-05-30T00:00:00.000Z",
      });

      const item = store.projectMergeRequestToWorkflowWorkItem(taskId, {
        now: "2026-05-30T00:00:01.000Z",
      });

      expect(item).toMatchObject({
        runId: `merge-request:${taskId}`,
        taskId,
        nodeId: "builtin.merge.request",
        kind,
        state: workState,
        attempt: 3,
      });
    }
  });

  it("projects merge requests idempotently across restart-style replays", async () => {
    const taskId = await createTask();
    store.upsertMergeRequestRecord(taskId, {
      state: "retrying",
      attemptCount: 2,
      lastError: "network reset",
      now: "2026-05-30T00:00:00.000Z",
    });

    const first = store.projectMergeRequestToWorkflowWorkItem(taskId, { now: "2026-05-30T00:00:01.000Z" });
    const second = store.projectMergeRequestToWorkflowWorkItem(taskId, { now: "2026-05-30T00:00:02.000Z" });

    expect(second?.id).toBe(first?.id);
    expect(store.listWorkflowWorkItemsForTask(taskId, { kinds: ["merge"] })).toHaveLength(1);
    expect(second).toMatchObject({ state: "retrying", attempt: 2, lastError: "network reset" });
  });

  it("cancels stale manual-hold projection when the same merge request succeeds", async () => {
    const taskId = await createTask();
    store.upsertMergeRequestRecord(taskId, {
      state: "manual-required",
      attemptCount: 1,
      lastError: "needs human",
      now: "2026-05-30T00:00:00.000Z",
    });

    const hold = store.projectMergeRequestToWorkflowWorkItem(taskId, { now: "2026-05-30T00:00:01.000Z" });
    store.upsertMergeRequestRecord(taskId, {
      state: "succeeded",
      attemptCount: 1,
      lastError: null,
      now: "2026-05-30T00:00:02.000Z",
    });
    const merge = store.projectMergeRequestToWorkflowWorkItem(taskId, { now: "2026-05-30T00:00:03.000Z" });

    expect(merge).toMatchObject({ kind: "merge", state: "succeeded" });
    expect(store.getWorkflowWorkItem(hold?.id ?? "")).toMatchObject({
      kind: "manual-hold",
      state: "cancelled",
      lastError: "superseded-by-merge-request-projection",
    });
    expect(store.listWorkflowWorkItemsForTask(taskId).filter((item) => item.state !== "cancelled")).toEqual([
      expect.objectContaining({ id: merge?.id, kind: "merge", state: "succeeded" }),
    ]);
  });

  it("rejects invalid merge-request transitions", async () => {
    const taskId = await createTask();
    store.upsertMergeRequestRecord(taskId, { state: "queued" });

    expect(() => store.transitionMergeRequestState(taskId, "succeeded")).toThrow(
      `Invalid merge request state transition for ${taskId}: queued -> succeeded`,
    );
  });

  it("sets and clears completion handoff marker", async () => {
    const taskId = await createTask();
    const marker = store.setCompletionHandoffAcceptedMarker(taskId, {
      acceptedAt: "2026-05-30T00:00:00.000Z",
      source: "executor:fn_task_done",
    });
    expect(marker).toEqual({
      taskId,
      acceptedAt: "2026-05-30T00:00:00.000Z",
      source: "executor:fn_task_done",
    });

    expect(store.getCompletionHandoffAcceptedMarker(taskId)).toEqual(marker);
    store.clearCompletionHandoffAcceptedMarker(taskId);
    expect(store.getCompletionHandoffAcceptedMarker(taskId)).toBeNull();
  });

  it("cancels merge request and clears handoff marker on user hard-cancel from in-review to todo", async () => {
    const taskId = await createTask();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-test" },
    });

    store.upsertMergeRequestRecord(taskId, { state: "queued", attemptCount: 1, lastError: "pending" });
    store.setCompletionHandoffAcceptedMarker(taskId, { source: "executor:fn_task_done" });

    await store.moveTask(taskId, "todo", { moveSource: "user" });

    expect(store.getMergeRequestRecord(taskId)?.state).toBe("cancelled");
    expect(store.getCompletionHandoffAcceptedMarker(taskId)).toBeNull();
  });

  it("cancels active workflow merge work on user hard-cancel from in-review to todo", async () => {
    const taskId = await createTask();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-test" },
    });
    store.setCompletionHandoffAcceptedMarker(taskId, { source: "executor:fn_task_done" });
    const mergeWork = store.upsertWorkflowWorkItem({
      runId: "run-merge",
      taskId,
      nodeId: "builtin.merge.request",
      kind: "merge",
      state: "running",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-05-30T00:05:00.000Z",
    });

    await store.moveTask(taskId, "todo", { moveSource: "user" });

    expect(store.getWorkflowWorkItem(mergeWork.id)).toMatchObject({
      state: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "cancelled-by-user-hard-cancel",
    });
  });

  it("creates idempotent workflow merge work during completion handoff", async () => {
    const taskId = await createTask();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");

    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-handoff", agentId: "agent-test" },
      now: "2026-05-30T00:00:00.000Z",
    });
    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-handoff", agentId: "agent-test" },
      now: "2026-05-30T00:00:01.000Z",
    });

    expect(store.listWorkflowWorkItemsForTask(taskId, { kinds: ["merge"] })).toEqual([
      expect.objectContaining({
        runId: "run-handoff",
        taskId,
        nodeId: "merge-gate",
        kind: "merge",
        state: "runnable",
      }),
    ]);
  });

  it("cancels previous active handoff work when a re-handoff uses a new run id", async () => {
    const taskId = await createTask();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");

    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-handoff-1", agentId: "agent-test" },
      now: "2026-05-30T00:00:00.000Z",
    });
    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-handoff-2", agentId: "agent-test" },
      now: "2026-05-30T00:00:01.000Z",
    });

    expect(store.listWorkflowWorkItemsForTask(taskId, { kinds: ["merge"] })).toEqual([
      expect.objectContaining({
        runId: "run-handoff-1",
        state: "cancelled",
        lastError: "superseded-by-completion-handoff",
      }),
      expect.objectContaining({
        runId: "run-handoff-2",
        state: "runnable",
      }),
    ]);
  });

  it("cancels opposite handoff kind when autoMerge flips between handoffs", async () => {
    const taskId = await createTask();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");

    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-merge", agentId: "agent-test" },
      now: "2026-05-30T00:00:00.000Z",
    });
    await store.updateTask(taskId, { autoMerge: false });
    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-manual", agentId: "agent-test" },
      now: "2026-05-30T00:00:01.000Z",
    });

    expect(store.listWorkflowWorkItemsForTask(taskId)).toEqual([
      expect.objectContaining({
        runId: "run-merge",
        kind: "merge",
        state: "cancelled",
        lastError: "superseded-by-completion-handoff",
      }),
      expect.objectContaining({
        runId: "run-manual",
        kind: "manual-hold",
        state: "manual-required",
      }),
    ]);
  });

  it("does not reset running handoff work to runnable on same-run replay", async () => {
    const taskId = await createTask();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");

    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-handoff", agentId: "agent-test" },
      now: "2026-05-30T00:00:00.000Z",
    });
    const [mergeWork] = store.listWorkflowWorkItemsForTask(taskId, { kinds: ["merge"] });
    store.transitionWorkflowWorkItem(mergeWork.id, "running", {
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-05-30T00:05:00.000Z",
      now: "2026-05-30T00:00:01.000Z",
    });

    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-handoff", agentId: "agent-test" },
      now: "2026-05-30T00:00:02.000Z",
    });

    expect(store.getWorkflowWorkItem(mergeWork.id)).toMatchObject({
      state: "running",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-05-30T00:05:00.000Z",
    });
  });

  it("creates manual hold workflow work instead of merge work when autoMerge is false", async () => {
    const taskId = await createTask();
    await store.updateTask(taskId, { autoMerge: false });
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");

    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-test",
      evidence: { reason: "fn_task_done", runId: "run-manual", agentId: "agent-test" },
    });

    expect(store.listWorkflowWorkItemsForTask(taskId)).toEqual([
      expect.objectContaining({
        runId: "run-manual",
        taskId,
        nodeId: "merge-manual-hold",
        kind: "manual-hold",
        state: "manual-required",
        blockedReason: "autoMerge:false",
      }),
    ]);
  });
});
