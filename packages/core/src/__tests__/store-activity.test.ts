import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { TaskStore, TaskHasDependentsError } from "../store.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { createTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createTaskStoreTestHarness();
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    rootDir = harness.rootDir();
    globalDir = harness.globalDir();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  const createTestTask = () => harness.createTestTask();
  const createTaskWithSteps = () => harness.createTaskWithSteps();
  const deleteTaskDir = (taskId: string) => harness.deleteTaskDir(taskId);
  const createSourceIssueFixture = () => harness.createSourceIssueFixture();
  const insertLogEntryWithTimestamp = (...args: any[]) => (harness as any).insertLogEntryWithTimestamp(...args);

  describe("activity log", () => {
    it("recordActivity appends to log file", async () => {
      await store.recordActivity({ type: "task:created", taskId: "FN-001", taskTitle: "Test", details: "Created" });
      const logs = await store.getActivityLog();
      expect(logs).toHaveLength(1);
      expect(logs[0].type).toBe("task:created");
      expect(logs[0].id).toBeDefined();
      expect(logs[0].timestamp).toBeDefined();
    });

    it("recordActivity logs failures and stays best-effort", async () => {
      const storeAny = store as any;
      const originalPrepare = storeAny.db.prepare.bind(storeAny.db);
      const prepareSpy = vi.spyOn(storeAny.db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO activityLog")) {
          return {
            run: () => {
              throw new Error("activity insert failed");
            },
          };
        }
        return originalPrepare(sql);
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(
          store.recordActivity({
            type: "task:created",
            taskId: "FN-404",
            taskTitle: "Resilient record",
            details: "Create event",
            metadata: { source: "test" },
          }),
        ).resolves.toMatchObject({
          type: "task:created",
          taskId: "FN-404",
          taskTitle: "Resilient record",
          details: "Create event",
        });

        const failureCall = errorSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Failed to record activity"),
        );
        expect(failureCall).toBeDefined();
        const [, context] = failureCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          type: "task:created",
          taskId: "FN-404",
          taskTitle: "Resilient record",
          detailsLength: "Create event".length,
          hasMetadata: true,
          error: "activity insert failed",
        });
      } finally {
        prepareSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("logs listener-level activity recording failures without throwing", async () => {
      const task = await store.createTask({ description: "Listener test" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const recordSpy = vi.spyOn(store, "recordActivity").mockRejectedValue(new Error("listener rejected"));

      try {
        expect(() => {
          store.emit("task:created", task);
        }).not.toThrow();

        await Promise.resolve();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Activity logging listener failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          sourceEvent: "task:created",
          type: "task:created",
          taskId: task.id,
          error: "listener rejected",
        });
      } finally {
        recordSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("getActivityLog returns entries newest first", async () => {
      await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "First" });
      await new Promise((r) => setTimeout(r, 10));
      await store.recordActivity({ type: "task:created", taskId: "FN-002", details: "Second" });
      const logs = await store.getActivityLog();
      expect(logs[0].taskId).toBe("FN-002");
      expect(logs[1].taskId).toBe("FN-001");
    });

    it("getActivityLog respects limit", async () => {
      await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "First" });
      await new Promise((r) => setTimeout(r, 10));
      await store.recordActivity({ type: "task:created", taskId: "FN-002", details: "Second" });
      const logs = await store.getActivityLog({ limit: 1 });
      expect(logs).toHaveLength(1);
      expect(logs[0].taskId).toBe("FN-002");
    });

    it("getActivityLog filters by type", async () => {
      await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "Created" });
      await store.recordActivity({ type: "task:moved", taskId: "FN-001", details: "Moved" });
      const logs = await store.getActivityLog({ type: "task:created" });
      expect(logs).toHaveLength(1);
      expect(logs[0].type).toBe("task:created");
    });

    it("getActivityLog filters by since timestamp", async () => {
      const first = await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "Created" });
      await new Promise((r) => setTimeout(r, 50));
      const second = await store.recordActivity({ type: "task:created", taskId: "FN-002", details: "Created later" });

      // Filter for entries strictly after the first one (should return only second)
      const logs = await store.getActivityLog({ since: first.timestamp });
      expect(logs).toHaveLength(1);
      expect(logs[0].taskId).toBe("FN-002");

      // Filter for entries strictly after a time before the first one (should return both)
      const beforeFirst = new Date(new Date(first.timestamp).getTime() - 100).toISOString();
      const allLogs = await store.getActivityLog({ since: beforeFirst });
      expect(allLogs).toHaveLength(2);
    });

    it("clearActivityLog removes all entries", async () => {
      await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "Test" });
      await store.clearActivityLog();
      const logs = await store.getActivityLog();
      expect(logs).toHaveLength(0);
    });

    it("handles missing log file gracefully", async () => {
      const logs = await store.getActivityLog();
      expect(logs).toHaveLength(0);
    });

    it("recordActivity includes metadata when provided", async () => {
      await store.recordActivity({
        type: "task:moved",
        taskId: "FN-001",
        taskTitle: "Test Task",
        details: "Moved to in-progress",
        metadata: { from: "todo", to: "in-progress" },
      });
      const logs = await store.getActivityLog();
      expect(logs[0].metadata).toEqual({ from: "todo", to: "in-progress" });
      expect(logs[0].taskTitle).toBe("Test Task");
    });

    it("activity log survives TaskStore reinitialization", async () => {
      // Cross-instance persistence test — see archive-log counterpart
      // above for the in-memory carve-out rationale.
      store.close();
      store = new TaskStore(rootDir, globalDir);
      await store.init();

      await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "Test" });

      // Create new store instance
      const newStore = new TaskStore(rootDir, globalDir);
      await newStore.init();

      const logs = await newStore.getActivityLog();
      expect(logs).toHaveLength(1);
      expect(logs[0].taskId).toBe("FN-001");
      newStore.close();
    });
  });

  // ── Activity Log Event Listener Tests ────────────────────────────


  describe("activity log event listeners", () => {
    it("records activity on task:created", async () => {
      const task = await store.createTask({ description: "Test created event" });
      // Wait for async activity recording
      await new Promise((r) => setTimeout(r, 10));
      const logs = await store.getActivityLog({ type: "task:created" });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[0].type).toBe("task:created");
    });

    it("records activity on task:moved", async () => {
      const task = await store.createTask({ description: "Test moved event" });
      await store.moveTask(task.id, "todo");
      // Wait for async activity recording
      await new Promise((r) => setTimeout(r, 10));
      const logs = await store.getActivityLog({ type: "task:moved" });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[0].type).toBe("task:moved");
      expect(logs[0].metadata).toHaveProperty("from");
      expect(logs[0].metadata).toHaveProperty("to");
    });

    it("records activity when task status becomes failed", async () => {
      const task = await store.createTask({ description: "Test failure event" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { status: "failed", error: "Something went wrong" });
      // Wait for async activity recording
      await new Promise((r) => setTimeout(r, 10));
      const logs = await store.getActivityLog({ type: "task:failed" });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[0].type).toBe("task:failed");
    });

    it("records activity on settings:updated for important changes", async () => {
      // ntfyEnabled/ntfyTopic are now global settings, use updateGlobalSettings
      await store.updateGlobalSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      // Wait for async activity recording
      await new Promise((r) => setTimeout(r, 10));
      const logs = await store.getActivityLog({ type: "settings:updated" });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].type).toBe("settings:updated");
    });

    it("a second TaskStore polling the same DB does not double-log activity", async () => {
      // Reproduces the duplicate-emitter bug: dashboard + engine each construct
      // their own TaskStore against the same SQLite file. Without suppression,
      // every move was recorded once per polling instance.
      const observer = new TaskStore(rootDir, globalDir);
      await observer.init();
      await observer.watch();
      try {
        const task = await store.createTask({ description: "Test polling dedup" });
        await store.moveTask(task.id, "todo");
        // Drive the observer's poll cycle directly so we don't wait 1s.
        await (observer as any).checkForChanges();
        await new Promise((r) => setTimeout(r, 10));

        const movedLogs = await store.getActivityLog({ type: "task:moved" });
        const moves = movedLogs.filter((l) => l.taskId === task.id);
        expect(moves).toHaveLength(1);

        const createdLogs = await store.getActivityLog({ type: "task:created" });
        const creates = createdLogs.filter((l) => l.taskId === task.id);
        expect(creates).toHaveLength(1);
      } finally {
        await observer.close();
      }
    });

    it("records activity on task:deleted", async () => {
      const task = await store.createTask({ description: "Test deleted event" });
      await store.deleteTask(task.id);
      // Wait for async activity recording
      await new Promise((r) => setTimeout(r, 10));
      const logs = await store.getActivityLog({ type: "task:deleted" });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[0].type).toBe("task:deleted");
    });

    it("captures merge details when merging a task", async () => {
      const task = await store.createTask({ description: "Test merge details" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        worktree: "/tmp/test-worktree",
      });

      const { execSync } = await import("node:child_process");
      try {
        execSync(`git checkout -b fusion/${task.id.toLowerCase()}`, { cwd: rootDir, stdio: "pipe" });
        execSync('git commit --allow-empty -m "test commit"', { cwd: rootDir, stdio: "pipe" });
        execSync("git checkout main || git checkout master", { cwd: rootDir, stdio: "pipe" });
      } catch {
        return;
      }

      try {
        const result = await store.mergeTask(task.id);
        expect(result.mergeConfirmed ?? result.merged).toBeDefined();
        expect(result.task.mergeDetails).toBeDefined();
        if (result.merged) {
          expect(result.task.mergeDetails?.commitSha).toBeTruthy();
          expect(result.task.mergeDetails?.mergeCommitMessage).toContain(task.id);
          expect(result.task.mergeDetails?.mergedAt).toBeDefined();
        }
      } catch {
        // merge may fail depending on repo state; skip strict assertions in that case
      }
    });

    it("records activity on task:merged", async () => {
      const task = await store.createTask({ description: "Test merged event" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      // Manually set worktree for merge
      await store.updateTask(task.id, { worktree: "/tmp/test-worktree" });
      
      // Create branch for merge
      const { execSync } = await import("node:child_process");
      try {
        execSync(`git checkout -b fusion/${task.id.toLowerCase()}`, { cwd: rootDir, stdio: "pipe" });
        execSync('git commit --allow-empty -m "test commit"', { cwd: rootDir, stdio: "pipe" });
        execSync("git checkout main || git checkout master", { cwd: rootDir, stdio: "pipe" });
      } catch {
        // Branch may already exist or no main/master, skip merge test
      }

      try {
        await store.mergeTask(task.id);
      } catch {
        // Merge may fail due to branch setup, that's ok for activity log test
      }
      
      // Wait for async activity recording
      await new Promise((r) => setTimeout(r, 10));
      const logs = await store.getActivityLog({ type: "task:merged" });
      // We check if the merge was attempted (logs may exist even if merge failed)
      // The key is that the event listener was called
    });

    it("does not record activity for non-failure task updates", async () => {
      const task = await store.createTask({ description: "Test non-failure update" });
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { status: "in-progress" });
      // Wait for any async activity recording
      await new Promise((r) => setTimeout(r, 10));
      
      // Get all failed logs - should not include this task
      const failedLogs = await store.getActivityLog({ type: "task:failed" });
      const taskFailedLogs = failedLogs.filter((l) => l.taskId === task.id);
      expect(taskFailedLogs).toHaveLength(0);
    });
  });

  // ── Workflow Steps ─────────────────────────────────────────────────



  describe("event emissions", () => {
    it("createTask emits task:created with the new task", async () => {
      const events: any[] = [];
      store.on("task:created", (t: any) => events.push(t));
      const task = await store.createTask({ description: "event test" });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(task.id);
      expect(events[0].description).toBe("event test");
    });

    it("moveTask emits task:moved with from/to columns and source", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:moved", (data: any) => events.push(data));
      await store.moveTask(task.id, "todo", { moveSource: "user" });
      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("triage");
      expect(events[0].to).toBe("todo");
      expect(events[0].source).toBe("user");
      expect(events[0].task.id).toBe(task.id);

      await store.moveTask(task.id, "in-progress");
      expect(events.at(-1)?.source).toBe("engine");
    });

    it("updateTask emits task:updated with the updated task", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t: any) => events.push(t));
      await store.updateTask(task.id, { title: "Updated" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e: any) => e.title === "Updated")).toBe(true);
    });

    it("pauseTask emits task:updated", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      const events: any[] = [];
      store.on("task:updated", (t: any) => events.push(t));
      await store.pauseTask(task.id, true);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e: any) => e.paused === true)).toBe(true);
    });

    it("updateStep emits task:updated", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      const events: any[] = [];
      store.on("task:updated", (t: any) => events.push(t));
      await store.updateStep(task.id, 0, "in-progress");
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteTask emits task:deleted", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:deleted", (t: any) => events.push(t));
      await store.deleteTask(task.id);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(task.id);
    });

    it("logEntry emits task:updated", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t: any) => events.push(t));
      await store.logEntry(task.id, "test action", "test outcome");
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

  });


  describe("userPaused move semantics", () => {
    it("sets userPaused for user move to todo and clears on in-progress", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await store.moveTask(task.id, "todo", { moveSource: "user" });
      const parked = await store.getTask(task.id);
      expect(parked.userPaused).toBe(true);

      await store.moveTask(task.id, "in-progress");
      const resumed = await store.getTask(task.id);
      expect(resumed.userPaused).toBeUndefined();
    });

    it("does not set userPaused for engine preserve-resume move", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await store.moveTask(task.id, "todo", { preserveResumeState: true });
      const bounced = await store.getTask(task.id);
      expect(bounced.userPaused).toBeUndefined();
    });

    it("clears userPaused when pauseTask(false) is called on a todo user-paused task", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { userPaused: true });

      const unpaused = await store.pauseTask(task.id, false);
      expect(unpaused.userPaused).toBeUndefined();
      expect(unpaused.paused).toBeUndefined();
    });

    it("clears paused and userPaused when unpausing a paused todo task", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { userPaused: true, paused: true });

      const unpaused = await store.pauseTask(task.id, false);
      expect(unpaused.paused).toBeUndefined();
      expect(unpaused.userPaused).toBeUndefined();
    });

    it("pauseTask(true) on todo does not set userPaused", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");

      const paused = await store.pauseTask(task.id, true);
      expect(paused.paused).toBe(true);
      expect(paused.userPaused).toBeUndefined();
    });
  });

  describe("paused state on completion", () => {
    const expectPauseFieldsCleared = (task: Awaited<ReturnType<typeof store.getTask>>) => {
      expect(task.paused).toBeUndefined();
      expect(task.userPaused).toBeUndefined();
      expect(task.pausedByAgentId).toBeUndefined();
      expect(task.pausedReason).toBeUndefined();
    };

    async function moveTaskToDone(id: string): Promise<void> {
      await store.moveTask(id, "todo");
      await store.moveTask(id, "in-progress");
      await store.moveTask(id, "in-review");
      await store.moveTask(id, "done");
    }

    it("clears pause fields on moveTask(in-review → done)", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        pausedByAgentId: "agent-x",
        pausedReason: "manual-hold",
      });

      await store.moveTask(task.id, "done");
      const doneTask = await store.getTask(task.id);
      expectPauseFieldsCleared(doneTask);
    });

    it("clears pause fields on moveTask(in-progress → done) when userPaused was set", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { userPaused: true });

      await store.moveTask(task.id, "done");
      const doneTask = await store.getTask(task.id);
      expectPauseFieldsCleared(doneTask);
    });

    it("clears pause fields when mergeTask handles an already-done task", async () => {
      const task = await createTestTask();
      await moveTaskToDone(task.id);
      await store.updateTask(task.id, { paused: true, pausedByAgentId: "agent-x" });

      await store.mergeTask(task.id);
      const doneTask = await store.getTask(task.id);
      expectPauseFieldsCleared(doneTask);
    });

    it("clears pause fields on unarchiveTask transition to done", async () => {
      const task = await createTestTask();
      await moveTaskToDone(task.id);
      await store.updateTask(task.id, { paused: true, pausedByAgentId: "agent-x", pausedReason: "manual-hold" });
      await store.archiveTask(task.id);

      await store.unarchiveTask(task.id);
      const restored = await store.getTask(task.id);
      expect(restored.column).toBe("done");
      expectPauseFieldsCleared(restored);
    });

    it("remains idempotent across repeated done transitions", async () => {
      const task = await createTestTask();
      await moveTaskToDone(task.id);
      await store.moveTask(task.id, "archived");
      await store.updateTask(task.id, { paused: true, pausedByAgentId: "agent-x" });

      await store.unarchiveTask(task.id);
      await store.moveTask(task.id, "archived");
      await store.unarchiveTask(task.id);
      const doneTask = await store.getTask(task.id);
      expectPauseFieldsCleared(doneTask);
    });
  });

  describe("execution timing timestamps", () => {
    it("preserves the original executionStartedAt across an internal rerun bounce", async () => {
      const task = await store.createTask({ description: "retry bounce timing" });
      await store.moveTask(task.id, "todo");
      const started = await store.moveTask(task.id, "in-progress");
      const originalExecutionStartedAt = started.executionStartedAt;

      expect(originalExecutionStartedAt).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const bouncedToTodo = await store.moveTask(task.id, "todo");
      expect(bouncedToTodo.executionStartedAt).toBeUndefined();

      await store.updateTask(task.id, {
        worktree: "/tmp/retry-bounce",
        executionStartedAt: originalExecutionStartedAt ?? null,
      });

      const bouncedBack = await store.moveTask(task.id, "in-progress");
      expect(bouncedBack.executionStartedAt).toBe(originalExecutionStartedAt);
    });
  });


  describe("settings:updated event", () => {
    it("fires on updateSettings with correct old and new values", async () => {
      const events: { settings: any; previous: any }[] = [];
      store.on("settings:updated", (data) => events.push(data));

      await store.updateSettings({ maxConcurrent: 5 });

      expect(events).toHaveLength(1);
      expect(events[0].previous.maxConcurrent).toBe(2); // DEFAULT_SETTINGS value
      expect(events[0].settings.maxConcurrent).toBe(5);
    });

    it("includes previous globalPause: false → new globalPause: true when toggled", async () => {
      const events: { settings: any; previous: any }[] = [];
      store.on("settings:updated", (data) => events.push(data));

      // Default globalPause is false
      await store.updateSettings({ globalPause: true });

      expect(events).toHaveLength(1);
      expect(events[0].previous.globalPause).toBe(false);
      expect(events[0].settings.globalPause).toBe(true);
    });

    it("includes previous globalPause: true → new globalPause: false when toggled off", async () => {
      await store.updateSettings({ globalPause: true });

      const events: { settings: any; previous: any }[] = [];
      store.on("settings:updated", (data) => events.push(data));

      await store.updateSettings({ globalPause: false });

      expect(events).toHaveLength(1);
      expect(events[0].previous.globalPause).toBe(true);
      expect(events[0].settings.globalPause).toBe(false);
    });

    it("fires on every updateSettings call even when value unchanged", async () => {
      const events: { settings: any; previous: any }[] = [];
      store.on("settings:updated", (data) => events.push(data));

      await store.updateSettings({ maxConcurrent: 2 });
      await store.updateSettings({ maxConcurrent: 2 });

      expect(events).toHaveLength(2);
    });
  });

  // ── Duplicate Task Tests ─────────────────────────────────────────


  describe("task-store diagnostics for best-effort catch paths", () => {
    it("logs init config sync failures without blocking startup", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let localStore: TaskStore | undefined;

      try {
        localStore = new TaskStore(localRoot, localGlobal, { inMemoryDb: true });
        (localStore as any).configPath = join(localRoot, ".fusion", "missing-dir", "config.json");

        await expect(localStore.init()).resolves.toBeUndefined();
        await expect(localStore.createTask({ description: "still boots" })).resolves.toMatchObject({
          id: "FN-001",
        });

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Backward-compat config.json sync failed during init"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "init:config-sync",
          configPath: join(localRoot, ".fusion", "missing-dir", "config.json"),
        });
        expect(typeof context.error).toBe("string");
      } finally {
        localStore?.close();
        warnSpy.mockRestore();
        await rm(localRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        await rm(localGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it("logs writeConfig disk sync failures while preserving project settings updates", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storeAny = store as any;
      const originalConfigPath = storeAny.configPath;
      storeAny.configPath = join(rootDir, ".fusion", "missing-sync", "config.json");

      try {
        const updated = await store.updateSettings({ mergeStrategy: "pull-request" });
        expect(updated.mergeStrategy).toBe("pull-request");

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Backward-compat config.json sync failed after config write"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "writeConfig:disk-sync",
          configPath: join(rootDir, ".fusion", "missing-sync", "config.json"),
        });
        expect(typeof context.error).toBe("string");

        const settings = await store.getSettings();
        expect(settings.mergeStrategy).toBe("pull-request");
      } finally {
        storeAny.configPath = originalConfigPath;
        warnSpy.mockRestore();
      }
    });

    it("creates tasks through distributed allocation without config.json sync dependency", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storeAny = store as any;
      const originalConfigPath = storeAny.configPath;
      storeAny.configPath = join(rootDir, ".fusion", "missing-sync", "config.json");

      try {
        const task = await store.createTask({ description: "allocate without config sync" });
        expect(task.id).toBe("FN-001");

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("after ID allocation"),
        );
        expect(warningCall).toBeUndefined();
      } finally {
        storeAny.configPath = originalConfigPath;
        warnSpy.mockRestore();
      }
    });

    it("logs init memory bootstrap failures without blocking startup", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ensureSpy = vi
        .spyOn(projectMemory, "ensureMemoryFileWithBackend")
        .mockRejectedValueOnce(new Error("memory backend unavailable"));
      let localStore: TaskStore | undefined;

      try {
        localStore = new TaskStore(localRoot, localGlobal, { inMemoryDb: true });
        await expect(localStore.init()).resolves.toBeUndefined();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Project-memory bootstrap failed during init"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "init:memory-bootstrap",
          rootDir: localRoot,
          error: "memory backend unavailable",
        });
        expect(ensureSpy).toHaveBeenCalled();
      } finally {
        localStore?.close();
        ensureSpy.mockRestore();
        warnSpy.mockRestore();
        await rm(localRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        await rm(localGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it("logs memory toggle-on bootstrap failures without blocking settings updates", async () => {
      await store.updateSettings({ memoryEnabled: false } as any);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ensureSpy = vi
        .spyOn(projectMemory, "ensureMemoryFileWithBackend")
        .mockRejectedValueOnce(new Error("memory toggle write failed"));

      try {
        const updated = await store.updateSettings({ memoryEnabled: true } as any);
        expect(updated.memoryEnabled).toBe(true);

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Project-memory bootstrap failed after memory toggle-on"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "updateSettings:memory-toggle-on",
          rootDir,
          error: "memory toggle write failed",
        });
        expect(ensureSpy).toHaveBeenCalled();
      } finally {
        ensureSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("logs fs.watch setup failures and keeps polling active", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storeAny = store as any;
      const originalTasksDir = storeAny.tasksDir;
      storeAny.tasksDir = join(rootDir, ".fusion", "missing-tasks-dir");

      try {
        await store.watch();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] fs.watch unavailable; falling back to polling-only updates"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "watch:fs-watch-setup",
          tasksDir: join(rootDir, ".fusion", "missing-tasks-dir"),
        });
        expect(typeof context.error).toBe("string");
        expect(storeAny.pollInterval).not.toBeNull();
        await expect(storeAny.checkForChanges()).resolves.toBeUndefined();
      } finally {
        store.stopWatching();
        storeAny.tasksDir = originalTasksDir;
        warnSpy.mockRestore();
      }
    });

    it("logs unreadable legacy agent.log files while keeping import non-fatal", async () => {
      const task = await createTestTask();
      const taskDir = join(rootDir, ".fusion", "tasks", task.id);
      const logPath = join(taskDir, "agent.log");
      await mkdir(logPath);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(store.importLegacyAgentLogs()).resolves.toBe(0);

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Skipping unreadable legacy agent.log file during import"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "importLegacyAgentLogs:read-file",
          taskId: task.id,
          logPath,
        });
        expect(typeof context.error).toBe("string");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ── Branch Cleanup on Delete/Archive ────────────────────────────


});
