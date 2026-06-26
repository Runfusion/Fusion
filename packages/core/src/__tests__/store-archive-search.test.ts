import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentStore } from "../agent-store.js";
import { TaskStore } from "../store.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore Archive and Search", () => {
  const harness = createSharedTaskStoreTestHarness();
  let store: TaskStore;

  beforeAll(harness.beforeAll);

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(harness.afterAll);

  describe("archiveTask", () => {
    it("archives tasks from every live column and emits the real source column", async () => {
      const liveColumns = ["triage", "todo", "in-progress", "in-review", "done"] as const;

      for (const column of liveColumns) {
        const task = await store.createTask({ description: `Archive from ${column}` });
        if (column === "todo") {
          await store.moveTask(task.id, "todo");
        } else if (column === "in-progress") {
          await store.moveTask(task.id, "todo");
          await store.moveTask(task.id, "in-progress");
        } else if (column === "in-review") {
          await store.moveTask(task.id, "todo");
          await store.moveTask(task.id, "in-progress");
          await store.moveTask(task.id, "in-review");
        } else if (column === "done") {
          await store.moveTask(task.id, "todo");
          await store.moveTask(task.id, "in-progress");
          await store.moveTask(task.id, "in-review");
          await store.moveTask(task.id, "done");
        }

        const events: any[] = [];
        store.on("task:moved", (data) => events.push(data));
        const archived = await store.archiveTask(task.id, false);

        expect(archived.column).toBe("archived");
        expect(archived.preArchiveColumn).toBe(column);
        expect(events).toHaveLength(1);
        expect(events[0].from).toBe(column);
        expect(events[0].to).toBe("archived");
      }
    });

    it("archives a non-done task with cleanup enabled", async () => {
      const task = await store.createTask({ description: "Cleanup archive from todo" });
      await store.moveTask(task.id, "todo");

      const archived = await store.archiveTask(task.id, true);

      expect(archived.column).toBe("archived");
      expect(archived.preArchiveColumn).toBe("todo");
    });

    it("adds log entry 'Task archived'", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id);

      expect(archived.log.some((l) => l.action === "Task archived")).toBe(true);
    });

    it("emits task:moved event with correct from/to columns", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const events: any[] = [];
      store.on("task:moved", (data) => events.push(data));

      await store.archiveTask(task.id, false);

      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("done");
      expect(events[0].to).toBe("archived");
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.archiveTask(task.id, false);
      const fetched = await store.getTask(task.id);

      expect(fetched.column).toBe("archived");
    });

    it("throws error when task is already archived", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.archiveTask(task.id, false);

      await expect(store.archiveTask(task.id)).rejects.toThrow("already archived");
    });

    it("reports clean not-found when no DB row or task.json exists", async () => {
      await expect(store.archiveTask("FN-7067")).rejects.toThrow("Task FN-7067 not found");
      await expect(store.archiveTask("FN-7067")).rejects.not.toThrow(/ENOENT/);
    });

    it("updates columnMovedAt timestamp", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const beforeArchive = (await store.getTask(task.id)).columnMovedAt;

      await new Promise((r) => setTimeout(r, 10));

      const archived = await store.archiveTask(task.id);

      expect(archived.columnMovedAt).not.toBe(beforeArchive);
      expect(new Date(archived.columnMovedAt!).getTime()).toBeGreaterThan(new Date(beforeArchive!).getTime());
    });
  });

  describe("logEntry on archived tasks", () => {
    it("rejects logEntry on cleanup-archived task with archived error", async () => {
      const task = await store.createTask({ description: "Cleanup archive log test" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, true);

      await expect(store.logEntry(task.id, "should fail")).rejects.toThrow(/archived/i);
      await expect(store.logEntry(task.id, "should fail")).rejects.not.toThrow(/not found/i);
    });

    it("rejects logEntry on non-cleanup archived task with archived error", async () => {
      const task = await store.createTask({ description: "Non-cleanup archive log test" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.logEntry(task.id, "should fail")).rejects.toThrow(/archived/i);
    });

    it("rejects logEntry with runContext on cleanup-archived task", async () => {
      const task = await store.createTask({ description: "Cleanup archive runContext log test" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, true);

      await expect(
        store.logEntry(task.id, "should fail", "outcome", { runId: "run-1", agentId: "agent-1" }),
      ).rejects.toThrow(/archived/i);
    });
  });

  describe("unarchiveTask", () => {
    it("unarchives to the pre-archive column, downgrading active execution columns to todo", async () => {
      const todoTask = await store.createTask({ description: "Todo round trip" });
      await store.moveTask(todoTask.id, "todo");
      await store.archiveTask(todoTask.id, false);
      await expect(store.unarchiveTask(todoTask.id)).resolves.toMatchObject({ column: "todo" });

      const inProgressTask = await store.createTask({ description: "In progress round trip" });
      await store.moveTask(inProgressTask.id, "todo");
      await store.moveTask(inProgressTask.id, "in-progress");
      await store.archiveTask(inProgressTask.id, false);
      await expect(store.unarchiveTask(inProgressTask.id)).resolves.toMatchObject({ column: "todo" });
    });

    it("falls back to done for legacy archives without a pre-archive column", async () => {
      const task = await store.createTask({ description: "Legacy archive" });
      await store.archiveTask(task.id, false);
      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      const raw = await readFile(join(dir, "task.json"), "utf-8");
      const parsed = JSON.parse(raw);
      delete parsed.preArchiveColumn;
      await writeFile(join(dir, "task.json"), JSON.stringify(parsed));

      const unarchived = await store.unarchiveTask(task.id);

      expect(unarchived.column).toBe("done");
    });

    it("adds log entry 'Task unarchived'", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      const unarchived = await store.unarchiveTask(task.id);

      expect(unarchived.log.some((l) => l.action === "Task unarchived")).toBe(true);
    });

    it("emits task:moved event with correct from/to columns", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      const events: any[] = [];
      store.on("task:moved", (data) => events.push(data));

      await store.unarchiveTask(task.id);

      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("archived");
      expect(events[0].to).toBe("done");
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await store.unarchiveTask(task.id);
      const fetched = await store.getTask(task.id);

      expect(fetched.column).toBe("done");
    });

    it("throws error when task is not in 'archived' column", async () => {
      const task = await store.createTask({ description: "Test task" });
      // Task starts in triage, not archived

      await expect(store.unarchiveTask(task.id)).rejects.toThrow("must be in 'archived'");
    });

    it("clears transient fields when unarchiving (FN-985 regression)", async () => {
      // Simulate a task that completed normally and was archived,
      // but somehow accumulated stale transient state.
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // After reaching done, inject stale transient fields via updateTask
      // (simulating state that could leak through if transient clearing was incomplete)
      await store.updateTask(task.id, {
        status: "failed",
        error: "Something went wrong",
        worktree: "/tmp/old-worktree",
        blockedBy: "FN-999",
        recoveryRetryCount: 3,
        nextRecoveryAt: new Date(Date.now() + 86400000).toISOString(),
      });

      // Archive the task with stale state
      await store.archiveTask(task.id, false);

      // Unarchive — should clear all transient fields
      const unarchived = await store.unarchiveTask(task.id);

      expect(unarchived.column).toBe("done");
      expect(unarchived.status).toBeUndefined();
      expect(unarchived.error).toBeUndefined();
      expect(unarchived.worktree).toBeUndefined();
      expect(unarchived.blockedBy).toBeUndefined();
      expect(unarchived.recoveryRetryCount).toBeUndefined();
      expect(unarchived.nextRecoveryAt).toBeUndefined();
    });
  });

  describe("archiveAllDone", () => {
    it("archives multiple done tasks", async () => {
      const task1 = await store.createTask({ description: "Test task 1" });
      const task2 = await store.createTask({ description: "Test task 2" });
      const task3 = await store.createTask({ description: "Test task 3" });

      // Move all to done
      for (const task of [task1, task2, task3]) {
        await store.moveTask(task.id, "todo");
        await store.moveTask(task.id, "in-progress");
        await store.moveTask(task.id, "in-review");
        await store.moveTask(task.id, "done");
      }

      const archived = await store.archiveAllDone();

      expect(archived).toHaveLength(3);
      expect(archived.every((t) => t.column === "archived")).toBe(true);
    });

    it("returns empty array when no done tasks exist", async () => {
      const result = await store.archiveAllDone();

      expect(result).toEqual([]);
    });

    it("emits task:moved event for each archived task", async () => {
      const task1 = await store.createTask({ description: "Test task 1" });
      const task2 = await store.createTask({ description: "Test task 2" });

      for (const task of [task1, task2]) {
        await store.moveTask(task.id, "todo");
        await store.moveTask(task.id, "in-progress");
        await store.moveTask(task.id, "in-review");
        await store.moveTask(task.id, "done");
      }

      const events: any[] = [];
      store.on("task:moved", (data) => events.push(data));

      await store.archiveAllDone();

      expect(events).toHaveLength(2);
      expect(events.every((e) => e.from === "done" && e.to === "archived")).toBe(true);
    });

    it("does not affect tasks in other columns", async () => {
      const doneTask = await store.createTask({ description: "Done task" });
      await store.moveTask(doneTask.id, "todo");
      await store.moveTask(doneTask.id, "in-progress");
      await store.moveTask(doneTask.id, "in-review");
      await store.moveTask(doneTask.id, "done");

      const todoTask = await store.createTask({ description: "Todo task" });
      await store.moveTask(todoTask.id, "todo");

      const inProgressTask = await store.createTask({ description: "In progress task" });
      await store.moveTask(inProgressTask.id, "todo");
      await store.moveTask(inProgressTask.id, "in-progress");

      await store.archiveAllDone();

      const fetchedTodo = await store.getTask(todoTask.id);
      const fetchedInProgress = await store.getTask(inProgressTask.id);

      expect(fetchedTodo.column).toBe("todo");
      expect(fetchedInProgress.column).toBe("in-progress");
    });

    it("archives only done tasks when mixed columns exist", async () => {
      const doneTask1 = await store.createTask({ description: "Done task 1" });
      const doneTask2 = await store.createTask({ description: "Done task 2" });
      const todoTask = await store.createTask({ description: "Todo task" });

      for (const task of [doneTask1, doneTask2]) {
        await store.moveTask(task.id, "todo");
        await store.moveTask(task.id, "in-progress");
        await store.moveTask(task.id, "in-review");
        await store.moveTask(task.id, "done");
      }

      await store.moveTask(todoTask.id, "todo");

      const archived = await store.archiveAllDone();

      expect(archived).toHaveLength(2);
      expect(archived.map((t) => t.id).sort()).toEqual([doneTask1.id, doneTask2.id].sort());
    });
  });


  describe("cleanupArchivedTasks", () => {
    it("writes compact entry to archive DB with compact agent log", async () => {
      // This test asserts the archive.db file exists on disk, which the
      // shared in-memory store can't satisfy.
      await harness.useIsolatedStore();
      store = harness.store();

      // Create and archive a task
      const task = await store.createTask({ description: "Test cleanup", title: "Cleanup Task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      // Add an agent log entry before archive; compact archive mode should
      // preserve a bounded snapshot, not the legacy task.log payload.
      await store.appendAgentLog(task.id, "Test agent log", "text");
      await store.archiveTask(task.id, false);

      const cleaned = await store.cleanupArchivedTasks();
      expect(cleaned).toContain(task.id);

      // Read from store's archive API
      const entry = await store.findInArchive(task.id);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(task.id);
      expect(entry!.title).toBe("Cleanup Task");
      expect(entry!.description).toBe("Test cleanup");
      expect(entry!.column).toBe("archived");
      expect(entry!.log).toHaveLength(1);
      expect(entry!.log[0].action).toBe("Task archived");
      expect(entry!.agentLogMode).toBe("compact");
      expect(entry!.agentLogSummary).toContain("Agent log entries: 1");
      expect(entry!.agentLogSnapshot).toHaveLength(1);
      expect(entry).not.toHaveProperty("agentLogFull");
      const archivedDetail = await store.getTask(task.id);
      expect(archivedDetail.column).toBe("archived");
      expect(existsSync(join(harness.rootDir(), ".fusion", "archive.db"))).toBe(true);
    });

    it("removes task directory after archiving", async () => {
      const task = await store.createTask({ description: "Test dir removal" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(true);

      await store.cleanupArchivedTasks();

      expect(existsSync(dir)).toBe(false);
    });

    it("skips already-cleaned-up tasks (idempotent)", async () => {
      const task = await store.createTask({ description: "Test idempotent" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      const cleaned1 = await store.cleanupArchivedTasks();
      expect(cleaned1).toContain(task.id);

      const cleaned2 = await store.cleanupArchivedTasks();
      expect(cleaned2).toHaveLength(0);
    });

    it("preserves task metadata in archive entry", async () => {
      const task = await store.createTask({
        description: "Test metadata",
        title: "Metadata Task",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Add some metadata via updateTask
      await store.updateTask(task.id, {
        reviewLevel: 2,
        size: "M",
      });

      // Add an attachment (metadata only, no content)
      await store.addAttachment(task.id, "test.txt", Buffer.from("test"), "text/plain");

      await store.archiveTask(task.id, false);
      await store.cleanupArchivedTasks();

      // Read from store's archive API
      const entry = await store.findInArchive(task.id);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(task.id);
      expect(entry!.title).toBe("Metadata Task");
      expect(entry!.size).toBe("M");
      expect(entry!.reviewLevel).toBe(2);
      expect(entry!.attachments).toHaveLength(1);
      expect(entry!.attachments![0].originalName).toBe("test.txt");
    });

    it("honors archiveAgentLogMode none", async () => {
      await store.updateSettings({ archiveAgentLogMode: "none" });
      const task = await store.createTask({ description: "No agent log archive" });
      await store.appendAgentLog(task.id, "Should not be archived", "text");
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.archiveTask(task.id);

      const entry = await store.findInArchive(task.id);
      expect(entry?.agentLogMode).toBe("none");
      expect(entry?.agentLogSummary).toBeUndefined();
      expect(entry?.agentLogSnapshot).toBeUndefined();
      expect(entry?.agentLogFull).toBeUndefined();
    });

    it("honors archiveAgentLogMode full", async () => {
      await store.updateSettings({ archiveAgentLogMode: "full" });
      const task = await store.createTask({ description: "Full agent log archive" });
      await store.appendAgentLog(task.id, "First full entry", "text");
      await store.appendAgentLog(task.id, "Second full entry", "tool", "Read file", "executor");
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.archiveTask(task.id);

      const entry = await store.findInArchive(task.id);
      expect(entry?.agentLogMode).toBe("full");
      expect(entry?.agentLogSummary).toContain("Agent log entries: 2");
      expect(entry?.agentLogFull).toHaveLength(2);
      expect(entry?.agentLogSnapshot).toBeUndefined();
    });
  });

  describe("readArchiveLog", () => {
    it("returns empty array when archive DB has no tasks", async () => {
      const entries = await store.readArchiveLog();
      expect(entries).toEqual([]);
    });

    it("returns parsed entries from archive DB", async () => {
      const task = await store.createTask({ description: "Test read" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);
      await store.cleanupArchivedTasks();

      const entries = await store.readArchiveLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(task.id);
      expect(entries[0].description).toBe("Test read");
    });

    it("handles multiple entries in archive DB", async () => {
      // Archive and cleanup task 1
      const task1 = await store.createTask({ description: "Task 1" });
      await store.moveTask(task1.id, "todo");
      await store.moveTask(task1.id, "in-progress");
      await store.moveTask(task1.id, "in-review");
      await store.moveTask(task1.id, "done");
      await store.archiveTask(task1.id);
      await store.cleanupArchivedTasks();

      // Archive and cleanup task 2
      const task2 = await store.createTask({ description: "Task 2" });
      await store.moveTask(task2.id, "todo");
      await store.moveTask(task2.id, "in-progress");
      await store.moveTask(task2.id, "in-review");
      await store.moveTask(task2.id, "done");
      await store.archiveTask(task2.id);
      await store.cleanupArchivedTasks();

      const entries = await store.readArchiveLog();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.id).sort()).toEqual([task1.id, task2.id].sort());
    });
  });

  describe("findInArchive", () => {
    it("returns undefined when task not in archive", async () => {
      const entry = await store.findInArchive("KB-999");
      expect(entry).toBeUndefined();
    });

    it("returns archive entry for specific task", async () => {
      const task = await store.createTask({ description: "Test find" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const entry = await store.findInArchive(task.id);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(task.id);
      expect(entry!.description).toBe("Test find");
    });

    it("keeps comments searchable from the archive database while excluding task logs", async () => {
      const task = await store.createTask({ description: "Archived search body" });
      await store.addComment(task.id, "needle-comment", "tester");
      await store.logEntry(task.id, "needle-log-only");
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.archiveTaskAndCleanup(task.id);

      const commentMatches = await store.searchTasks("needle-comment", { includeArchived: true });
      expect(commentMatches.map((match) => match.id)).toContain(task.id);

      const logMatches = await store.searchTasks("needle-log-only", { includeArchived: true });
      expect(logMatches.map((match) => match.id)).not.toContain(task.id);
    });
  });

  describe("unarchiveTask with restore", () => {
    it("restores missing task from archive DB", async () => {
      const task = await store.createTask({ description: "Test restore" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);

      // Unarchive should restore from archive
      const unarchived = await store.unarchiveTask(task.id);
      expect(unarchived.column).toBe("done");
      expect(unarchived.description).toBe("Test restore");

      // Directory should be recreated
      expect(existsSync(dir)).toBe(true);
    });

    it("works normally when task directory exists", async () => {
      const task = await store.createTask({ description: "Test normal" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      // Note: NOT calling cleanupArchivedTasks, so directory exists

      const unarchived = await store.unarchiveTask(task.id);
      expect(unarchived.column).toBe("done");
    });

    it("restored task has correct column (done) and preserved metadata", async () => {
      const task = await store.createTask({
        description: "Test metadata preserve",
        title: "Preserved Task",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      // Set metadata via updateTask
      await store.updateTask(task.id, { size: "L", reviewLevel: 2 });
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const unarchived = await store.unarchiveTask(task.id);
      expect(unarchived.column).toBe("done");
      expect(unarchived.title).toBe("Preserved Task");
      expect(unarchived.size).toBe("L");
      expect(unarchived.reviewLevel).toBe(2);
      expect(unarchived.description).toBe("Test metadata preserve");
    });

    it("throws error when task directory missing and not in archive", async () => {
      // Create a fake archived task by manually moving column
      const task = await store.createTask({ description: "Not in archive" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      (store as any).archiveDb.delete(task.id);

      // Delete directory without archiving
      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });

      await expect(store.unarchiveTask(task.id)).rejects.toThrow("not found in archive");
    });

    it("adds log entry for restore action", async () => {
      const task = await store.createTask({ description: "Test restore log" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const unarchived = await store.unarchiveTask(task.id);
      expect(unarchived.log.some((l) => l.action === "Task restored from archive")).toBe(true);
      expect(unarchived.log.some((l) => l.action === "Task unarchived")).toBe(true);
    });

    it("recreates PROMPT.md after restore", async () => {
      const task = await store.createTask({ description: "Test prompt restore" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      await store.unarchiveTask(task.id);

      // Verify PROMPT.md was recreated
      const detail = await store.getTask(task.id);
      expect(detail.prompt).toContain(task.id);
      expect(detail.prompt).toContain("Test prompt restore");
    });

    it("recreates attachments directory (empty) after restore", async () => {
      const task = await store.createTask({ description: "Test attach restore" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Add an attachment
      await store.addAttachment(task.id, "test.txt", Buffer.from("test"), "text/plain");

      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);

      await store.unarchiveTask(task.id);

      // Directory should exist with empty attachments folder
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "attachments"))).toBe(true);
    });
  });

  describe("archiveTask with cleanup", () => {
    it("archiveTask(true) archives and cleans up immediately", async () => {
      const task = await store.createTask({ description: "Immediate cleanup" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id, true);
      expect(archived.column).toBe("archived");

      // Directory should be gone immediately
      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);

      // Should be in archive DB
      const entry = await store.findInArchive(task.id);
      expect(entry).toBeDefined();
      expect(entry!.description).toBe("Immediate cleanup");
    });

    it("archiveTaskAndCleanup is convenience method", async () => {
      const task = await store.createTask({ description: "Convenience method" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTaskAndCleanup(task.id);
      expect(archived.column).toBe("archived");

      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);
    });

    it("archiveTask(false) preserves directory for explicit non-cleanup archives", async () => {
      const task = await store.createTask({ description: "No cleanup" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id, false);
      expect(archived.column).toBe("archived");

      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(true);
    });

    it("default cleanup parameter removes active task storage", async () => {
      const task = await store.createTask({ description: "Default cleanup" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id); // No cleanup param
      expect(archived.column).toBe("archived");

      // Directory should be removed by default
      const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);
    });

    it("archiveTask clears stale linked agent assignments", async () => {
      await harness.useIsolatedStore();
      store = harness.store();

      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();

      try {
        const task = await store.createTask({ description: "Archive clears links" });
        await store.moveTask(task.id, "todo");
        await store.moveTask(task.id, "in-progress");
        await store.moveTask(task.id, "in-review");
        await store.moveTask(task.id, "done");

        const agent = await agentStore.createAgent({ name: "Archive watcher", role: "executor" });
        await agentStore.assignTask(agent.id, task.id);

        await store.archiveTask(task.id, false);

        const updatedAgent = await agentStore.getAgent(agent.id);
        expect(updatedAgent?.taskId).toBeUndefined();
      } finally {
        agentStore.close();
      }
    });
  });

  describe("archive log persistence", () => {
    it("archive log survives TaskStore reinitialization", async () => {
      // Cross-instance persistence test — beforeEach creates an in-memory
      // store, but this test verifies disk persistence. Swap to a
      // disk-backed store before doing any work so newStore (also
      // disk-backed) can read what the first instance wrote.
      await harness.useIsolatedStore();
      store = harness.store();

      const task = await store.createTask({ description: "Survival test" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      // Create new store instance
      const newStore = new TaskStore(harness.rootDir(), harness.globalDir());
      await newStore.init();

      const entries = await newStore.readArchiveLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(task.id);
      expect(entries[0].description).toBe("Survival test");
      newStore.close();
    });
  });

  // ── Activity Log Tests ───────────────────────────────────────────


describe("searchTasks", () => {
  it("searches tasks by ID", async () => {
    const task1 = await store.createTask({ description: "First task" });
    const task2 = await store.createTask({ description: "Second task" });

    const results = await store.searchTasks("FN-001");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("FN-001");
    expect(results.some((t) => t.id === "FN-002")).toBe(false);
  });

  it("searches tasks by title", async () => {
    await store.createTask({ title: "Fix login bug", description: "Login issue" });
    await store.createTask({ title: "Add dashboard feature", description: "New UI" });

    const results = await store.searchTasks("dashboard");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Add dashboard feature");
  });

  it("searches tasks by description", async () => {
    await store.createTask({ description: "Fix the login button on the homepage" });
    await store.createTask({ description: "Update the settings page layout" });

    const results = await store.searchTasks("homepage");

    expect(results).toHaveLength(1);
    expect(results[0].description).toContain("homepage");
  });

  it("supports slim search results without loading task logs", async () => {
    const uniqueTerm = `slimsearchpayload${Date.now()}`;
    const task = await store.createTask({ description: `Slim search payload ${uniqueTerm}` });
    await store.logEntry(task.id, "heavy log entry that should not appear in slim search");

    const fullResults = await store.searchTasks(uniqueTerm);
    const slimResults = await store.searchTasks(uniqueTerm, { slim: true });
    const full = fullResults.find((result) => result.id === task.id)!;
    const slim = slimResults.find((result) => result.id === task.id)!;

    expect(full.log.length).toBeGreaterThan(0);
    expect(slim.id).toBe(task.id);
    expect(slim.log).toEqual([]);
  });

  it("can exclude archived tasks from search results", async () => {
    const uniqueTerm = `archivedsearchpayload${Date.now()}`;
    const task = await store.createTask({ description: `Archived search payload ${uniqueTerm}` });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.moveTask(task.id, "done");
    await store.archiveTask(task.id);

    const withArchived = await store.searchTasks(uniqueTerm);
    const withoutArchived = await store.searchTasks(uniqueTerm, { includeArchived: false });

    expect(withArchived.some((result) => result.id === task.id)).toBe(true);
    expect(withoutArchived.some((result) => result.id === task.id)).toBe(false);
  });

  it("searches tasks by comment text", async () => {
    const task = await store.createTask({ description: "A task" });
    // Add a comment containing a unique word
    await store.addComment(task.id, "Need to prioritize the xylophone implementation", "tester");

    const results = await store.searchTasks("xylophone");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(task.id);
  });

  it("is case insensitive", async () => {
    await store.createTask({ title: "UPPERCASE SEARCH TEST", description: "Testing case insensitivity" });

    const results = await store.searchTasks("uppercase");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("UPPERCASE SEARCH TEST");
  });

  it("falls back to listTasks for empty query", async () => {
    await store.createTask({ description: "Task 1" });
    await store.createTask({ description: "Task 2" });

    const results = await store.searchTasks("");
    const allTasks = await store.listTasks();

    expect(results).toHaveLength(allTasks.length);
  });

  it("falls back to listTasks for whitespace-only query", async () => {
    await store.createTask({ description: "Task 1" });

    const results = await store.searchTasks("   ");

    expect(results).toHaveLength(1);
  });

  it("uses OR semantics for multi-word queries", async () => {
    await store.createTask({ title: "Fix login", description: "Button issues" });
    await store.createTask({ title: "Add dashboard", description: "New features" });

    const results = await store.searchTasks("login dashboard");

    expect(results).toHaveLength(2);
  });

  it("returns empty array for non-existent query", async () => {
    await store.createTask({ description: "Regular task description" });

    const results = await store.searchTasks("xyznonexistent12345");

    expect(results).toHaveLength(0);
  });

  it("respects limit option", async () => {
    await store.createTask({ description: "Task 1" });
    await store.createTask({ description: "Task 2" });
    await store.createTask({ description: "Task 3" });
    await store.createTask({ description: "Task 4" });
    await store.createTask({ description: "Task 5" });

    const results = await store.searchTasks("", { limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("respects offset option", async () => {
    await store.createTask({ description: "Task 1" });
    await store.createTask({ description: "Task 2" });
    await store.createTask({ description: "Task 3" });

    const allResults = await store.searchTasks("");
    const offsetResults = await store.searchTasks("", { offset: 1 });

    expect(allResults.length).toBe(3);
    expect(offsetResults.length).toBe(2);
    expect(offsetResults[0].id).toBe(allResults[1].id);
  });

  it("immediately indexes new comments", async () => {
    const task = await store.createTask({ description: "A task without comments" });
    const uniqueWord = `unique_search_term_${Date.now()}`;

    // Initially should not be found
    const beforeResults = await store.searchTasks(uniqueWord);
    expect(beforeResults).toHaveLength(0);

    // Add comment with unique word
    await store.addComment(task.id, `Important note about the ${uniqueWord} feature`, "tester");

    // Should now be found immediately (trigger fires synchronously)
    const afterResults = await store.searchTasks(uniqueWord);
    expect(afterResults).toHaveLength(1);
    expect(afterResults[0].id).toBe(task.id);
  });

  it("sanitizes FTS5 special characters from query", async () => {
    await store.createTask({ title: "Test with special chars", description: "Query parsing test" });

    // This should not throw and should work correctly
    const results = await store.searchTasks("test + special (chars)");

    expect(results.length).toBeGreaterThanOrEqual(0); // Should not throw
  });

  it("keeps search correctness across hyphenated tokens, null text fields, soft delete, restore, and compaction", async () => {
    const hyphenTask = await store.createTask({ title: "release-note-guard", description: "hyphenated task target" });
    const nullTitleTask = await store.createTask({ description: "null title searchable phrase" });
    await store.addComment(nullTitleTask.id, "comment-needle text", "tester");
    (store as any).db.prepare("UPDATE tasks SET comments = NULL WHERE id = ?").run(nullTitleTask.id);

    const hyphenBefore = await store.searchTasks("release-note-guard");
    expect(hyphenBefore.map((entry) => entry.id)).toContain(hyphenTask.id);

    const nullFieldResults = await store.searchTasks("searchable phrase");
    expect(nullFieldResults.map((entry) => entry.id)).toContain(nullTitleTask.id);

    await store.deleteTask(hyphenTask.id, { allowResurrection: true });
    expect((await store.searchTasks("release-note-guard")).map((entry) => entry.id)).not.toContain(hyphenTask.id);

    await store.createTaskWithReservedId(
      {
        title: "release-note-guard restored",
        description: "hyphenated task target",
        forceResurrect: true,
      },
      { taskId: hyphenTask.id },
    );

    const beforeOptimize = (await store.searchTasks("release-note-guard")).map((entry) => entry.id).sort();
    expect(beforeOptimize).toContain(hyphenTask.id);

    expect(store.optimizeFts5("optimize")).toBe(store.fts5Available);

    const afterOptimize = (await store.searchTasks("release-note-guard")).map((entry) => entry.id).sort();
    expect(afterOptimize).toEqual(beforeOptimize);
  });
});


});
