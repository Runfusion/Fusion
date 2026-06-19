import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { getAgentLogFilePath, countAgentLogEntries, readAgentLogEntries } from "../agent-log-file-store.js";
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
  const taskDir = (taskId: string) => join(rootDir, ".fusion", "tasks", taskId);

  describe("task commit association diff stats", () => {
    it("round-trips nullable additions and deletions without coercing unknown stats to zero", async () => {
      const withStats = await store.upsertTaskCommitAssociation({
        taskLineageId: "lineage-loc-stats",
        taskIdSnapshot: "FN-6704",
        commitSha: "abc123",
        commitSubject: "feat: capture stats",
        authoredAt: "2026-06-19T00:00:00.000Z",
        matchedBy: "canonical-lineage-trailer",
        confidence: "canonical",
        additions: 12,
        deletions: 3,
      });
      expect(withStats.additions).toBe(12);
      expect(withStats.deletions).toBe(3);

      await store.upsertTaskCommitAssociation({
        taskLineageId: "lineage-loc-stats",
        taskIdSnapshot: "FN-6704",
        commitSha: "def456",
        commitSubject: "fix: unknown stats",
        authoredAt: "2026-06-19T01:00:00.000Z",
        matchedBy: "canonical-lineage-trailer",
        confidence: "canonical",
      });

      const associations = await store.getTaskCommitAssociationsByLineageId("lineage-loc-stats");
      const persistedWithStats = associations.find((association) => association.commitSha === "abc123");
      const persistedUnknownStats = associations.find((association) => association.commitSha === "def456");
      expect(persistedWithStats).toMatchObject({ additions: 12, deletions: 3 });
      expect(persistedUnknownStats?.additions).toBeUndefined();
      expect(persistedUnknownStats?.deletions).toBeUndefined();

      const rawUnknown = (store as any).db.prepare(
        `SELECT additions, deletions FROM task_commit_associations WHERE commitSha = ?`,
      ).get("def456") as { additions: number | null; deletions: number | null };
      expect(rawUnknown).toEqual({ additions: null, deletions: null });
    });
  });

  describe("upsertTask regression coverage", () => {
    it("creates tasks successfully on a fresh database schema", async () => {
      const freshRoot = makeTmpDir();
      const freshGlobal = makeTmpDir();
      const freshStore = new TaskStore(freshRoot, freshGlobal);
      await freshStore.init();

      const task = await freshStore.createTask({ description: "fresh schema task" });
      expect(task.id).toBe("FN-001");
      expect(await freshStore.getTask(task.id)).toBeDefined();

      freshStore.close();
      await rm(freshRoot, { recursive: true, force: true });
      await rm(freshGlobal, { recursive: true, force: true });
    });

    it("persists createTask with nullable, array, and optional scalar fields", async () => {
      const created = await store.createTask({
        title: "Persist me",
        description: "Create path coverage",
        column: "todo",
        dependencies: ["FN-999"],
        enabledWorkflowSteps: ["WS-001"],
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
        modelPresetId: "normal",
      });

      const persisted = await store.getTask(created.id);
      expect(persisted.title).toBe("Persist me");
      expect(persisted.column).toBe("todo");
      expect(persisted.dependencies).toEqual(["FN-999"]);
      expect(persisted.enabledWorkflowSteps).toEqual(["WS-001"]);
      expect(persisted.modelProvider).toBe("anthropic");
      expect(persisted.validatorModelProvider).toBe("openai");
      expect(persisted.modelPresetId).toBe("normal");
    });

    it("persists updateTask changes across scalar, array, and nullable JSON-backed fields", async () => {
      const task = await store.createTask({ description: "Update path coverage" });

      await store.updateTask(task.id, {
        title: "Updated title",
        dependencies: ["FN-002", "FN-003"],
        blockedBy: "FN-002",
        status: "failed",
        error: "boom",
        summary: "summary",
        workflowStepResults: [
          {
            workflowStepId: "WS-001",
            workflowStepName: "QA",
            status: "passed",
            startedAt: "2026-04-01T00:00:00.000Z",
            completedAt: "2026-04-01T00:01:00.000Z",
            output: "ok",
          },
        ],
        modifiedFiles: ["packages/core/src/store.ts"],
      });

      const persisted = await store.getTask(task.id);
      expect(persisted.title).toBe("Updated title");
      expect(persisted.dependencies).toEqual(["FN-002", "FN-003"]);
      expect(persisted.blockedBy).toBe("FN-002");
      expect(persisted.status).toBe("failed");
      expect(persisted.error).toBe("boom");
      expect(persisted.summary).toBe("summary");
      expect(persisted.workflowStepResults).toHaveLength(1);
      expect(persisted.workflowStepResults?.[0].workflowStepId).toBe("WS-001");
      expect(persisted.modifiedFiles).toEqual(["packages/core/src/store.ts"]);
    });
  });


  describe("agent log persistence", () => {
    it("appendAgentLog persists to JSONL and getAgentLogs reads it back", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "Hello world", "text");
      await store.appendAgentLog(task.id, "Read", "tool");
      (store as any).flushAgentLogBuffer();

      expect(readAgentLogEntries(taskDir(task.id))).toMatchObject([
        { taskId: task.id, text: "Hello world", type: "text" },
        { taskId: task.id, text: "Read", type: "tool" },
      ]);

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(2);
      expect(logs[0].text).toBe("Hello world");
      expect(logs[0].type).toBe("text");
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[1].text).toBe("Read");
      expect(logs[1].type).toBe("tool");
    });

    it("getAgentLogs returns empty array when no log entries exist", async () => {
      const task = await createTestTask();
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toEqual([]);
    });

    it("getAgentLogs returns empty array when task directory is missing", async () => {
      const task = await createTestTask();
      await deleteTaskDir(task.id);

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toEqual([]);
    });

    it("appendAgentLog emits agent:log event", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("agent:log", (entry) => events.push(entry));

      await store.appendAgentLog(task.id, "delta text", "text");

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe("delta text");
      expect(events[0].type).toBe("text");
      expect(events[0].taskId).toBe(task.id);
    });

    it("appendAgentLogBatch inserts all entries and emits per-entry events", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("agent:log", (entry) => events.push(entry));

      await store.appendAgentLogBatch([
        { taskId: task.id, text: "batch 1", type: "text" },
        { taskId: task.id, text: "tool", type: "tool", detail: "read file", agent: "executor" },
      ]);

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(2);
      expect(logs.map((entry) => entry.text)).toEqual(["batch 1", "tool"]);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ text: "tool", type: "tool", detail: "read file", agent: "executor" });
    });

    it("truncates oversized tool detail before persisting and emitting", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      const oversizedDetail = "X".repeat(5000);
      const truncationMarker = "[tool output truncated to keep dashboard log views responsive]";
      store.on("agent:log", (entry) => events.push(entry));

      await store.appendAgentLogBatch([
        { taskId: task.id, text: "Bash", type: "tool_result", detail: oversizedDetail, agent: "executor" },
      ]);

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].detail).toContain(truncationMarker);
      expect(logs[0].detail!.match(/\[tool output truncated to keep dashboard log views responsive\]/g)).toHaveLength(1);
      expect(logs[0].detail!.length).toBeLessThan(oversizedDetail.length);
      expect(events[0].detail).toBe(logs[0].detail);
    });

    it("appendAgentLogBatch with empty entries is a no-op", async () => {
      const task = await createTestTask();

      await store.appendAgentLogBatch([]);

      expect(await store.getAgentLogCount(task.id)).toBe(0);
    });

    it("appendAgentLog writes detail when provided", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "Bash", "tool", "ls -la");
      await store.appendAgentLog(task.id, "Read", "tool", "packages/core/src/types.ts");
      await store.appendAgentLog(task.id, "some text", "text");

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(3);
      expect(logs[0].detail).toBe("ls -la");
      expect(logs[1].detail).toBe("packages/core/src/types.ts");
      expect(logs[2].detail).toBeUndefined();
    });

    it("appendAgentLog omits detail field when not provided", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "Bash", "tool");

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toHaveProperty("detail");
    });

    it("handles multiple appends correctly", async () => {
      const task = await createTestTask();
      for (let i = 0; i < 5; i++) {
        await store.appendAgentLog(task.id, `chunk ${i}`, "text");
      }
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(5);
      expect(logs[0].text).toBe("chunk 0");
      expect(logs[4].text).toBe("chunk 4");
    });

    it("getAgentLogCount returns the number of persisted log entries", async () => {
      const task = await createTestTask();
      expect(await store.getAgentLogCount(task.id)).toBe(0);

      await store.appendAgentLog(task.id, "chunk 0", "text");
      await store.appendAgentLog(task.id, "chunk 1", "tool");

      expect(await store.getAgentLogCount(task.id)).toBe(2);
    });

    it("returns the most recent agent log entries in chronological order", async () => {
      const task = await createTestTask();

      for (let i = 0; i < 5; i++) {
        await store.appendAgentLog(task.id, `chunk ${i}`, "text");
      }

      const logs = await store.getAgentLogs(task.id, { limit: 2 });
      expect(logs.map((entry) => entry.text)).toEqual(["chunk 3", "chunk 4"]);
    });

    it("returns older agent log pages when offset skips recent entries", async () => {
      const task = await createTestTask();

      for (let i = 0; i < 5; i++) {
        await store.appendAgentLog(task.id, `chunk ${i}`, "text");
      }

      await expect(store.getAgentLogs(task.id, { limit: 2 })).resolves.toMatchObject([
        { text: "chunk 3" },
        { text: "chunk 4" },
      ]);
      await expect(store.getAgentLogs(task.id, { limit: 2, offset: 2 })).resolves.toMatchObject([
        { text: "chunk 1" },
        { text: "chunk 2" },
      ]);
      await expect(store.getAgentLogs(task.id, { limit: 2, offset: 4 })).resolves.toMatchObject([
        { text: "chunk 0" },
      ]);
    });

    it("preserves insertion order when multiple entries share the same timestamp", async () => {
      const task = await createTestTask();
      const tiedTimestamp = "2026-04-24T12:00:00.000Z";

      insertLogEntryWithTimestamp(store, task.id, "first tied", "text", tiedTimestamp);
      insertLogEntryWithTimestamp(store, task.id, "second tied", "text", tiedTimestamp);
      insertLogEntryWithTimestamp(store, task.id, "third tied", "text", tiedTimestamp);

      const logs = await store.getAgentLogs(task.id);
      expect(logs.map((entry) => entry.text)).toEqual([
        "first tied",
        "second tied",
        "third tied",
      ]);
    });

    it("applies deterministic ordering for tied timestamps with limit/offset pagination", async () => {
      const task = await createTestTask();
      const tiedTimestamp = "2026-04-24T12:00:00.000Z";

      insertLogEntryWithTimestamp(store, task.id, "first tied", "text", tiedTimestamp);
      insertLogEntryWithTimestamp(store, task.id, "second tied", "text", tiedTimestamp);
      insertLogEntryWithTimestamp(store, task.id, "third tied", "text", tiedTimestamp);
      insertLogEntryWithTimestamp(store, task.id, "fourth tied", "text", tiedTimestamp);

      await expect(store.getAgentLogs(task.id, { limit: 2 })).resolves.toMatchObject([
        { text: "third tied" },
        { text: "fourth tied" },
      ]);
      await expect(store.getAgentLogs(task.id, { limit: 2, offset: 1 })).resolves.toMatchObject([
        { text: "second tied" },
        { text: "third tied" },
      ]);
      await expect(store.getAgentLogs(task.id, { limit: 2, offset: 2 })).resolves.toMatchObject([
        { text: "first tied" },
        { text: "second tied" },
      ]);
    });

    it("preserves long entry fields when returning a bounded tail", async () => {
      const task = await createTestTask();
      const longText = [
        "## Long Tail Entry",
        "",
        "This entry should survive a bounded tail read in full.",
        "Z".repeat(800),
      ].join("\n");
      const longDetail = "detail/".repeat(120) + "AgentLogViewer.tsx";

      await store.appendAgentLog(task.id, "older entry", "text");
      await store.appendAgentLog(task.id, longText, "tool", longDetail, "executor");
      await store.appendAgentLog(task.id, "newest entry", "text");

      const logs = await store.getAgentLogs(task.id, { limit: 2 });

      expect(logs.map((entry) => entry.text)).toEqual([longText, "newest entry"]);
      expect(logs[0].detail).toBe(longDetail);
      expect(logs[0].agent).toBe("executor");
      expect(logs[0].text.length).toBe(longText.length);
      expect(logs[0].detail!.length).toBe(longDetail.length);
    });

    it("clips oversized historical tool detail at read time", async () => {
      const task = await createTestTask();
      const oversizedDetail = "Y".repeat(7000);
      const truncationMarker = "[tool output truncated to keep dashboard log views responsive]";

      insertLogEntryWithTimestamp(
        store,
        task.id,
        "Bash",
        "tool_result",
        "2026-04-24T12:00:00.000Z",
        oversizedDetail,
        "executor",
      );

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].detail).toContain(truncationMarker);
      expect(logs[0].detail!.match(/\[tool output truncated to keep dashboard log views responsive\]/g)).toHaveLength(1);
      expect(logs[0].detail!.length).toBeLessThan(oversizedDetail.length);
    });

    it("appendAgentLog persists and reads back the agent field", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "hello", "text", undefined, "executor");
      await store.appendAgentLog(task.id, "Read", "tool", "file.ts", "triage");

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(2);
      expect(logs[0].agent).toBe("executor");
      expect(logs[1].agent).toBe("triage");
    });

    it("appendAgentLog omits agent field when not provided", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "hello", "text");

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toHaveProperty("agent");
    });

    it("new type values (thinking, tool_result, tool_error) round-trip correctly", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "internal thought", "thinking", undefined, "executor");
      await store.appendAgentLog(task.id, "Bash", "tool_result", "output summary", "executor");
      await store.appendAgentLog(task.id, "Read", "tool_error", "file not found", "reviewer");

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(3);

      expect(logs[0].type).toBe("thinking");
      expect(logs[0].text).toBe("internal thought");
      expect(logs[0].agent).toBe("executor");

      expect(logs[1].type).toBe("tool_result");
      expect(logs[1].text).toBe("Bash");
      expect(logs[1].detail).toBe("output summary");

      expect(logs[2].type).toBe("tool_error");
      expect(logs[2].text).toBe("Read");
      expect(logs[2].detail).toBe("file not found");
      expect(logs[2].agent).toBe("reviewer");
    });

    it("preserves long multiline text without truncation", async () => {
      const task = await createTestTask();
      const longText = [
        "## Analysis",
        "",
        "After reviewing the codebase, I found several issues:",
        "",
        "1. The first issue is that the function `processData` does not handle",
        "   edge cases where the input array is empty. This can cause unexpected",
        "   behavior downstream when consumers expect at least one element.",
        "",
        "2. The second issue relates to the caching layer. The TTL is set to",
        "   a very low value (60 seconds) which causes excessive cache misses.",
        "",
        "```typescript",
        "function processData(data: unknown[]): Result {",
        "  // This is a very long code block that should not be truncated",
        "  if (!data || data.length === 0) {",
        "    throw new Error('Data array must not be empty');",
        "  }",
        "  return data.map(item => transform(item)).filter(Boolean);",
        "}",
        "```",
        "",
        "Line " + "A".repeat(500) + " end of long line",
      ].join("\n");
      // Total length should be well over 1000 characters
      expect(longText.length).toBeGreaterThan(1000);

      await store.appendAgentLog(task.id, longText, "text");
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toBe(longText);
    });

    it("preserves long detail strings without truncation", async () => {
      const task = await createTestTask();
      const longDetail = "path/to/a/very/deeply/nested/directory/structure/that/contains/many/segments/".repeat(20)
        + "src/components/features/dashboard/panels/AgentLogViewer.tsx";
      // Total length should be well over 500 characters
      expect(longDetail.length).toBeGreaterThan(500);

      await store.appendAgentLog(task.id, "Read", "tool", longDetail);
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].detail).toBe(longDetail);
    });

    it("preserves both long text and long detail simultaneously", async () => {
      const task = await createTestTask();
      const longText = "X".repeat(2000);
      const longDetail = "Y".repeat(2000);

      await store.appendAgentLog(task.id, longText, "tool", longDetail, "executor");
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toBe(longText);
      expect(logs[0].text.length).toBe(2000);
      expect(logs[0].detail).toBe(longDetail);
      expect(logs[0].detail!.length).toBe(2000);
    });

    it("getAgentLogsByTimeRange filters entries by start and end timestamps (inclusive)", async () => {
      const task = await createTestTask();

      insertLogEntryWithTimestamp(store, task.id, "before start", "text", "2024-01-01T00:00:00.000Z");
      insertLogEntryWithTimestamp(store, task.id, "at start", "text", "2024-01-01T01:00:00.000Z");
      insertLogEntryWithTimestamp(store, task.id, "middle", "text", "2024-01-01T02:00:00.000Z");
      insertLogEntryWithTimestamp(store, task.id, "at end", "text", "2024-01-01T03:00:00.000Z");
      insertLogEntryWithTimestamp(store, task.id, "after end", "text", "2024-01-01T04:00:00.000Z");

      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2024-01-01T01:00:00.000Z",
        "2024-01-01T03:00:00.000Z",
      );

      expect(logs).toHaveLength(3);
      expect(logs.map((l) => l.text)).toEqual(["at start", "middle", "at end"]);
    });

    it("getAgentLogsByTimeRange uses current time when endIso is null", async () => {
      const task = await createTestTask();

      insertLogEntryWithTimestamp(store, task.id, "entry1", "text", "2024-01-01T00:00:00.000Z");
      insertLogEntryWithTimestamp(store, task.id, "entry2", "text", "2024-06-01T00:00:00.000Z");

      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2024-01-01T00:00:00.000Z",
        null,
      );

      expect(logs).toHaveLength(2);
    });

    it("getAgentLogsByTimeRange returns empty array when no entries match", async () => {
      const task = await createTestTask();
      insertLogEntryWithTimestamp(store, task.id, "entry1", "text", "2024-01-01T00:00:00.000Z");

      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2025-01-01T00:00:00.000Z",
        "2025-12-31T23:59:59.000Z",
      );

      expect(logs).toEqual([]);
    });

    it("getAgentLogsByTimeRange returns empty array when no entries exist", async () => {
      const task = await createTestTask();

      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2024-01-01T00:00:00.000Z",
        "2024-12-31T23:59:59.000Z",
      );

      expect(logs).toEqual([]);
    });

    it("deleteTask refuses when another live task depends on this id", async () => {
      // Regression for the triage-split bug: splitting a parent into children
      // used to hard-delete the parent even when a child carried the parent id
      // in its dependencies array, permanently blocking the child because the
      // scheduler treats missing-dep ids as unmet.
      const parent = await store.createTask({ description: "Parent to be split" });
      const child = await store.createTask({
        description: "Child that accidentally depends on parent",
      });
      await store.updateTask(child.id, { dependencies: [parent.id] });

      await expect(store.deleteTask(parent.id)).rejects.toBeInstanceOf(TaskHasDependentsError);

      // Parent must still exist so the dependent isn't stranded.
      const stillThere = await store.getTask(parent.id);
      expect(stillThere.id).toBe(parent.id);

      // The error must name the dependent so callers/logs can triage it.
      try {
        await store.deleteTask(parent.id);
      } catch (err) {
        expect(err).toBeInstanceOf(TaskHasDependentsError);
        expect((err as TaskHasDependentsError).dependentIds).toContain(child.id);
      }

      // After the dependent's reference is removed, delete succeeds.
      await store.updateTask(child.id, { dependencies: [] });
      await expect(store.deleteTask(parent.id)).resolves.toMatchObject({ id: parent.id });
    });

    it("deleteTask removes incoming dependency references when explicitly requested", async () => {
      const parent = await store.createTask({ description: "Parent to delete" });
      const dependentOne = await store.createTask({ description: "Dependent one" });
      const dependentTwo = await store.createTask({ description: "Dependent two" });

      await store.updateTask(dependentOne.id, { dependencies: [parent.id, "FN-UNRELATED"] });
      await store.updateTask(dependentTwo.id, { dependencies: [parent.id] });

      await expect(
        store.deleteTask(parent.id, { removeDependencyReferences: true }),
      ).resolves.toMatchObject({ id: parent.id });

      const updatedOne = await store.getTask(dependentOne.id);
      const updatedTwo = await store.getTask(dependentTwo.id);

      expect(updatedOne.dependencies).toEqual(["FN-UNRELATED"]);
      expect(updatedTwo.dependencies).toEqual([]);
      expect(updatedOne.dependencies).not.toContain(parent.id);
      expect(updatedTwo.dependencies).not.toContain(parent.id);
      const deletedParent = await store.getTask(parent.id, { includeDeleted: true });
      expect(deletedParent?.deletedAt).toBeDefined();
    });

    it("deleteTask allows deletion when a similarly-named id contains the target (substring false-positive guard)", async () => {
      // The LIKE probe uses '%id%'; ensure we don't misidentify e.g. FN-1 as
      // referencing FN-10 just because the id string appears inside a JSON
      // array containing "FN-10".
      const targetTask = await store.createTask({ description: "Target" }); // e.g. FN-001
      const similarId = `${targetTask.id}X`; // definitely not a real task id
      const other = await store.createTask({ description: "Other" });
      await store.updateTask(other.id, { dependencies: [similarId] });

      // Should NOT throw — the LIKE probe's string match is disambiguated by
      // JSON.parse + array.includes.
      await expect(store.deleteTask(targetTask.id)).resolves.toMatchObject({ id: targetTask.id });
    });

    it("deleting a task clears persisted agent log entries for soft-deleted rows", async () => {
      const task = await createTestTask();
      await store.appendAgentLog(task.id, "cascade me", "text");
      (store as any).flushAgentLogBuffer();

      expect(countAgentLogEntries(taskDir(task.id))).toBe(1);

      await store.deleteTask(task.id);

      expect(countAgentLogEntries(taskDir(task.id))).toBe(1);
      await expect(store.getAgentLogs(task.id)).resolves.toEqual([]);
    });

    it("deleteTask clears linked agent task assignments", async () => {
      store.close();
      store = new TaskStore(rootDir, globalDir);
      await store.init();

      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();

      try {
        const task = await store.createTask({ description: "Delete me" });
        const agent = await agentStore.createAgent({ name: "Delete watcher", role: "executor" });
        await agentStore.assignTask(agent.id, task.id);

        await store.deleteTask(task.id);

        const updatedAgent = await agentStore.getAgent(agent.id);
        expect(updatedAgent?.taskId).toBeUndefined();
      } finally {
        agentStore.close();
      }
    });

    it("importLegacyAgentLogs imports JSONL entries from existing agent.log files", async () => {
      const task = await createTestTask();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      const legacyEntries = [
        {
          timestamp: "2024-01-01T00:00:00.000Z",
          taskId: task.id,
          text: "legacy line 1",
          type: "text",
        },
        {
          timestamp: "2024-01-01T01:00:00.000Z",
          taskId: task.id,
          text: "legacy line 2",
          type: "tool",
          detail: "legacy detail",
          agent: "executor",
        },
      ];
      await writeFile(join(dir, "agent.log"), `${legacyEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

      const imported = await store.importLegacyAgentLogs();

      expect(imported).toBe(2);
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(2);
      expect(logs.map((log) => log.text)).toEqual(["legacy line 1", "legacy line 2"]);
      expect(logs[1].detail).toBe("legacy detail");
      expect(logs[1].agent).toBe("executor");
    });

    it("importLegacyAgentLogsOnce is idempotent via __meta guard", async () => {
      const task = await createTestTask();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      const logPath = join(dir, "agent.log");

      (store as any).db.prepare("DELETE FROM __meta WHERE key = ?").run("agentLogLegacyFileImportVersion");

      await writeFile(logPath, `${JSON.stringify({
        timestamp: "2024-01-01T00:00:00.000Z",
        taskId: task.id,
        text: "legacy line 1",
        type: "text",
      })}\n`);

      await (store as any).importLegacyAgentLogsOnce();
      expect(await store.getAgentLogCount(task.id)).toBe(1);

      await appendFile(logPath, `${JSON.stringify({
        timestamp: "2024-01-01T01:00:00.000Z",
        taskId: task.id,
        text: "legacy line 2",
        type: "text",
      })}\n`);

      await (store as any).importLegacyAgentLogsOnce();
      expect(await store.getAgentLogCount(task.id)).toBe(1);

      const migrationRow = (store as any).db.prepare(
        "SELECT value FROM __meta WHERE key = ?",
      ).get("agentLogLegacyFileImportVersion") as { value: string } | undefined;
      expect(migrationRow?.value).toBe("1");
    });

    describe("agent log buffering", () => {
      it("buffers entries and flushes in a single transaction when buffer is full", async () => {
        const task = await createTestTask();

        // Fill the buffer to its max size (50)
        for (let i = 0; i < 50; i++) {
          await store.appendAgentLog(task.id, `entry ${i}`, "text");
        }

        // Validate DB persistence without invoking read-path auto-flush helpers.
        expect(countAgentLogEntries(taskDir(task.id))).toBe(50);
      });

      it("auto-flushes buffered entries when getAgentLogs is called", async () => {
        const task = await createTestTask();

        // Write fewer than BUFFER_SIZE entries — these stay buffered
        await store.appendAgentLog(task.id, "buffered 1", "text");
        await store.appendAgentLog(task.id, "buffered 2", "text");

        // getAgentLogs triggers a flush
        const logs = await store.getAgentLogs(task.id);
        expect(logs).toHaveLength(2);
        expect(logs[0].text).toBe("buffered 1");
        expect(logs[1].text).toBe("buffered 2");
      });

      it("auto-flushes buffered entries when getAgentLogCount is called", async () => {
        const task = await createTestTask();

        await store.appendAgentLog(task.id, "counted", "text");
        const count = await store.getAgentLogCount(task.id);
        expect(count).toBe(1);
      });

      it("auto-flushes before deleteTask and soft-delete hides resulting file-backed rows", async () => {
        const task = await createTestTask();

        await store.appendAgentLog(task.id, "to be cascaded", "text");
        // Prove flush happens before delete
        const flushSpy = vi.spyOn(store as any, "flushAgentLogBuffer");
        await store.deleteTask(task.id);
        expect(flushSpy).toHaveBeenCalled();
        flushSpy.mockRestore();

        expect(countAgentLogEntries(taskDir(task.id))).toBe(1);
        await expect(store.getAgentLogs(task.id)).resolves.toEqual([]);
      });

      it("flushes remaining entries on close without throwing", async () => {
        // Disk-backed store required — in-memory data doesn't survive close+reopen
        store.close();
        store = new TaskStore(rootDir, globalDir); // no inMemoryDb
        await store.init();

        const task = await store.createTask({ description: "Test task" });

        await store.appendAgentLog(task.id, "flush on close", "text");
        // close() should flush the buffer gracefully
        expect(() => store.close()).not.toThrow();

        // Re-open and verify the entry was persisted
        store = new TaskStore(rootDir, globalDir);
        await store.init();
        const logs = await store.getAgentLogs(task.id);
        expect(logs).toHaveLength(1);
        expect(logs[0].text).toBe("flush on close");
      });

      it("close does not throw when flushing entries for already-deleted tasks", async () => {
        const task = await createTestTask();

        await store.appendAgentLog(task.id, "orphaned entry", "text");
        // Flush so the entry is in the DB, then delete the task
        (store as any).flushAgentLogBuffer();
        await store.deleteTask(task.id);

        // Now buffer another entry for the deleted task
        await store.appendAgentLog(task.id, "ghost entry", "text");
        // close() should not throw despite FK constraint violation on flush
        expect(() => store.close()).not.toThrow();
      });

      it("emits agent:log event immediately even when buffered", async () => {
        const task = await createTestTask();
        const events: any[] = [];
        store.on("agent:log", (entry) => events.push(entry));

        await store.appendAgentLog(task.id, "immediate event", "text");

        // Event fires immediately, even though DB write is deferred
        expect(events).toHaveLength(1);
        expect(events[0].text).toBe("immediate event");
        expect(events[0].taskId).toBe(task.id);
      });

      it("flushes interleaved entries from multiple tasks correctly", async () => {
        const taskA = await createTestTask();
        const taskB = await store.createTask({ description: "Task B" });

        // Interleave entries for two tasks
        for (let i = 0; i < 25; i++) {
          await store.appendAgentLog(taskA.id, `A-${i}`, "text");
          await store.appendAgentLog(taskB.id, `B-${i}`, "text");
        }
        // 50 total = buffer full, triggers flush

        const countA = await store.getAgentLogCount(taskA.id);
        const countB = await store.getAgentLogCount(taskB.id);
        expect(countA).toBe(25);
        expect(countB).toBe(25);
      });
    });
  });


});
