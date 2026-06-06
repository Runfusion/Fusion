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
    expect(db.getSchemaVersion()).toBe(112);
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
});
