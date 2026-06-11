import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "@fusion/core";
import { publishWorkflowRecoveryEvent } from "../workflow-recovery-events.js";

describe("workflow recovery events", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "kb-workflow-recovery-events-"));
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global"));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("publishes typed recovery facts as runnable recovery work", async () => {
    const task = await store.createTask({ description: "recovery task" });

    const event = publishWorkflowRecoveryEvent(store, {
      taskId: task.id,
      kind: "transient-merge-failure",
      source: "self-healing",
      reason: "socket hang up",
      now: "2026-06-09T00:00:00.000Z",
    });
    const duplicate = publishWorkflowRecoveryEvent(store, {
      taskId: task.id,
      kind: "transient-merge-failure",
      source: "self-healing",
      reason: "socket hang up",
      now: "2026-06-09T00:00:01.000Z",
    });

    expect(duplicate.id).toBe(event.id);
    expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["recovery"] })).toEqual([
      expect.objectContaining({
        runId: `recovery:transient-merge-failure:${task.id}`,
        nodeId: "recovery-router",
        kind: "recovery",
        state: "runnable",
        blockedReason: "transient-merge-failure",
        lastError: "socket hang up",
      }),
    ]);
  });

  it("leaves lastError empty for informational recovery events without a reason", async () => {
    const task = await store.createTask({ description: "already landed" });

    publishWorkflowRecoveryEvent(store, {
      taskId: task.id,
      kind: "already-landed",
      source: "self-healing",
      now: "2026-06-09T00:00:00.000Z",
    });

    expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["recovery"] })).toEqual([
      expect.objectContaining({
        blockedReason: "already-landed",
        lastError: null,
      }),
    ]);
  });

  it("publishes a fresh recovery work item when the previous event is terminal", async () => {
    const task = await store.createTask({ description: "recurring recovery" });

    const first = publishWorkflowRecoveryEvent(store, {
      taskId: task.id,
      kind: "transient-merge-failure",
      source: "self-healing",
      reason: "socket hang up",
      now: "2026-06-09T00:00:00.000Z",
    });
    store.transitionWorkflowWorkItem(first.id, "succeeded", {
      now: "2026-06-09T00:00:01.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const second = publishWorkflowRecoveryEvent(store, {
      taskId: task.id,
      kind: "transient-merge-failure",
      source: "self-healing",
      reason: "socket hang up again",
      now: "2026-06-09T00:00:02.000Z",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.runId).toMatch(new RegExp(`^recovery:transient-merge-failure:${task.id}:`));
    expect(store.listWorkflowWorkItemsForTask(task.id, { kinds: ["recovery"] })).toEqual([
      expect.objectContaining({
        id: first.id,
        state: "succeeded",
      }),
      expect.objectContaining({
        id: second.id,
        state: "runnable",
        lastError: "socket hang up again",
      }),
    ]);
  });
});
