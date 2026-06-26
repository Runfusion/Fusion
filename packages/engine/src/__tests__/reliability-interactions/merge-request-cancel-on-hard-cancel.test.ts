import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "../../project-engine.js";

describe("FN-5743 hard-cancel merge-request cutover", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "kb-fn-5743-hard-cancel-"));
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("cancels pending merge request on user in-review->todo hard-cancel", async () => {
    const task = await store.createTask({ description: "FN-5743 hard-cancel" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent" },
    });

    await store.upsertMergeRequestRecord(task.id, { state: "queued", attemptCount: 1 });
    store.setCompletionHandoffAcceptedMarker(task.id, { source: "executor:fn_task_done" });

    await store.moveTask(task.id, "todo", { moveSource: "user" });

    expect(store.getMergeRequestRecord(task.id)?.state).toBe("cancelled");
    expect(store.getCompletionHandoffAcceptedMarker(task.id)).toBeNull();
  });

  it("does not cancel merge request on engine in-review->todo rebound", async () => {
    const task = await store.createTask({ description: "FN-5743 engine rebound" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent",
      evidence: { reason: "fn_task_done", runId: "run-2", agentId: "agent" },
    });

    await store.upsertMergeRequestRecord(task.id, { state: "queued", attemptCount: 1 });
    store.setCompletionHandoffAcceptedMarker(task.id, { source: "executor:fn_task_done" });

    await store.moveTask(task.id, "todo", { moveSource: "engine" as any });

    expect(store.getMergeRequestRecord(task.id)?.state).toBe("queued");
    expect(store.getCompletionHandoffAcceptedMarker(task.id)).not.toBeNull();
  });

  it("transient merge retry uses merge-request state transitions without todo rebound", async () => {
    let state = "running";
    const fakeStore = {
      getSettings: vi.fn().mockResolvedValue({ mergeRequestContractShadowEnabled: true }),
      getMergeRequestRecord: vi.fn(() => ({ state, attemptCount: 0, lastError: null })),
      transitionMergeRequestState: vi.fn((_taskId: string, toState: string) => {
        state = toState;
      }),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn(),
    } as any;

    const retried = await (ProjectEngine.prototype as any).maybeRetryTransientMerge.call(
      { shuttingDown: false, internalEnqueueMerge: vi.fn() },
      fakeStore,
      "FN-5743",
      { id: "FN-5743", mergeTransientRetryCount: 0 },
      "lease-handoff-failed: target-not-queued",
    );

    expect(retried).toBe(true);
    expect(state).toBe("queued");
    expect(fakeStore.moveTask).not.toHaveBeenCalled();
  });
});
