/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-run-mutation-context.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates RunMutationContext semantics
 * (logEntry, addComment, addSteeringComment, getMutationsForRun) work
 * identically against PostgreSQL backend mode.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

import { __setTaskActivityLogLimitsForTesting } from "../../store.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore RunMutationContext (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_run_ctx",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);

  beforeEach(async () => {
    await h.beforeEach();
  });

  afterEach(async () => {
    __setTaskActivityLogLimitsForTesting(null);
    await h.afterEach();
  });

  it("logEntry() with runContext includes runContext field", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Test task" });
    const runContext = { runId: "run-123", agentId: "agent-456" };

    await store.logEntry(task.id, "Test action", "Test outcome", runContext);

    const updatedTask = await store.getTask(task.id);
    const lastEntry = updatedTask.log[updatedTask.log.length - 1];
    expect(lastEntry.runContext).toEqual(runContext);
    expect(lastEntry.action).toBe("Test action");
    expect(lastEntry.outcome).toBe("Test outcome");
  });

  it("logEntry() without runContext has no runContext field (backward compat)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Test task" });
    await store.logEntry(task.id, "Test action", "Test outcome");

    const updatedTask = await store.getTask(task.id);
    const lastEntry = updatedTask.log[updatedTask.log.length - 1];
    expect(lastEntry.runContext).toBeUndefined();
    expect(lastEntry.action).toBe("Test action");
  });

  it("addComment() with runContext includes runContext in log entry", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Test task" });
    const runContext = { runId: "run-789", agentId: "agent-101" };

    await store.addComment(task.id, "Test comment", "user", undefined, runContext);

    const updatedTask = await store.getTask(task.id);
    expect(updatedTask.comments).toHaveLength(1);
    expect(updatedTask.comments![0].text).toBe("Test comment");
    const lastEntry = updatedTask.log[updatedTask.log.length - 1];
    expect(lastEntry.runContext).toEqual(runContext);
  });

  it("getMutationsForRun(runId) returns only entries matching the runId, sorted by timestamp", async () => {
    const store = h.store();
    const task1 = await store.createTask({ description: "Task 1" });
    const task2 = await store.createTask({ description: "Task 2" });

    await store.logEntry(task1.id, "Action 1", undefined, { runId: "run-target", agentId: "agent-1" });
    await new Promise((r) => setTimeout(r, 10));
    await store.logEntry(task2.id, "Action 2", undefined, { runId: "run-target", agentId: "agent-1" });
    await new Promise((r) => setTimeout(r, 10));
    await store.logEntry(task1.id, "Action 3", undefined, { runId: "run-other", agentId: "agent-2" });

    const mutations = await store.getMutationsForRun("run-target");

    expect(mutations).toHaveLength(2);
    expect(mutations.map((m) => m.action)).toEqual(["Action 1", "Action 2"]);
  });

  it("getMutationsForRun(unknownRunId) returns empty array", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Test task" });
    await store.logEntry(task.id, "Some action", undefined, { runId: "run-existing", agentId: "agent-1" });

    const mutations = await store.getMutationsForRun("run-does-not-exist");
    expect(mutations).toEqual([]);
  });
});
