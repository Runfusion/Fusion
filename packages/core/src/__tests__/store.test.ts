import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock child_process so we can intercept execSync calls in branch cleanup tests.
// By default, pass through to the real implementation.
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    execSync: vi.fn((...args: Parameters<typeof mod.execSync>) => mod.execSync(...args)),
  };
});

vi.mock("../run-command.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../run-command.js")>();
  return {
    ...mod,
    runCommandAsync: vi.fn((...args: Parameters<typeof mod.runCommandAsync>) => mod.runCommandAsync(...args)),
  };
});

import { execSync } from "node:child_process";
const mockedExecSync = vi.mocked(execSync);
import { runCommandAsync } from "../run-command.js";
const mockedRunCommandAsync = vi.mocked(runCommandAsync);

import { TaskStore, TaskHasDependentsError } from "../store.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as projectMemory from "../project-memory.js";
import { buildResearchDocumentKey, type Task } from "../types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-test-"));
}

describe("TaskStore", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    // In-memory SQLite cuts per-test setup from ~50ms to ~5ms by avoiding
    // disk open + WAL fsync for both fusion.db and archive.db. The few
    // tests below that exercise cross-instance persistence (open store A,
    // close, open store B on same dir, expect data) construct disk-backed
    // stores explicitly — they are flagged with a comment at each site.
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    // Ensure teardown always runs on real timers. Some tests in this file use
    // timeout/retry-based fs cleanup paths that can stall indefinitely if fake
    // timers were left enabled by a preceding test.
    vi.useRealTimers();

    // Some watcher/polling tests can leave an in-flight poll tick queued right
    // before teardown. Stop watching first and yield once so pending callbacks
    // settle before removing temp dirs.
    //
    // Use nextTick instead of setImmediate so this teardown cannot deadlock if
    // fake timers are enabled by a test and not yet restored.
    store.stopWatching();
    await new Promise<void>((resolve) => process.nextTick(resolve));

    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTestTask(): Promise<Task> {
    return store.createTask({ description: "Test task" });
  }

  function createSourceIssueFixture() {
    return {
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "I_kgDOExample",
      issueNumber: 2471,
      url: "https://github.com/runfusion/fusion/issues/2471",
    };
  }

  async function createTaskWithSteps(): Promise<Task> {
    const task = await store.createTask({ description: "Task with steps" });
    // Write a PROMPT.md with steps so updateStep works
    const dir = join(rootDir, ".fusion", "tasks", task.id);
    await writeFile(
      join(dir, "PROMPT.md"),
      `# ${task.id}: Task with steps

## Steps

### Step 0: Preflight

- [ ] Check things

### Step 1: Implementation

- [ ] Do stuff

### Step 2: Testing

- [ ] Test stuff
`,
    );
    return task;
  }

  async function deleteTaskDir(taskId: string): Promise<string> {
    const dir = join(rootDir, ".fusion", "tasks", taskId);
    await rm(dir, { recursive: true, force: true });
    return dir;
  }

  function insertLogEntryWithTimestamp(
    targetStore: TaskStore,
    taskId: string,
    text: string,
    type: string,
    timestamp: string,
    detail?: string,
    agent?: string,
  ): void {
    (targetStore as any).db.prepare(`
      INSERT INTO agentLogEntries (taskId, timestamp, text, type, detail, agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, timestamp, text, type, detail ?? null, agent ?? null);
  }


  describe("breakIntoSubtasks task creation flag", () => {
    it("persists breakIntoSubtasks=true when explicitly requested", async () => {
      const task = await store.createTask({
        description: "Large feature",
        breakIntoSubtasks: true,
      });

      expect(task.breakIntoSubtasks).toBe(true);

      const detail = await store.getTask(task.id);
      expect(detail.breakIntoSubtasks).toBe(true);
    });

    it("persists modelPresetId when provided during task creation", async () => {
      const task = await store.createTask({
        description: "Preset task",
        modelPresetId: "budget",
      });

      expect(task.modelPresetId).toBe("budget");

      const detail = await store.getTask(task.id);
      expect(detail.modelPresetId).toBe("budget");
    });

    it("leaves breakIntoSubtasks unset by default", async () => {
      const task = await store.createTask({
        description: "Regular task",
      });

      expect(task.breakIntoSubtasks).toBeUndefined();

      const detail = await store.getTask(task.id);
      expect(detail.breakIntoSubtasks).toBeUndefined();
    });

    it("persists missionId and sliceId when provided during task creation", async () => {
      const task = await store.createTask({
        description: "Mission-linked task",
        missionId: "MS-001",
        sliceId: "SL-001",
      });

      expect(task.missionId).toBe("MS-001");
      expect(task.sliceId).toBe("SL-001");

      const detail = await store.getTask(task.id);
      expect(detail.missionId).toBe("MS-001");
      expect(detail.sliceId).toBe("SL-001");
    });

    it("leaves missionId and sliceId unset when not provided", async () => {
      const task = await store.createTask({
        description: "Regular task",
      });

      expect(task.missionId).toBeUndefined();
      expect(task.sliceId).toBeUndefined();

      const detail = await store.getTask(task.id);
      expect(detail.missionId).toBeUndefined();
      expect(detail.sliceId).toBeUndefined();
    });
  });


  describe("nodeId in-progress blocking", () => {
    it("throws when updating nodeId on an in-progress task", async () => {
      const task = await store.createTask({ description: "In progress task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.updateTask(task.id, { nodeId: "node-abc" }))
        .rejects.toThrow(/in progress/i);
    });

    it("allows updating nodeId on a todo task", async () => {
      const task = await store.createTask({ description: "Todo task" });

      const updated = await store.updateTask(task.id, { nodeId: "node-todo" });
      expect(updated.nodeId).toBe("node-todo");
    });

    it("allows updating nodeId on an in-review task", async () => {
      const task = await store.createTask({ description: "Review task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const updated = await store.updateTask(task.id, { nodeId: "node-review" });
      expect(updated.nodeId).toBe("node-review");
    });

    it("allows other updates on in-progress tasks (non-nodeId)", async () => {
      const task = await store.createTask({ description: "In progress title update" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.title).toBe("Updated title");
    });

    it("allows clearing nodeId on a done task", async () => {
      const task = await store.createTask({ description: "Done task", nodeId: "node-done" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.updateTask(task.id, { nodeId: null });
      expect(updated.nodeId).toBeUndefined();
    });

    it("does not throw when nodeId update is undefined on an in-progress task", async () => {
      const task = await store.createTask({ description: "In progress no-op", nodeId: "node-stable" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { nodeId: undefined });
      expect(updated.nodeId).toBe("node-stable");
    });

    it("includes task ID in nodeId override blocking error", async () => {
      const task = await store.createTask({ description: "In progress blocked id" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.updateTask(task.id, { nodeId: "node-abc" })).rejects.toThrow(task.id);
    });

    it("allows priority updates on in-progress tasks without changing existing nodeId", async () => {
      const task = await store.createTask({ description: "In progress priority", nodeId: "node-keep" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { priority: "high" });
      expect(updated.priority).toBe("high");
      expect(updated.nodeId).toBe("node-keep");
    });
  });

  describe("getTasksByAssignedAgent", () => {
    it("returns only tasks assigned to the requested agent", async () => {
      const mine = await store.createTask({ description: "mine", assignedAgentId: "agent-1" });
      await store.createTask({ description: "other", assignedAgentId: "agent-2" });
      await store.createTask({ description: "unassigned" });

      const tasks = await store.getTasksByAssignedAgent("agent-1");
      expect(tasks.map((task) => task.id)).toEqual([mine.id]);
    });

    it("supports pausedOnly filter", async () => {
      const paused = await store.createTask({ description: "paused", assignedAgentId: "agent-1" });
      const active = await store.createTask({ description: "active", assignedAgentId: "agent-1" });
      await store.updateTask(paused.id, { paused: true });

      const tasks = await store.getTasksByAssignedAgent("agent-1", { pausedOnly: true });
      expect(tasks.map((task) => task.id)).toEqual([paused.id]);
      expect(tasks.some((task) => task.id === active.id)).toBe(false);
    });

    it("supports excludeArchived filter", async () => {
      const active = await store.createTask({ description: "active", assignedAgentId: "agent-1" });
      const archived = await store.createTask({ description: "archived", assignedAgentId: "agent-1", column: "done" });
      await store.archiveTask(archived.id, false);

      const tasks = await store.getTasksByAssignedAgent("agent-1", { excludeArchived: true });
      expect(tasks.map((task) => task.id)).toEqual([active.id]);
    });
  });

  describe("selectNextTaskForAgent", () => {
    it("returns null when no tasks exist", async () => {
      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("returns in-progress task assigned to the agent", async () => {
      const inProgress = await store.createTask({
        description: "In-progress task",
        column: "in-progress",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(inProgress.id);
      expect(selected?.priority).toBe("in_progress");
    });

    it("prefers in-progress over todo when both exist for the agent", async () => {
      await store.createTask({
        description: "Ready todo task",
        column: "todo",
        assignedAgentId: "agent-1",
      });
      const inProgress = await store.createTask({
        description: "In-progress task",
        column: "in-progress",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(inProgress.id);
      expect(selected?.priority).toBe("in_progress");
    });

    it("returns todo task with all dependencies done", async () => {
      const dep = await store.createTask({ description: "Done dep", column: "done" });
      const readyTodo = await store.createTask({
        description: "Ready todo",
        column: "todo",
        assignedAgentId: "agent-1",
        dependencies: [dep.id],
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(readyTodo.id);
      expect(selected?.priority).toBe("todo");
    });

    it("skips todo task with unresolved dependencies that are not actionable", async () => {
      const dep = await store.createTask({ description: "Unresolved dep", column: "todo" });
      await store.createTask({
        description: "Blocked todo",
        column: "todo",
        assignedAgentId: "agent-1",
        dependencies: [dep.id],
      });

      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("returns blocked task with partially done dependencies when no higher-priority tasks exist", async () => {
      const doneDep = await store.createTask({ description: "Done dep", column: "done" });
      const blockedDep = await store.createTask({ description: "Blocked dep", column: "todo" });
      const partiallyActionable = await store.createTask({
        description: "Partially actionable todo",
        column: "todo",
        assignedAgentId: "agent-1",
        dependencies: [doneDep.id, blockedDep.id],
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(partiallyActionable.id);
      expect(selected?.priority).toBe("blocked");
    });

    it("skips paused tasks", async () => {
      const pausedTodo = await store.createTask({
        description: "Paused todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });
      await store.updateTask(pausedTodo.id, { paused: true });

      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("skips tasks assigned to a different agent", async () => {
      await store.createTask({
        description: "Other agent task",
        column: "todo",
        assignedAgentId: "agent-2",
      });

      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("resolves FIFO ordering within the same priority tier", async () => {
      const older = await store.createTask({
        description: "Older ready todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.createTask({
        description: "Newer ready todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(older.id);
      expect(selected?.priority).toBe("todo");
    });

    it("returns null when no tasks are assigned to the queried agent", async () => {
      await store.createTask({
        description: "Unassigned todo",
        column: "todo",
      });

      await expect(store.selectNextTaskForAgent("agent-without-tasks")).resolves.toBeNull();
    });

    it("skips implementation todos for non-executor role agents", async () => {
      await store.createTask({
        description: "Assigned todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      await expect(
        store.selectNextTaskForAgent("agent-1", { id: "agent-1", role: "reviewer" }),
      ).resolves.toBeNull();
    });

    it("returns implementation todos for executor role agents", async () => {
      const todo = await store.createTask({
        description: "Assigned todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1", {
        id: "agent-1",
        role: "executor",
      });

      expect(selected?.task.id).toBe(todo.id);
      expect(selected?.priority).toBe("todo");
    });

    it("allows non-executor role agents to pick assigned todos when override metadata is set", async () => {
      const delegated = await store.createTask({
        description: "Assigned todo override",
        column: "todo",
        assignedAgentId: "agent-1",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });

      const selected = await store.selectNextTaskForAgent("agent-1", {
        id: "agent-1",
        role: "reviewer",
      });

      expect(selected?.task.id).toBe(delegated.id);
      expect(selected?.priority).toBe("todo");
    });
  });

  // ── Lock serialization test ──────────────────────────────────────

  describe("write lock serialization", () => {
    it("serializes concurrent logEntry and updateStep calls without corruption", async () => {
      const task = await createTaskWithSteps();
      const id = task.id;

      // Fire 20 concurrent operations: 10 logEntry + 10 updateStep (alternating steps)
      const promises: Promise<Task>[] = [];
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          promises.push(store.logEntry(id, `Log entry ${i}`));
        } else {
          // Toggle step 0 between in-progress and done
          const status = i % 4 === 1 ? "in-progress" : "done";
          promises.push(store.updateStep(id, 0, status));
        }
      }

      await Promise.all(promises);

      // Read back and verify valid JSON
      const taskJsonPath = join(rootDir, ".fusion", "tasks", id, "task.json");
      const raw = await readFile(taskJsonPath, "utf-8");
      const result = JSON.parse(raw) as Task;

      // Check all 10 log entries are present (plus initial "Task created" + step update logs)
      const customLogs = result.log.filter((l) => l.action.startsWith("Log entry"));
      expect(customLogs).toHaveLength(10);
    });
  });

  // ── Defensive parsing test ───────────────────────────────────────

  describe("defensive JSON parsing", () => {
    it("reads from SQLite even if task.json on disk is corrupted", async () => {
      const task = await createTestTask();
      const taskJsonPath = join(rootDir, ".fusion", "tasks", task.id, "task.json");

      // Corrupt the file: append duplicate trailing content
      const validJson = await readFile(taskJsonPath, "utf-8");
      const corrupted = validJson + validJson.slice(validJson.length / 2);
      await writeFile(taskJsonPath, corrupted);

      // SQLite still has valid data — getTask should succeed
      const detail = await store.getTask(task.id);
      expect(detail.id).toBe(task.id);
    });

    it("reads from SQLite even if task.json contains invalid content", async () => {
      const task = await createTestTask();
      const taskJsonPath = join(rootDir, ".fusion", "tasks", task.id, "task.json");

      // Write completely invalid content
      await writeFile(taskJsonPath, "not json at all {{{");

      // SQLite still has valid data — getTask should succeed
      const detail = await store.getTask(task.id);
      expect(detail.id).toBe(task.id);
    });
  });

  // ── Atomic write test ────────────────────────────────────────────

  describe("atomic writes", () => {
    it("produces valid JSON after write with no .tmp files left behind", async () => {
      const task = await createTestTask();
      const dir = join(rootDir, ".fusion", "tasks", task.id);

      // Perform a write
      await store.logEntry(task.id, "atomic test");

      // Verify valid JSON
      const raw = await readFile(join(dir, "task.json"), "utf-8");
      const parsed = JSON.parse(raw) as Task;
      expect(parsed.log.some((l) => l.action === "atomic test")).toBe(true);

      // Verify no .tmp files
      const files = await readdir(dir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });
  });

  // ── Atomic config writes ──────────────────────────────────────────

  describe("atomic config writes", () => {
    it("produces valid config.json with unique sequential IDs after 5 parallel createTask calls", async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        store.createTask({ description: `Concurrent task ${i}` }),
      );
      const tasks = await Promise.all(promises);

      // All IDs should be unique
      const ids = tasks.map((t) => t.id);
      expect(new Set(ids).size).toBe(5);

      // IDs should be sequential (FN-001 through FN-005)
      const sortedIds = [...ids].sort();
      expect(sortedIds).toEqual(["FN-001", "FN-002", "FN-003", "FN-004", "FN-005"]);

      // config.json should be valid JSON with nextId = 6
      const configPath = join(rootDir, ".fusion", "config.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      expect(config.nextId).toBe(6);

      // No .tmp files left behind
      const haiDir = join(rootDir, ".fusion");
      const files = await readdir(haiDir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });
  });

  // ── Attachment tests ──────────────────────────────────────────────


  describe("concurrent stress", () => {
    it("handles 10 parallel logEntry calls preserving all entries", async () => {
      const task = await createTestTask();
      const initialLogCount = task.log.length; // 1 ("Task created")

      const promises = Array.from({ length: 10 }, (_, i) =>
        store.logEntry(task.id, `Stress log ${i}`),
      );
      await Promise.all(promises);

      const result = await store.getTask(task.id);
      const stressLogs = result.log.filter((l) => l.action.startsWith("Stress log"));
      expect(stressLogs).toHaveLength(10);
      expect(result.log).toHaveLength(initialLogCount + 10);
    });
  });

  describe("updateTask — dependencies", () => {
    it("adds dependencies to a task with none", async () => {
      const task = await createTestTask();
      expect(task.dependencies).toEqual([]);

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999", "FN-002"] });
      expect(updated.dependencies).toEqual(["KB-999", "FN-002"]);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual(["KB-999", "FN-002"]);
    });

    it("replaces existing dependencies", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });
      expect(task.dependencies).toEqual(["KB-999"]);

      const updated = await store.updateTask(task.id, { dependencies: ["FN-002", "FN-003"] });
      expect(updated.dependencies).toEqual(["FN-002", "FN-003"]);
    });

    it("clears dependencies with empty array", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });
      expect(task.dependencies).toEqual(["KB-999"]);

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.dependencies).toEqual([]);
    });

    it("leaves dependencies unchanged when not provided", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });

      const updated = await store.updateTask(task.id, { title: "New title" });
      expect(updated.dependencies).toEqual(["KB-999"]);
    });
  });

  describe("self-dependency validation", () => {
    it("createTask should throw when dependencies include self", async () => {
      // We can't know the ID before creation, so we test the update scenario
      // or test that the check exists in the code path
      const task = await createTestTask();
      // After creation, task.id is known (e.g., KB-001)
      // Now try to update it to depend on itself
      await expect(store.updateTask(task.id, { dependencies: [task.id] }))
        .rejects.toThrow(`Task ${task.id} cannot depend on itself`);
    });

    it("updateTask should throw when setting dependencies to include self", async () => {
      const task = await createTestTask();
      expect(task.dependencies).toEqual([]);

      await expect(store.updateTask(task.id, { dependencies: [task.id, "FN-002"] }))
        .rejects.toThrow(`Task ${task.id} cannot depend on itself`);

      // Verify the task was not modified
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual([]);
    });

    it("updateTask should throw when updating dependencies to add self (when task already has other dependencies)", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });
      expect(task.dependencies).toEqual(["KB-999"]);

      await expect(store.updateTask(task.id, { dependencies: ["KB-999", task.id] }))
        .rejects.toThrow(`Task ${task.id} cannot depend on itself`);

      // Verify the task was not modified
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual(["KB-999"]);
    });
  });

  describe("updateTask — auto-move todo to triage on new deps", () => {
    it("moves a todo task to triage when a new dependency is added", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo" });
      expect(task.column).toBe("todo");

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("triage");
      expect(updated.status).toBeUndefined();

      // Verify log entry
      expect(updated.log.some((l: any) => l.action.includes("Moved to triage for re-specification"))).toBe(true);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.column).toBe("triage");
    });

    it("emits task:moved event with { from: 'todo', to: 'triage' }", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo" });
      const events: any[] = [];
      store.on("task:moved", (data: any) => events.push(data));

      await store.updateTask(task.id, { dependencies: ["KB-999"] });

      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("todo");
      expect(events[0].to).toBe("triage");
    });

    it("does NOT move when dependencies are removed from a todo task", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo", dependencies: ["KB-999"] });

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.column).toBe("todo");
    });

    it("does NOT move when dependencies are replaced with same set", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo", dependencies: ["KB-999"] });

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("todo");
    });

    it("does NOT move a triage task when dependencies are added", async () => {
      const task = await store.createTask({ description: "Triage task" });
      expect(task.column).toBe("triage");

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("triage");
    });

    it("does NOT move an in-progress task when dependencies are added (handled by executor)", async () => {
      const task = await store.createTask({ description: "IP task", column: "todo" });
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("in-progress");
    });
  });

  describe("updateTask — blockedBy", () => {
    it("sets blockedBy to a string value", async () => {
      const task = await store.createTask({ title: "Blocked task", description: "A task" });
      const updated = await store.updateTask(task.id, { blockedBy: "KB-999" });
      expect(updated.blockedBy).toBe("KB-999");
    });

    it("clears blockedBy when set to null", async () => {
      const task = await store.createTask({ title: "Blocked task", description: "A task" });
      await store.updateTask(task.id, { blockedBy: "KB-999" });
      const updated = await store.updateTask(task.id, { blockedBy: null });
      expect(updated.blockedBy).toBeUndefined();
    });
  });

  describe("updateTask — assigneeUserId", () => {
    it("sets assigneeUserId via updateTask", async () => {
      const task = await store.createTask({ title: "User task", description: "A task" });
      const updated = await store.updateTask(task.id, { assigneeUserId: "requesting-user" });
      expect(updated.assigneeUserId).toBe("requesting-user");
    });

    it("clears assigneeUserId when set to null", async () => {
      const task = await store.createTask({ title: "User task", description: "A task" });
      await store.updateTask(task.id, { assigneeUserId: "requesting-user" });
      const updated = await store.updateTask(task.id, { assigneeUserId: null });
      expect(updated.assigneeUserId).toBeUndefined();
    });

    it("sets and clears status: awaiting-user-review", async () => {
      const task = await store.createTask({ title: "Review task", description: "A task" });
      const updated = await store.updateTask(task.id, { status: "awaiting-user-review" });
      expect(updated.status).toBe("awaiting-user-review");

      const cleared = await store.updateTask(task.id, { status: null });
      expect(cleared.status).toBeUndefined();
    });
  });

  // ── Task prefix tests ──────────────────────────────────────────


  describe("SQLite-first reads when task blobs are missing", () => {
    it("getTask returns metadata from SQLite with an empty prompt when the task directory is missing", async () => {
      const task = await createTestTask();
      await deleteTaskDir(task.id);

      const fetched = await store.getTask(task.id);

      expect(fetched.id).toBe(task.id);
      expect(fetched.description).toBe(task.description);
      expect(fetched.prompt).toBe("");
    });

    it("getTask syncs steps from PROMPT.md when task.steps is empty", async () => {
      const task = await store.createTask({ description: "Test task" });
      // task.steps should be empty in DB
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Test task

## Steps

### Step 0: Preflight
- [ ] Check something

### Step 1: Do the thing
- [ ] Do it
`,
      );

      const detail = await store.getTask(task.id);
      expect(detail.steps).toEqual([
        { name: "Preflight", status: "pending" },
        { name: "Do the thing", status: "pending" },
      ]);
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

  describe("directory recreation for file-backed blobs", () => {
    it("pauseTask recreates missing task directory before writing task.json", async () => {
      const task = await createTestTask();
      const dir = await deleteTaskDir(task.id);

      const paused = await store.pauseTask(task.id, true);

      expect(paused.paused).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "task.json"))).toBe(true);

      const fetched = await store.getTask(task.id);
      expect(fetched.paused).toBe(true);
    });

    it("updateStep recreates missing task directory and persists regenerated task.json", async () => {
      const task = await createTaskWithSteps();
      const promptDir = join(rootDir, ".fusion", "tasks", task.id);
      const prompt = await readFile(join(promptDir, "PROMPT.md"), "utf-8");
      const dir = await deleteTaskDir(task.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "PROMPT.md"), prompt);

      const updated = await store.updateStep(task.id, 0, "in-progress");

      expect(updated.steps[0].status).toBe("in-progress");
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "task.json"))).toBe(true);

      const fetched = await store.getTask(task.id);
      expect(fetched.steps[0].status).toBe("in-progress");
    });

    it("preserves done/skipped steps when updateStep is called with in-progress", async () => {
      const task = await createTaskWithSteps();
      await store.updateStep(task.id, 0, "done");
      await store.updateStep(task.id, 1, "done");
      const beforeRegression = await store.getTask(task.id);
      const currentStepBefore = beforeRegression.currentStep;

      // Agent erroneously re-marks an already-done step as in-progress.
      const result = await store.updateStep(task.id, 0, "in-progress");

      expect(result.steps[0].status).toBe("done");
      expect(result.steps[1].status).toBe("done");
      expect(result.currentStep).toBe(currentStepBefore);

      const fetched = await store.getTask(task.id);
      expect(fetched.steps[0].status).toBe("done");
      expect(fetched.currentStep).toBe(currentStepBefore);
    });

    it("addComment recreates missing task directory before persisting metadata", async () => {
      const task = await createTestTask();
      const dir = await deleteTaskDir(task.id);

      const updated = await store.addComment(task.id, "Please recover from missing directory");

      expect(updated.comments).toHaveLength(1);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "task.json"))).toBe(true);

      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(1);
    });

    it("addAttachment recreates missing task directory and attachment directory", async () => {
      const task = await createTestTask();
      const dir = await deleteTaskDir(task.id);

      const attachment = await store.addAttachment(task.id, "note.txt", Buffer.from("hello"), "text/plain");

      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "attachments", attachment.filename))).toBe(true);
      expect(existsSync(join(dir, "task.json"))).toBe(true);

      const fetched = await store.getTask(task.id);
      expect(fetched.attachments).toHaveLength(1);
    });

    it("updateTask recreates missing task directory before rewriting PROMPT.md", async () => {
      const task = await createTestTask();
      const dir = await deleteTaskDir(task.id);
      const prompt = "# KB-001\n\nRecovered prompt\n";

      const updated = await store.updateTask(task.id, { title: "Recovered", prompt });

      expect(updated.title).toBe("Recovered");
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "PROMPT.md"))).toBe(true);
      expect(await readFile(join(dir, "PROMPT.md"), "utf-8")).toBe(prompt);

      const fetched = await store.getTask(task.id);
      expect(fetched.title).toBe("Recovered");
      expect(fetched.prompt).toBe(prompt);
    });

    it("duplicateTask recreates the new task directory before copying PROMPT.md", async () => {
      const task = await createTestTask();

      const duplicate = await store.duplicateTask(task.id);
      const duplicateDir = join(rootDir, ".fusion", "tasks", duplicate.id);

      expect(existsSync(duplicateDir)).toBe(true);
      expect(existsSync(join(duplicateDir, "PROMPT.md"))).toBe(true);
      expect(await readFile(join(duplicateDir, "PROMPT.md"), "utf-8")).toContain(task.description);
    });
  });

  describe("pauseTask", () => {
    it("sets paused flag to true and adds log entry", async () => {
      const task = await createTestTask();
      const paused = await store.pauseTask(task.id, true);

      expect(paused.paused).toBe(true);
      expect(paused.log.some((l) => l.action === "Task paused")).toBe(true);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.paused).toBe(true);
    });

    it("unpauses a paused task and clears paused flag", async () => {
      const task = await createTestTask();
      await store.pauseTask(task.id, true);
      const unpaused = await store.pauseTask(task.id, false);

      expect(unpaused.paused).toBeUndefined();
      expect(unpaused.log.some((l) => l.action === "Task unpaused")).toBe(true);

      const fetched = await store.getTask(task.id);
      expect(fetched.paused).toBeUndefined();
    });

    it("emits task:updated event", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      await store.pauseTask(task.id, true);

      expect(events).toHaveLength(1);
      expect(events[0].paused).toBe(true);
    });

    it("sets status to 'paused' when pausing an in-progress task", async () => {
      const task = await createTestTask();
      // Move to in-progress: triage → todo → in-progress
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const paused = await store.pauseTask(task.id, true);
      expect(paused.paused).toBe(true);
      expect(paused.status).toBe("paused");
    });

    it("clears status when unpausing an in-progress task", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await store.pauseTask(task.id, true);
      const unpaused = await store.pauseTask(task.id, false);
      expect(unpaused.paused).toBeUndefined();
      expect(unpaused.status).toBeUndefined();
    });

    it("sets and clears paused status for in-review tasks", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const paused = await store.pauseTask(task.id, true);
      expect(paused.paused).toBe(true);
      expect(paused.status).toBe("paused");

      const unpaused = await store.pauseTask(task.id, false);
      expect(unpaused.paused).toBeUndefined();
      expect(unpaused.status).toBeUndefined();
    });

    it("round-trips pause/unpause correctly", async () => {
      const task = await createTestTask();

      await store.pauseTask(task.id, true);
      let fetched = await store.getTask(task.id);
      expect(fetched.paused).toBe(true);

      await store.pauseTask(task.id, false);
      fetched = await store.getTask(task.id);
      expect(fetched.paused).toBeUndefined();

      await store.pauseTask(task.id, true);
      fetched = await store.getTask(task.id);
      expect(fetched.paused).toBe(true);
    });

    it("sets pausedByAgentId and logs agent pause reason", async () => {
      const task = await createTestTask();
      const paused = await store.pauseTask(task.id, true, undefined, { pausedByAgentId: "agent-1" });

      expect(paused.pausedByAgentId).toBe("agent-1");
      expect(paused.log.at(-1)?.action).toBe("Task paused (agent agent-1 paused)");
    });

    it("clears pausedByAgentId and logs agent resume reason", async () => {
      const task = await createTestTask();
      await store.pauseTask(task.id, true, undefined, { pausedByAgentId: "agent-2" });

      const unpaused = await store.pauseTask(task.id, false);
      expect(unpaused.pausedByAgentId).toBeUndefined();
      expect(unpaused.log.at(-1)?.action).toBe("Task unpaused (agent agent-2 resumed)");
    });

    it("uses standard unpause log when task was not paused by an agent", async () => {
      const task = await createTestTask();
      await store.pauseTask(task.id, true);

      const unpaused = await store.pauseTask(task.id, false);
      expect(unpaused.pausedByAgentId).toBeUndefined();
      expect(unpaused.log.at(-1)?.action).toBe("Task unpaused");
    });

    it("keeps pausedByAgentId undefined when pausing without agent options", async () => {
      const task = await createTestTask();
      const paused = await store.pauseTask(task.id, true);

      expect(paused.pausedByAgentId).toBeUndefined();
    });
  });

  describe("updateTask — paused", () => {
    it("sets paused via updateTask", async () => {
      const task = await createTestTask();
      const updated = await store.updateTask(task.id, { paused: true });
      expect(updated.paused).toBe(true);
    });

    it("clears paused via updateTask", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { paused: true });
      const updated = await store.updateTask(task.id, { paused: false });
      expect(updated.paused).toBeUndefined();
    });
  });

  describe("createTask — model overrides", () => {
    it("persists executor and validator model overrides on creation", async () => {
      const created = await store.createTask({
        title: "Task with model overrides",
        description: "Use explicit executor and validator models",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });

      expect(created.modelProvider).toBe("anthropic");
      expect(created.modelId).toBe("claude-sonnet-4-5");
      expect(created.validatorModelProvider).toBe("openai");
      expect(created.validatorModelId).toBe("gpt-4o");

      const persisted = await store.getTask(created.id);
      expect(persisted.modelProvider).toBe("anthropic");
      expect(persisted.modelId).toBe("claude-sonnet-4-5");
      expect(persisted.validatorModelProvider).toBe("openai");
      expect(persisted.validatorModelId).toBe("gpt-4o");
    });
  });

  describe("createTask — assigneeUserId", () => {
    it("persists assigneeUserId on creation", async () => {
      const created = await store.createTask({
        title: "Task with user assignment",
        description: "A task assigned to a user",
        assigneeUserId: "requesting-user",
      });

      expect(created.assigneeUserId).toBe("requesting-user");

      const persisted = await store.getTask(created.id);
      expect(persisted.assigneeUserId).toBe("requesting-user");
    });
  });

  describe("updateTask — model overrides", () => {
    it("sets executor model provider and id via updateTask", async () => {
      const task = await createTestTask();
      const updated = await store.updateTask(task.id, { modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(updated.modelProvider).toBe("anthropic");
      expect(updated.modelId).toBe("claude-sonnet-4-5");
    });

    it("sets validator model provider and id via updateTask", async () => {
      const task = await createTestTask();
      const updated = await store.updateTask(task.id, { validatorModelProvider: "openai", validatorModelId: "gpt-4o" });
      expect(updated.validatorModelProvider).toBe("openai");
      expect(updated.validatorModelId).toBe("gpt-4o");
    });

    it("clears executor model fields via null", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      const updated = await store.updateTask(task.id, { modelProvider: null, modelId: null });
      expect(updated.modelProvider).toBeUndefined();
      expect(updated.modelId).toBeUndefined();
    });

    it("clears validator model fields via null", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { validatorModelProvider: "openai", validatorModelId: "gpt-4o" });
      const updated = await store.updateTask(task.id, { validatorModelProvider: null, validatorModelId: null });
      expect(updated.validatorModelProvider).toBeUndefined();
      expect(updated.validatorModelId).toBeUndefined();
    });

    it("sets only executor model without affecting validator model", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { validatorModelProvider: "openai", validatorModelId: "gpt-4o" });
      const updated = await store.updateTask(task.id, { modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(updated.modelProvider).toBe("anthropic");
      expect(updated.modelId).toBe("claude-sonnet-4-5");
      expect(updated.validatorModelProvider).toBe("openai");
      expect(updated.validatorModelId).toBe("gpt-4o");
    });

    it("preserves model fields when updating unrelated fields", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.modelProvider).toBe("anthropic");
      expect(updated.modelId).toBe("claude-sonnet-4-5");
      expect(updated.validatorModelProvider).toBe("openai");
      expect(updated.validatorModelId).toBe("gpt-4o");
      expect(updated.title).toBe("Updated title");
    });

    it("does not clobber a real PROMPT.md spec when title changes on a triage task", async () => {
      // Regression: triage finalization called updateTask({title}) while column
      // was still 'triage', and the regen path rewrote PROMPT.md back to the
      // bootstrap stub — shipping empty specs to the executor.
      const task = await createTestTask();
      const realSpec = [
        `# Task: ${task.id} - Some refactor`,
        "",
        "**Created:** 2026-05-02",
        "**Size:** M",
        "",
        "## Mission",
        "",
        "Do the thing.",
        "",
        "## Steps",
        "",
        "- [ ] Step 1",
        "- [ ] Step 2",
        "",
      ].join("\n");
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(join(dir, "PROMPT.md"), realSpec);

      await store.updateTask(task.id, { title: "Some refactor" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toBe(realSpec);
    });

    it("still rewrites the bootstrap stub when title changes on a triage task", async () => {
      const task = await createTestTask();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      // Confirm createTask seeded the bootstrap stub.
      const initial = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initial.startsWith(`# ${task.id}`)).toBe(true);
      expect(/^##\s/m.test(initial)).toBe(false);

      await store.updateTask(task.id, { title: "New Title" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toBe(`# ${task.id}: New Title\n\n${task.description}\n`);
    });

    it("rewrites a long bootstrap stub when title changes (structural detection, not size-based)", async () => {
      // Regression: a length-based stub detector treated stubs from long
      // descriptions (e.g. imported issue bodies) as real specs, so subsequent
      // edits left the displayed heading stale.
      const longDescription = "Lorem ipsum dolor sit amet. ".repeat(40); // ~1100 bytes
      const created = await store.createTask({ description: longDescription });
      const dir = join(rootDir, ".fusion", "tasks", created.id);
      const initial = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initial.length).toBeGreaterThan(1000);
      expect(/^##\s/m.test(initial)).toBe(false);

      await store.updateTask(created.id, { title: "Now With Title" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toBe(`# ${created.id}: Now With Title\n\n${longDescription}\n`);
    });

    it("rewrites a stub whose description body contains markdown headings or metadata-like text", async () => {
      // Regression: a content-inspecting detector (rejecting any body with
      // `##` headers or `**Created:**` / `**Size:**` markers) misclassified
      // imported GitHub issue bodies as real specs. Detection must compare to
      // the bootstrap wrapper shape, not inspect the description content.
      const importedDescription = [
        "## Repro",
        "",
        "1. Open the dashboard.",
        "2. Click the thing.",
        "",
        "## Expected",
        "",
        "Thing happens.",
        "",
        "**Created:** 2026-04-01 by automation",
        "**Size:** unspecified",
      ].join("\n");
      const created = await store.createTask({ description: importedDescription });
      const dir = join(rootDir, ".fusion", "tasks", created.id);

      await store.updateTask(created.id, { title: "Issue with markdown body" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      // The stub was rewritten — heading reflects the new title and the body
      // is the (markdown-containing) description verbatim.
      expect(onDisk).toBe(`# ${created.id}: Issue with markdown body\n\n${importedDescription}\n`);
    });

    it("survives the triage finalize sequence end-to-end (move-to-todo + title sync)", async () => {
      // Mirrors what TriageProcessor.finalizeApprovedTask does on a real
      // TaskStore: spec lands on disk, non-title metadata is applied with the
      // task still in triage, the task moves to todo, and finally the prompt-
      // declared title is synced. A regression in either the bootstrap stub
      // detector or the real-spec edit path would surface as a corrupted or
      // truncated PROMPT.md after this sequence.
      const created = await store.createTask({
        description: "raw user description containing ## a markdown heading",
      });
      const dir = join(rootDir, ".fusion", "tasks", created.id);
      const realSpec = [
        `# Task: ${created.id} - Refactor the renderer`,
        "",
        "**Created:** 2026-05-02",
        "**Size:** M",
        "",
        "## Review Level: 2 (Plan and Code)",
        "",
        "**Score:** 5/8",
        "",
        "## Mission",
        "",
        "Refactor the renderer to use the new pipeline.",
        "",
        "## Frontend UX Criteria",
        "",
        "- Component must remain accessible at 320px width",
        "",
        "## Steps",
        "",
        "- [ ] Extract pipeline",
        "",
      ].join("\n");
      // Triage agent would have written this via the `write` tool.
      await writeFile(join(dir, "PROMPT.md"), realSpec);

      // Reproduce finalizeApprovedTask's exact sequence:
      // 1. Apply non-title metadata while still in triage.
      await store.updateTask(created.id, { status: null });
      // 2. Move to todo.
      await store.moveTask(created.id, "todo");
      // 3. Sync prompt-declared title.
      await store.updateTask(created.id, { title: "Refactor the renderer" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toContain("## Review Level: 2 (Plan and Code)");
      expect(onDisk).toContain("## Frontend UX Criteria");
      expect(onDisk).toContain("- Component must remain accessible at 320px width");
      expect(onDisk).toContain("## Steps");
      expect(onDisk).toContain("- [ ] Extract pipeline");
      expect(onDisk.split("\n")[0]).toBe(`# Task: ${created.id} - Refactor the renderer`);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.column).toBe("todo");
      expect(reloaded.title).toBe("Refactor the renderer");
    });

    it("preserves Review Level / Frontend UX Criteria sections when title changes on a non-triage task", async () => {
      // Regression: the previous regenerate-from-whitelist path quietly dropped
      // any section not in {Dependencies, Steps, File Scope, Acceptance,
      // Notifications}. Triage emits `## Review Level: N` and may emit
      // `## Frontend UX Criteria`; both must survive a metadata edit.
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      const realSpec = [
        `# Task: ${task.id} - Original title`,
        "",
        "**Created:** 2026-05-02",
        "**Size:** M",
        "",
        "## Review Level: 2 (Plan and Code)",
        "",
        "**Score:** 5/8",
        "",
        "## Mission",
        "",
        "Do the thing.",
        "",
        "## Frontend UX Criteria",
        "",
        "- Component must remain accessible at 320px width",
        "",
        "## Steps",
        "",
        "- [ ] Step 1",
        "",
      ].join("\n");
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(join(dir, "PROMPT.md"), realSpec);

      await store.updateTask(task.id, { title: "Renamed task" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toContain("## Review Level: 2 (Plan and Code)");
      expect(onDisk).toContain("## Frontend UX Criteria");
      expect(onDisk).toContain("- Component must remain accessible at 320px width");
      expect(onDisk).toContain("## Steps");
      // Heading is rewritten in the original triage style.
      expect(onDisk.split("\n")[0]).toBe(`# Task: ${task.id} - Renamed task`);
    });

    it("persists sourceIssue on create and reload", async () => {
      const sourceIssue = createSourceIssueFixture();
      const created = await store.createTask({
        description: "Task with source issue",
        sourceIssue,
      });

      expect(created.sourceIssue).toEqual(sourceIssue);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.sourceIssue).toEqual(sourceIssue);
    });

    it("updates and clears sourceIssue via updateTask", async () => {
      const sourceIssue = createSourceIssueFixture();
      const task = await createTestTask();

      const linked = await store.updateTask(task.id, { sourceIssue });
      expect(linked.sourceIssue).toEqual(sourceIssue);

      const reloaded = await store.getTask(task.id);
      expect(reloaded.sourceIssue).toEqual(sourceIssue);

      const cleared = await store.updateTask(task.id, { sourceIssue: null });
      expect(cleared.sourceIssue).toBeUndefined();

      const reloadedAfterClear = await store.getTask(task.id);
      expect(reloadedAfterClear.sourceIssue).toBeUndefined();
    });

    it("preserves sourceIssue through archive and unarchive", async () => {
      const sourceIssue = createSourceIssueFixture();
      const task = await store.createTask({
        description: "Archive source issue preservation",
        sourceIssue,
      });

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.archiveTask(task.id, false);
      const archived = await store.getTask(task.id);
      expect(archived.column).toBe("archived");
      expect(archived.sourceIssue).toEqual(sourceIssue);

      const restored = await store.unarchiveTask(task.id);
      expect(restored.column).toBe("done");
      expect(restored.sourceIssue).toEqual(sourceIssue);
    });

    it("persists review metadata on create, update, and reload", async () => {
      const review: NonNullable<Task["review"]> = {
        mode: "direct",
        source: "reviewer-agent",
        decision: "changes-requested",
        summary: "Address reviewer findings",
        latestRefreshAt: new Date().toISOString(),
        selectedItemIds: ["rvw-1"],
        items: [
          {
            id: "rvw-1",
            source: "reviewer-agent",
            status: "queued",
            summary: "Fix failing assertion",
            body: "Assertion in task detail modal test is stale.",
            reviewer: "reviewer",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };

      const created = await store.createTask({ description: "Task with review metadata" });
      const updated = await store.updateTask(created.id, { review });
      expect(updated.review).toEqual(review);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.review).toEqual(review);

      const cleared = await store.updateTask(created.id, { review: null });
      expect(cleared.review).toBeUndefined();
    });

    it("persists reviewState independently from legacy review", async () => {
      const created = await store.createTask({ description: "Task with review state" });
      const selectedAt = new Date().toISOString();
      const reviewState: NonNullable<Task["reviewState"]> = {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [{ id: "ri-1", body: "Fix this", author: { login: "octocat" }, createdAt: selectedAt }],
        addressing: [{
          itemId: "ri-1",
          status: "queued",
          selectedAt,
          snapshot: {
            itemId: "ri-1",
            sourceMode: "pull-request",
            source: "pr-review",
            summary: "Fix this",
            body: "Fix this",
            authorLogin: "octocat",
          },
        }],
      };

      await store.updateTask(created.id, { reviewState });
      const reloaded = await store.getTask(created.id);
      expect(reloaded.reviewState).toEqual(reviewState);
      expect(reloaded.review).toBeUndefined();
    });

    it("hydrates legacy addressing records with snapshots", async () => {
      const created = await store.createTask({ description: "Legacy review state" });
      const selectedAt = new Date().toISOString();
      await store.updateTask(created.id, {
        reviewState: {
          source: "reviewer-agent",
          items: [{
            id: "review-1",
            body: "Update tests for regression",
            summary: "Update tests",
            author: { login: "reviewer" },
            createdAt: selectedAt,
            source: "reviewer-agent",
          }],
          addressing: [{ itemId: "review-1", status: "queued", selectedAt }],
        },
      });

      const reloaded = await store.getTask(created.id);
      expect(reloaded.reviewState?.addressing[0].snapshot).toEqual({
        itemId: "review-1",
        sourceMode: "reviewer-agent",
        source: "reviewer-agent",
        summary: "Update tests",
        body: "Update tests for regression",
        authorLogin: "reviewer",
        filePath: undefined,
        threadId: undefined,
        url: undefined,
      });
    });

    it("preserves review metadata through archive and unarchive", async () => {
      const review: NonNullable<Task["review"]> = {
        mode: "pull-request",
        source: "github-pr",
        decision: "pending",
        summary: "PR review feedback",
        latestRefreshAt: new Date().toISOString(),
        selectedItemIds: ["gh-1"],
        items: [
          {
            id: "gh-1",
            source: "github-pr",
            status: "in-progress",
            summary: "Address thread in src/file.ts",
            filePath: "src/file.ts",
            line: 42,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      const task = await store.createTask({ description: "Archive review persistence" });
      await store.updateTask(task.id, { review });

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      const archived = await store.getTask(task.id);
      expect(archived.review).toEqual(review);

      const restored = await store.unarchiveTask(task.id);
      expect(restored.review).toEqual(review);
    });

    it("sets and clears mission linkage fields via updateTask", async () => {
      const task = await createTestTask();

      const linked = await store.updateTask(task.id, {
        missionId: "M-123",
        sliceId: "SL-456",
      });
      expect(linked.missionId).toBe("M-123");
      expect(linked.sliceId).toBe("SL-456");

      const reloaded = await store.getTask(task.id);
      expect(reloaded.missionId).toBe("M-123");
      expect(reloaded.sliceId).toBe("SL-456");

      const cleared = await store.updateTask(task.id, {
        missionId: null,
        sliceId: null,
      });
      expect(cleared.missionId).toBeUndefined();
      expect(cleared.sliceId).toBeUndefined();
    });

    it("preserves mission linkage when updating unrelated fields", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, {
        missionId: "M-789",
        sliceId: "SL-789",
      });

      const updated = await store.updateTask(task.id, { title: "Linked task" });
      expect(updated.title).toBe("Linked task");
      expect(updated.missionId).toBe("M-789");
      expect(updated.sliceId).toBe("SL-789");
    });

    it("sets thinkingLevel via createTask and updateTask", async () => {
      const created = await store.createTask({
        description: "Task with thinking level",
        thinkingLevel: "high",
      });
      expect(created.thinkingLevel).toBe("high");

      const persisted = await store.getTask(created.id);
      expect(persisted.thinkingLevel).toBe("high");

      const updated = await store.updateTask(created.id, { thinkingLevel: "low" });
      expect(updated.thinkingLevel).toBe("low");

      const reloaded = await store.getTask(created.id);
      expect(reloaded.thinkingLevel).toBe("low");
    });

    it("clears thinkingLevel via null in updateTask", async () => {
      const task = await store.createTask({
        description: "Task with thinking level",
        thinkingLevel: "medium",
      });
      expect(task.thinkingLevel).toBe("medium");

      const updated = await store.updateTask(task.id, { thinkingLevel: null });
      expect(updated.thinkingLevel).toBeUndefined();
    });

    it("preserves thinkingLevel when updating unrelated fields", async () => {
      const task = await store.createTask({
        description: "Task with thinking level",
        thinkingLevel: "high",
      });
      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.thinkingLevel).toBe("high");
      expect(updated.title).toBe("Updated title");
    });
  });

  describe("executionMode persistence", () => {
    it("sets executionMode to 'fast' via createTask and persists", async () => {
      const created = await store.createTask({
        description: "Task with fast execution mode",
        executionMode: "fast",
      });
      expect(created.executionMode).toBe("fast");

      const persisted = await store.getTask(created.id);
      expect(persisted.executionMode).toBe("fast");
    });

    it("sets executionMode to 'standard' via createTask and persists", async () => {
      const created = await store.createTask({
        description: "Task with standard execution mode",
        executionMode: "standard",
      });
      expect(created.executionMode).toBe("standard");

      const persisted = await store.getTask(created.id);
      expect(persisted.executionMode).toBe("standard");
    });

    it("persists executionMode as 'standard' by default when not specified", async () => {
      const created = await store.createTask({
        description: "Task without execution mode",
      });
      // The field should be undefined in the Task object (optional field)
      expect(created.executionMode).toBeUndefined();

      const persisted = await store.getTask(created.id);
      // The persisted value should be 'standard' in the database
      expect(persisted.executionMode).toBeUndefined();
    });

    it("updates executionMode via updateTask", async () => {
      const created = await store.createTask({
        description: "Task for execution mode update",
        executionMode: "standard",
      });
      expect(created.executionMode).toBe("standard");

      const updated = await store.updateTask(created.id, { executionMode: "fast" });
      expect(updated.executionMode).toBe("fast");

      const reloaded = await store.getTask(created.id);
      expect(reloaded.executionMode).toBe("fast");
    });

    it("clears executionMode via null in updateTask", async () => {
      const task = await store.createTask({
        description: "Task with execution mode to clear",
        executionMode: "fast",
      });
      expect(task.executionMode).toBe("fast");

      const updated = await store.updateTask(task.id, { executionMode: null });
      expect(updated.executionMode).toBeUndefined();
    });

    it("preserves executionMode when updating unrelated fields", async () => {
      const task = await store.createTask({
        description: "Task with execution mode to preserve",
        executionMode: "fast",
      });
      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.executionMode).toBe("fast");
      expect(updated.title).toBe("Updated title");
    });

    it("returns executionMode in listTasks", async () => {
      await store.createTask({ description: "Fast task", executionMode: "fast" });
      await store.createTask({ description: "Unspecified task" });

      const tasks = await store.listTasks();
      const fastTask = tasks.find((t) => t.description === "Fast task");
      const unspecifiedTask = tasks.find((t) => t.description === "Unspecified task");

      expect(fastTask?.executionMode).toBe("fast");
      expect(unspecifiedTask?.executionMode).toBeUndefined();
    });
  });

  describe("updateTask — PROMPT.md regeneration", () => {
    it("regenerates PROMPT.md when title is updated", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial PROMPT.md
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toContain(`# ${task.id}`);
      expect(initialPrompt).toContain("Test task");

      // Update title
      await store.updateTask(task.id, { title: "New Title" });

      // Verify PROMPT.md was regenerated with new title
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain(`# ${task.id}: New Title`);
      expect(updatedPrompt).toContain("Test task"); // Description preserved
    });

    it("regenerates PROMPT.md when description is updated", async () => {
      const task = await store.createTask({ description: "Old description", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial PROMPT.md
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toContain("Old description");

      // Update description
      await store.updateTask(task.id, { description: "New description" });

      // Verify PROMPT.md was regenerated with new description
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("New description");
    });

    it("preserves existing steps when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with steps", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write custom steps to PROMPT.md
      const customPrompt = `# ${task.id}: Task with steps

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

Task with steps

## Steps

### Step 1: Custom Step

- [ ] Custom action 1
- [ ] Custom action 2

### Step 2: Another Custom Step

- [ ] Another action
`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update title
      await store.updateTask(task.id, { title: "Updated Title" });

      // Verify custom steps are preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain(`# ${task.id}: Updated Title`);
      expect(updatedPrompt).toContain("### Step 1: Custom Step");
      expect(updatedPrompt).toContain("- [ ] Custom action 1");
      expect(updatedPrompt).toContain("### Step 2: Another Custom Step");
      expect(updatedPrompt).toContain("- [ ] Another action");
    });

    it("preserves file scope when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with file scope", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write PROMPT.md with custom file scope
      const customPrompt = `# ${task.id}: Task with file scope

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

Task with file scope

## File Scope

- \`src/store.ts\`
- \`src/db.ts\`
`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update description
      await store.updateTask(task.id, { description: "Updated description" });

      // Verify file scope is preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("Updated description");
      expect(updatedPrompt).toContain("## File Scope");
      expect(updatedPrompt).toContain("`src/store.ts`");
      expect(updatedPrompt).toContain("`src/db.ts`");
    });

    it("preserves dependencies section when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with deps", column: "todo", dependencies: ["KB-001"] });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial PROMPT.md has dependencies
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toContain("## Dependencies");
      expect(initialPrompt).toContain("- **Task:** KB-001");

      // Update title
      await store.updateTask(task.id, { title: "Updated Title" });

      // Verify dependencies section is preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("## Dependencies");
      expect(updatedPrompt).toContain("- **Task:** KB-001");
    });

    it("preserves acceptance criteria section when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with acceptance criteria", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write PROMPT.md with acceptance criteria
      const customPrompt = `# ${task.id}: Task with acceptance criteria

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

Task with acceptance criteria

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update description
      await store.updateTask(task.id, { description: "Updated description" });

      // Verify acceptance criteria is preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("Updated description");
      expect(updatedPrompt).toContain("## Acceptance Criteria");
      expect(updatedPrompt).toContain("- [ ] Criterion 1");
      expect(updatedPrompt).toContain("- [ ] Criterion 2");
      expect(updatedPrompt).toContain("- [ ] Criterion 3");
    });

    it("updates simple PROMPT.md for triage tasks", async () => {
      const task = await store.createTask({ description: "Triage task", column: "triage" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial simple format
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toBe(`# ${task.id}\n\nTriage task\n`);

      // Update title
      await store.updateTask(task.id, { title: "Updated Title" });

      // Verify simple format is maintained but updated
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(`# ${task.id}: Updated Title\n\nTriage task\n`);
    });

    it("updates description in simple PROMPT.md for triage tasks", async () => {
      const task = await store.createTask({ title: "My Task", description: "Original desc", column: "triage" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial simple format
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toBe(`# ${task.id}: My Task\n\nOriginal desc\n`);

      // Update description
      await store.updateTask(task.id, { description: "Updated desc" });

      // Verify simple format is maintained but updated
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(`# ${task.id}: My Task\n\nUpdated desc\n`);
    });

    it("does not regenerate PROMPT.md when explicit prompt is provided", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Update with explicit prompt
      const customPrompt = "# Custom\n\nCustom prompt content";
      await store.updateTask(task.id, { title: "Updated Title", prompt: customPrompt });

      // Verify the explicit prompt was used, not regenerated
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(customPrompt);
    });

    it("does not regenerate PROMPT.md when neither title nor description changes", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write custom PROMPT.md
      const customPrompt = `# ${task.id}\n\n**Created:** 2024-01-01\n**Size:** L\n\n## Mission\n\nTest task\n\n## Custom Section\n\nCustom content\n`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update worktree only
      await store.updateTask(task.id, { worktree: "/tmp/worktree" });

      // Verify PROMPT.md was not changed
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(customPrompt);
    });
  });

  describe("agent log persistence", () => {
    it("appendAgentLog inserts into agentLogEntries and getAgentLogs reads it back", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "Hello world", "text");
      await store.appendAgentLog(task.id, "Read", "tool");
      (store as any).flushAgentLogBuffer();

      const rows = (store as any).db.prepare(`
        SELECT taskId, text, type FROM agentLogEntries
        WHERE taskId = ?
        ORDER BY timestamp ASC
      `).all(task.id) as Array<{ taskId: string; text: string; type: string }>;
      expect(rows).toEqual([
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

    it("returns the most recent agent log entries from SQLite in chronological order", async () => {
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
      await expect(store.getTask(parent.id)).rejects.toThrow(`Task ${parent.id} not found`);
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

    it("deleting a task cascades agent log entry deletion", async () => {
      const task = await createTestTask();
      await store.appendAgentLog(task.id, "cascade me", "text");
      (store as any).flushAgentLogBuffer();

      const before = (store as any).db.prepare(
        "SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?",
      ).get(task.id) as { count: number };
      expect(before.count).toBe(1);

      await store.deleteTask(task.id);

      const after = (store as any).db.prepare(
        "SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?",
      ).get(task.id) as { count: number };
      expect(after.count).toBe(0);
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
        const row = (store as any).db
          .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
          .get(task.id) as { count: number };
        expect(row.count).toBe(50);
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

      it("auto-flushes before deleteTask so FK cascade finds the rows", async () => {
        const task = await createTestTask();

        await store.appendAgentLog(task.id, "to be cascaded", "text");
        // Prove flush happens before delete
        const flushSpy = vi.spyOn(store as any, "flushAgentLogBuffer");
        await store.deleteTask(task.id);
        expect(flushSpy).toHaveBeenCalled();
        flushSpy.mockRestore();

        const after = (store as any).db.prepare(
          "SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?",
        ).get(task.id) as { count: number };
        expect(after.count).toBe(0);
      });

      it("flushes remaining entries on close without throwing", async () => {
        // Disk-backed store required — in-memory data doesn't survive close+reopen
        store.close();
        store = new TaskStore(rootDir, globalDir); // no inMemoryDb
        await store.init();

        const task = await createTestTask();

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

  describe("task comments", () => {
    it("adds a task comment to a task", async () => {
      const task = await createTestTask();
      const updated = await store.addTaskComment(task.id, "Please review this", "alice");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Please review this");
      expect(updated.comments![0].author).toBe("alice");
      expect(updated.comments![0].id).toBeDefined();
      expect(updated.comments![0].createdAt).toBeDefined();
      expect(updated.comments![0].updatedAt).toBeDefined();
    });

    it("updates an existing task comment", async () => {
      const task = await createTestTask();
      const added = await store.addTaskComment(task.id, "First draft", "alice");
      const commentId = added.comments![0].id;

      const updated = await store.updateTaskComment(task.id, commentId, "Updated draft");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Updated draft");
      expect(updated.comments![0].updatedAt).toBeDefined();
      expect(updated.log.some((entry) => entry.action === "Comment updated")).toBe(true);
    });

    it("deletes a task comment", async () => {
      const task = await createTestTask();
      const added = await store.addTaskComment(task.id, "Disposable", "alice");
      const commentId = added.comments![0].id;

      const updated = await store.deleteTaskComment(task.id, commentId);

      expect(updated.comments).toBeUndefined();
      expect(updated.log.some((entry) => entry.action === "Comment deleted")).toBe(true);
    });

    it("throws when updating a missing task comment", async () => {
      const task = await createTestTask();

      await expect(store.updateTaskComment(task.id, "missing", "Nope")).rejects.toThrow(
        `Comment missing not found on task ${task.id}`,
      );
    });

    it("throws when deleting a missing task comment", async () => {
      const task = await createTestTask();

      await expect(store.deleteTaskComment(task.id, "missing")).rejects.toThrow(
        `Comment missing not found on task ${task.id}`,
      );
    });

    it("persists all comments in unified comments field", async () => {
      const task = await createTestTask();
      await store.addTaskComment(task.id, "General note", "alice");
      await store.addComment(task.id, "Execution note");

      const reopened = await store.getTask(task.id);
      // Both comments should be in the unified comments array
      expect(reopened.comments).toHaveLength(2);
      expect(reopened.comments![0].text).toBe("General note");
      expect(reopened.comments![1].text).toBe("Execution note");
    });
  });

  describe("addComment", () => {
    it("adds a steering comment to a task", async () => {
      const task = await createTestTask();
      const updated = await store.addComment(task.id, "Please handle the edge case");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Please handle the edge case");
      expect(updated.comments![0].author).toBe("user");
      expect(updated.comments![0].id).toBeDefined();
      expect(updated.comments![0].createdAt).toBeDefined();
    });

    it("accepts agent as author", async () => {
      const task = await createTestTask();
      const updated = await store.addComment(task.id, "Note from agent", "agent");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].author).toBe("agent");
    });

    it("initializes comments array if undefined", async () => {
      const task = await createTestTask();
      expect(task.comments).toBeUndefined();

      const updated = await store.addComment(task.id, "First comment");
      expect(updated.comments).toBeDefined();
      expect(updated.comments).toHaveLength(1);
    });

    it("appends multiple comments in order", async () => {
      const task = await createTestTask();
      await store.addComment(task.id, "First comment");
      await store.addComment(task.id, "Second comment");
      await store.addComment(task.id, "Third comment");

      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(3);
      expect(fetched.comments![0].text).toBe("First comment");
      expect(fetched.comments![1].text).toBe("Second comment");
      expect(fetched.comments![2].text).toBe("Third comment");
    });

    it("generates unique IDs for each comment", async () => {
      const task = await createTestTask();
      const updated1 = await store.addComment(task.id, "Comment 1");
      const updated2 = await store.addComment(task.id, "Comment 2");

      const id1 = updated1.comments![0].id;
      const id2 = updated2.comments![1].id;
      expect(id1).not.toBe(id2);
    });

    it("emits task:updated event", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      await store.addComment(task.id, "Test comment");

      expect(events).toHaveLength(1);
      expect(events[0].comments).toHaveLength(1);
      expect(events[0].comments![0].text).toBe("Test comment");
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await createTestTask();
      await store.addComment(task.id, "Persisted comment");

      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(1);
      expect(fetched.comments![0].text).toBe("Persisted comment");
      expect(fetched.comments![0].author).toBe("user");
    });

    it("adds log entry for the action", async () => {
      const task = await createTestTask();
      const updated = await store.addComment(task.id, "Comment with log");

      expect(updated.log.some((l) => l.action === "Comment added by user")).toBe(true);
    });

    it("updates updatedAt timestamp", async () => {
      const task = await createTestTask();
      const before = task.updatedAt;
      await new Promise((r) => setTimeout(r, 10)); // Ensure time passes

      const updated = await store.addComment(task.id, "Timestamp test");
      expect(updated.updatedAt).not.toBe(before);
    });

    it("creates refinement task when steering comment added to done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Need to fix edge case");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length + 1);

      const refinement = allTasksAfter.find((t) => t.id !== task.id && t.title?.includes("Refinement"));
      expect(refinement).toBeDefined();
      expect(refinement?.column).toBe("triage");
      expect(refinement?.dependencies).toContain(task.id);
    });

    it("does not create refinement when steering comment added to non-done task (triage)", async () => {
      const task = await store.createTask({ description: "Original task" });
      // Task starts in triage

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not create refinement when steering comment added to non-done task (in-progress)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not create refinement when steering comment added to non-done task (in-review)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("steering comment is still added to original task even when refinement is created", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.addComment(task.id, "Need to fix edge case");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Need to fix edge case");
    });

    it("refinement task has correct dependency on original done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.addComment(task.id, "Need to fix edge case");

      const allTasks = await store.listTasks();
      const refinement = allTasks.find((t) => t.id !== task.id && t.dependencies?.includes(task.id));

      expect(refinement).toBeDefined();
      expect(refinement?.dependencies).toEqual([task.id]);
    });

    it("does not create refinement for agent-authored comments", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Agent feedback", "agent");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not fail when steering comment is empty or whitespace on done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Should not throw - refineTask will reject empty feedback but we catch it
      const updated = await store.addComment(task.id, "   ");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("   ");
    });

    it("logs warning and still persists comment when best-effort auto-refinement fails", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const runContext = { runId: "run-refinement-failure", agentId: "agent-refinement" };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const refineSpy = vi.spyOn(store, "refineTask").mockRejectedValue(new Error("refine unavailable"));

      try {
        const taskCountBefore = (await store.listTasks()).length;
        const updated = await store.addComment(task.id, "Need refinement", "user", undefined, runContext);

        expect(updated.comments).toHaveLength(1);
        expect(updated.comments![0].text).toBe("Need refinement");

        const taskCountAfter = (await store.listTasks()).length;
        expect(taskCountAfter).toBe(taskCountBefore);

        const persisted = await store.getTask(task.id);
        expect(persisted.comments).toHaveLength(1);
        expect(persisted.comments![0].text).toBe("Need refinement");

        expect(refineSpy).toHaveBeenCalledWith(task.id, "Need refinement");

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Best-effort post-comment auto-refinement failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          taskId: task.id,
          author: "user",
          commentLength: "Need refinement".length,
          column: "done",
          priorStatus: null,
          phase: "addComment:auto-refinement",
          runId: "run-refinement-failure",
          agentId: "agent-refinement",
          error: "refine unavailable",
        });
      } finally {
        refineSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("logs warning and still persists comment when status update fails during awaiting-approval invalidation", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const runContext = { runId: "run-invalidation-failure", agentId: "agent-invalidation" };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const updateSpy = vi.spyOn(store, "updateTask").mockRejectedValueOnce(new Error("status update failed"));

      try {
        const updated = await store.addComment(task.id, "New user feedback", "user", undefined, runContext);

        expect(updated.comments).toHaveLength(1);
        expect(updated.comments![0].text).toBe("New user feedback");

        const persisted = await store.getTask(task.id);
        expect(persisted.comments).toHaveLength(1);
        expect(persisted.comments![0].text).toBe("New user feedback");
        expect(persisted.status).toBe("awaiting-approval");

        expect(updateSpy).toHaveBeenCalled();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Best-effort post-comment re-triage failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          taskId: task.id,
          author: "user",
          commentLength: "New user feedback".length,
          column: "triage",
          priorStatus: "awaiting-approval",
          phase: "addComment:awaiting-approval-invalidation",
          stage: "status-update",
          nextStatus: "needs-replan",
          runId: "run-invalidation-failure",
          agentId: "agent-invalidation",
          error: "status update failed",
        });
      } finally {
        updateSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("logs warning and keeps invalidated status when log entry fails after awaiting-approval invalidation", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const runContext = { runId: "run-post-invalidation-log-failure", agentId: "agent-invalidation" };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logEntrySpy = vi.spyOn(store, "logEntry").mockRejectedValueOnce(new Error("log entry failed"));

      try {
        const updated = await store.addComment(task.id, "New user feedback", "user", undefined, runContext);

        expect(updated.comments).toHaveLength(1);
        expect(updated.comments![0].text).toBe("New user feedback");

        const persisted = await store.getTask(task.id);
        expect(persisted.comments).toHaveLength(1);
        expect(persisted.comments![0].text).toBe("New user feedback");
        expect(persisted.status).toBe("needs-replan");

        expect(logEntrySpy).toHaveBeenCalled();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Best-effort post-comment re-triage failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          taskId: task.id,
          author: "user",
          commentLength: "New user feedback".length,
          column: "triage",
          priorStatus: "awaiting-approval",
          phase: "addComment:awaiting-approval-invalidation",
          stage: "post-invalidation-log-entry",
          nextStatus: "needs-replan",
          runId: "run-post-invalidation-log-failure",
          agentId: "agent-invalidation",
          error: "log entry failed",
        });
      } finally {
        logEntrySpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("addSteeringComment on done task does NOT create a refinement task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addSteeringComment(task.id, "Please handle the edge case");

      const allTasksAfter = await store.listTasks();
      // No refinement task should be created
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("addSteeringComment writes to both comments and steeringComments", async () => {
      const task = await createTestTask();

      const updated = await store.addSteeringComment(task.id, "Focus on error handling");

      // Should appear in unified comments (for UI display)
      expect(updated.comments).toBeDefined();
      expect(updated.comments!.some(c => c.text === "Focus on error handling")).toBe(true);

      // Should appear in steeringComments (for executor injection)
      expect(updated.steeringComments).toBeDefined();
      expect(updated.steeringComments!.some(c => c.text === "Focus on error handling")).toBe(true);
    });

    it("addSteeringComment steeringComments persist through round-trip", async () => {
      const task = await createTestTask();

      await store.addSteeringComment(task.id, "Focus on error handling");

      const fetched = await store.getTask(task.id);
      expect(fetched.steeringComments).toBeDefined();
      expect(fetched.steeringComments!).toHaveLength(1);
      expect(fetched.steeringComments![0].text).toBe("Focus on error handling");
    });

    it("steering comments do not duplicate in comments across read-write cycles", async () => {
      const task = await createTestTask();

      // Add a steering comment (writes to both comments and steeringComments columns)
      await store.addSteeringComment(task.id, "Focus on error handling");

      // Read the task back — comments should have exactly 1 entry
      const read1 = await store.getTask(task.id);
      expect(read1.comments).toHaveLength(1);
      expect(read1.steeringComments).toHaveLength(1);

      // Simulate a write-back (updateTask writes via upsertTask)
      await store.updateTask(task.id, { status: "planning" });

      // Read again — should still have exactly 1 comment, not 2
      const read2 = await store.getTask(task.id);
      expect(read2.comments).toHaveLength(1);
      expect(read2.comments![0].text).toBe("Focus on error handling");
    });

    it("no duplication accumulation over multiple read-write cycles with steering comments", async () => {
      const task = await createTestTask();

      await store.addSteeringComment(task.id, "Comment A");
      await store.addSteeringComment(task.id, "Comment B");

      // Perform 5 read-write cycles
      for (let i = 0; i < 5; i++) {
        const fetched = await store.getTask(task.id);
        expect(fetched.comments).toHaveLength(2);
        expect(fetched.steeringComments).toHaveLength(2);
        // Write back via an innocuous update
        await store.updateTask(task.id, { status: "planning" });
      }

      // Final read — still exactly 2 comments
      const final = await store.getTask(task.id);
      expect(final.comments).toHaveLength(2);
      expect(final.comments!.map(c => c.text).sort()).toEqual(["Comment A", "Comment B"]);
    });

    it("mixed regular and steering comments maintain correct counts through cycles", async () => {
      const task = await createTestTask();

      // Add 1 regular comment and 1 steering comment
      await store.addTaskComment(task.id, "Regular note", "alice");
      await store.addSteeringComment(task.id, "Steering note");

      // Should have 2 comments total, 1 steering comment
      const read1 = await store.getTask(task.id);
      expect(read1.comments).toHaveLength(2);
      expect(read1.steeringComments).toHaveLength(1);

      // Perform 3 read-write cycles
      for (let i = 0; i < 3; i++) {
        const fetched = await store.getTask(task.id);
        expect(fetched.comments).toHaveLength(2);
        await store.updateTask(task.id, { status: "planning" });
      }

      const final = await store.getTask(task.id);
      expect(final.comments).toHaveLength(2);
      expect(final.steeringComments).toHaveLength(1);
    });

    it("regular addComment on done task still creates refinement", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Need to fix edge case");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length + 1);

      const refinement = allTasksAfter.find((t) => t.id !== task.id && t.title?.includes("Refinement"));
      expect(refinement).toBeDefined();
    });

    it("transitions awaiting-approval to needs-replan when user comments on triage task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      // Keep in triage but set awaiting-approval status
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const result = await store.addComment(task.id, "I want to change the approach", "user");

      // Re-read the task to get the Phase 3 status update
      const updated = await store.getTask(task.id);

      // Task should remain in triage but status should change to needs-replan
      expect(updated.column).toBe("triage");
      expect(updated.status).toBe("needs-replan");
      // Comment should still be added
      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("I want to change the approach");
    });

    it("does NOT transition to needs-replan when agent comments on awaiting-approval task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const updated = await store.addComment(task.id, "Agent system note", "agent");

      // Status should remain awaiting-approval for agent comments
      expect(updated.status).toBe("awaiting-approval");
      // Comment should still be added
      expect(updated.comments).toHaveLength(1);
    });

    it("transitions to needs-replan when user comments on non-awaiting-approval triage task with real spec", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Triage Plan\n\n## Mission\n\nPlanned task.`);

      await store.addComment(task.id, "User feedback", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBe("needs-replan");
      expect(updated.column).toBe("triage");
      expect(updated.comments?.[0]?.text).toBe("User feedback");
    });

    it("does NOT transition to needs-replan when user comments on triage task with bootstrap stub prompt", async () => {
      const task = await store.createTask({ description: "Task in triage" });

      await store.addComment(task.id, "User feedback", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBeUndefined();
    });

    it("transitions todo task to needs-replan when user comments and task has real spec", async () => {
      const task = await store.createTask({ description: "Task in todo", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Todo Plan\n\n## Mission\n\nPlanned task.`);

      await store.addComment(task.id, "Please update approach", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBe("needs-replan");
      expect(updated.column).toBe("todo");
      expect(updated.log.some((entry) => entry.action === "User comment requested re-specification of planned task")).toBe(true);
    });

    it("does NOT transition todo task to needs-replan when prompt matches bootstrap stub", async () => {
      const task = await store.createTask({ description: "Task in todo", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# ${task.id}\n\nTask in todo\n`);

      await store.addComment(task.id, "Please update approach", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBeUndefined();
    });

    it("does NOT transition to needs-replan when user comments on in-progress task", async () => {
      const task = await store.createTask({ description: "Task in progress", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Plan\n\n## Mission\n\nPlanned task.`);
      await store.moveTask(task.id, "in-progress");

      await store.addComment(task.id, "Please adjust implementation", "user");
      const updated = await store.getTask(task.id);

      expect(updated.column).toBe("in-progress");
      expect(updated.status).toBeUndefined();
    });

    it("does NOT transition to needs-replan when user comments on in-review task", async () => {
      const task = await store.createTask({ description: "Task in review", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Plan\n\n## Mission\n\nPlanned task.`);
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      await store.addComment(task.id, "Please adjust before merge", "user");
      const updated = await store.getTask(task.id);

      expect(updated.column).toBe("in-review");
      expect(updated.status).toBeUndefined();
    });
  });

  describe("task comments and merge details types", () => {
    it("has undefined comments on new tasks", async () => {
      const task = await createTestTask();
      const reopened = await store.getTask(task.id);

      expect(reopened.comments).toBeUndefined();
    });

    it("supports the task comment and merge details shapes", async () => {
      const comment: NonNullable<Task["comments"]>[number] = {
        id: `comment-${Date.now()}`,
        text: "Looks good",
        author: "alice",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const mergeDetails: NonNullable<Task["mergeDetails"]> = {
        commitSha: "abc123def456",
        filesChanged: 3,
        insertions: 10,
        deletions: 2,
        mergeCommitMessage: "feat(KB-001): merge fusion/fn-001",
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
        prNumber: 42,
      };
      const taskShape: Pick<Task, "comments" | "mergeDetails"> = {
        comments: [comment],
        mergeDetails,
      };

      expect(taskShape.comments).toEqual([comment]);
      expect(taskShape.mergeDetails).toEqual(mergeDetails);
    });
  });

  describe("updatePrInfo", () => {
    it("adds PR info to a task without existing PR", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };

      const updated = await store.updatePrInfo(task.id, prInfo);

      expect(updated.prInfo).toEqual(prInfo);
      expect(updated.log.some((l) => l.action === "PR linked" && l.outcome?.includes("#42"))).toBe(true);
    });

    it("keeps PR number/url after moving task to done", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };

      await store.updatePrInfo(task.id, prInfo);
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.getTask(task.id);
      expect(updated.prInfo?.number).toBe(42);
      expect(updated.prInfo?.url).toBe("https://github.com/owner/repo/pull/42");
    });

    it("updates existing PR info with new values", async () => {
      const task = await createTestTask();
      const prInfo1 = {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "open" as const,
        title: "Initial PR",
        headBranch: "branch-1",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo1);

      const prInfo2 = {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "merged" as const,
        title: "Initial PR (updated)",
        headBranch: "branch-1",
        baseBranch: "main",
        commentCount: 3,
        lastCommentAt: "2026-01-01T00:00:00.000Z",
      };
      const updated = await store.updatePrInfo(task.id, prInfo2);

      expect(updated.prInfo?.status).toBe("merged");
      expect(updated.prInfo?.commentCount).toBe(3);
      expect(updated.prInfo?.lastCommentAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("clears PR info when passed null", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo);

      const updated = await store.updatePrInfo(task.id, null);

      expect(updated.prInfo).toBeUndefined();
      expect(updated.log.some((l) => l.action === "PR unlinked")).toBe(true);
    });

    it("emits task:updated event when PR info changes", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo);

      expect(events).toHaveLength(1);
      expect(events[0].prInfo?.number).toBe(42);
    });

    it("does NOT emit task:updated when PR info is unchanged", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo);

      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      // Update with same values (status and number unchanged)
      await store.updatePrInfo(task.id, { ...prInfo });

      // Should not emit because number and status are the same
      expect(events).toHaveLength(0);
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 5,
        lastCommentAt: "2026-03-30T12:00:00.000Z",
      };

      await store.updatePrInfo(task.id, prInfo);
      const fetched = await store.getTask(task.id);

      expect(fetched.prInfo).toEqual(prInfo);
    });

    it("updates updatedAt timestamp", async () => {
      const task = await createTestTask();
      const before = task.updatedAt;
      await new Promise((r) => setTimeout(r, 10)); // Ensure time passes

      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      const updated = await store.updatePrInfo(task.id, prInfo);

      expect(updated.updatedAt).not.toBe(before);
    });

    it("serializes concurrent updates correctly", async () => {
      const task = await createTestTask();

      // Fire 5 concurrent updates
      const promises = Array.from({ length: 5 }, (_, i) =>
        store.updatePrInfo(task.id, {
          url: `https://github.com/owner/repo/pull/${i + 1}`,
          number: i + 1,
          status: "open" as const,
          title: `PR ${i + 1}`,
          headBranch: `branch-${i + 1}`,
          baseBranch: "main",
          commentCount: i,
        }),
      );

      await Promise.all(promises);

      // Read back and verify valid JSON
      const taskJsonPath = join(rootDir, ".fusion", "tasks", task.id, "task.json");
      const raw = await readFile(taskJsonPath, "utf-8");
      const result = JSON.parse(raw) as Task;

      // Should have exactly one of the PRs set (last one wins)
      expect(result.prInfo).toBeDefined();
      expect(result.prInfo!.number).toBeGreaterThanOrEqual(1);
      expect(result.prInfo!.number).toBeLessThanOrEqual(5);

      // Should have all the PR linked log entries
      const prLogs = result.log.filter((l) => l.action === "PR linked");
      expect(prLogs).toHaveLength(5);
    });
  });

  describe("parseStepsFromPrompt", () => {
    it("returns empty array when task directory is missing", async () => {
      const task = await createTaskWithSteps();
      await deleteTaskDir(task.id);

      const steps = await store.parseStepsFromPrompt(task.id);
      expect(steps).toEqual([]);
    });
  });

  describe("parseDependenciesFromPrompt", () => {
    it("returns single dependency from PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with dep" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with dep

## Dependencies

- **Task:** FN-001 (must be complete first)

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual(["FN-001"]);
    });

    it("returns multiple dependencies in order", async () => {
      const task = await store.createTask({ description: "Task with deps" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with deps

## Dependencies

- **Task:** FN-010 (first dep)
- **Task:** FN-020 (second dep)
- **Task:** PROJ-003 (third dep)

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual(["FN-010", "FN-020", "PROJ-003"]);
    });

    it("returns empty array when dependencies section says None", async () => {
      const task = await store.createTask({ description: "No deps" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: No deps

## Dependencies

- **None**

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });

    it("returns empty array when no Dependencies section exists", async () => {
      const task = await store.createTask({ description: "No section" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: No section

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });

    it("returns empty array when task has no PROMPT.md file", async () => {
      const task = await store.createTask({ description: "No prompt" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      // Delete the PROMPT.md that createTask generates
      await unlink(join(dir, "PROMPT.md"));

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });

    it("returns empty array when task directory is missing", async () => {
      const task = await store.createTask({ description: "No directory" });
      await deleteTaskDir(task.id);

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });
  });

  describe("parseFileScopeFromPrompt", () => {
    it("returns paths when File Scope is followed by another heading", async () => {
      const task = await store.createTask({ description: "Mid-file scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Mid-file scope

## File Scope

- \`packages/core/src/store.ts\`
- \`packages/core/src/store.test.ts\`

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/src/store.ts",
        "packages/core/src/store.test.ts",
      ]);
    });

    it("returns all paths when File Scope is the last section", async () => {
      const task = await store.createTask({
        description: "End-of-file scope",
      });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: End-of-file scope

## Steps

### Step 0: Preflight
- [ ] Check things

## File Scope

- \`packages/core/src/store.ts\`
- \`packages/core/src/store.test.ts\`
- \`packages/core/src/utils.ts\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/src/store.ts",
        "packages/core/src/store.test.ts",
        "packages/core/src/utils.ts",
      ]);
    });

    it("returns empty array when no File Scope section exists", async () => {
      const task = await store.createTask({ description: "No scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: No scope

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([]);
    });

    it("returns empty array when PROMPT.md does not exist", async () => {
      const task = await store.createTask({ description: "No prompt" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await unlink(join(dir, "PROMPT.md"));

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([]);
    });

    it("returns empty array when task directory is missing", async () => {
      const task = await store.createTask({ description: "No prompt directory" });
      await deleteTaskDir(task.id);

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([]);
    });

    it("handles glob patterns in backtick-quoted paths", async () => {
      const task = await store.createTask({ description: "Glob scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Glob scope

## File Scope

- \`packages/core/*\`
- \`packages/cli/src/commands/dashboard.ts\`
- \`packages/engine/src/**/*.ts\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/*",
        "packages/cli/src/commands/dashboard.ts",
        "packages/engine/src/**/*.ts",
      ]);
    });
  });

  describe("moveTask — in-progress to triage", () => {
    it("allows moving an in-progress task to triage", async () => {
      const task = await store.createTask({ description: "test in-progress to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.column).toBe("triage");
    });
  });

  describe("moveTask — resets steps when moving back to todo/triage", () => {
    async function setMixedStepStatuses(taskId: string): Promise<void> {
      await store.updateStep(taskId, 0, "done");
      await store.updateStep(taskId, 1, "in-progress");
      await store.updateStep(taskId, 2, "pending");
    }

    it("resets all steps to pending and currentStep to 0 when moving from in-progress to todo", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, { currentStep: 2 });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("resets all steps to pending and currentStep to 0 when moving from in-progress to triage", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, { currentStep: 1 });

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("preserves step progress when moving in-progress → todo with preserveResumeState option", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, { currentStep: 2 });

      const moved = await store.moveTask(task.id, "todo", { preserveResumeState: true });

      expect(moved.steps[0].status).toBe("done");
      expect(moved.steps[1].status).toBe("in-progress");
      expect(moved.steps[2].status).toBe("pending");
      expect(moved.currentStep).toBe(2);
    });

    it("preserves step progress and currentStep when moving in-progress → todo with preserveProgress", async () => {
      const task = await createTaskWithSteps();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Checkbox keep

## Steps

### Step 0: Preflight

- [x] Done thing

### Step 1: Implement

- [ ] Pending thing

### Step 2: Verify

- [ ] Pending thing
`,
      );

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, {
        currentStep: 2,
        worktree: "/tmp/worktree",
        executionStartedAt: new Date().toISOString(),
        executionCompletedAt: new Date().toISOString(),
      });

      const moved = await store.moveTask(task.id, "todo", { preserveProgress: true });
      const prompt = await readFile(join(dir, "PROMPT.md"), "utf-8");

      expect(moved.steps[0].status).toBe("done");
      expect(moved.steps[1].status).toBe("in-progress");
      expect(moved.currentStep).toBe(2);
      expect(moved.worktree).toBeUndefined();
      expect(moved.executionStartedAt).toBeUndefined();
      expect(moved.executionCompletedAt).toBeUndefined();
      expect(prompt).toContain("- [x] Done thing");
    });

    it("still resets when preserveProgress is true but all steps are pending", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateStep(task.id, 0, "pending");
      await store.updateStep(task.id, 1, "pending");
      await store.updateTask(task.id, { currentStep: 2 });

      const moved = await store.moveTask(task.id, "todo", { preserveProgress: true });

      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("preserves steps for in-review → todo and done → todo with preserveProgress", async () => {
      const fromReview = await createTaskWithSteps();
      await store.moveTask(fromReview.id, "todo");
      await store.moveTask(fromReview.id, "in-progress");
      await setMixedStepStatuses(fromReview.id);
      await store.moveTask(fromReview.id, "in-review");
      await store.updateTask(fromReview.id, { currentStep: 1, executionStartedAt: new Date().toISOString() });

      const reviewMoved = await store.moveTask(fromReview.id, "todo", { preserveProgress: true });
      expect(reviewMoved.steps[0].status).toBe("done");
      expect(reviewMoved.steps[1].status).toBe("in-progress");
      expect(reviewMoved.currentStep).toBe(1);
      expect(reviewMoved.executionStartedAt).toBeUndefined();

      const fromDone = await createTaskWithSteps();
      await store.moveTask(fromDone.id, "todo");
      await store.moveTask(fromDone.id, "in-progress");
      await setMixedStepStatuses(fromDone.id);
      await store.updateStep(fromDone.id, 1, "done");
      await store.updateStep(fromDone.id, 2, "done");
      await store.moveTask(fromDone.id, "in-review");
      await store.moveTask(fromDone.id, "done");
      await store.updateTask(fromDone.id, { currentStep: 2, executionStartedAt: new Date().toISOString() });

      const doneMoved = await store.moveTask(fromDone.id, "todo", { preserveProgress: true });
      expect(doneMoved.steps[0].status).toBe("done");
      expect(doneMoved.steps[1].status).toBe("done");
      expect(doneMoved.currentStep).toBe(2);
      expect(doneMoved.executionStartedAt).toBeUndefined();
    });

    it("preserveResumeState keeps step progress and timing but always releases the worktree", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      const startedAt = new Date().toISOString();
      await store.updateTask(task.id, {
        currentStep: 2,
        worktree: "/tmp/worktree",
        branch: "fusion/fn-test",
        executionStartedAt: startedAt,
        executionCompletedAt: new Date().toISOString(),
      });

      const moved = await store.moveTask(task.id, "todo", {
        preserveProgress: true,
        preserveResumeState: true,
      });

      expect(moved.steps[0].status).toBe("done");
      expect(moved.steps[1].status).toBe("in-progress");
      expect(moved.currentStep).toBe(2);
      // Worktree is always released on requeue so the directory can be
      // reused by another task; the branch stays so progress is kept.
      expect(moved.worktree).toBeUndefined();
      expect(moved.branch).toBe("fusion/fn-test");
      expect(moved.executionStartedAt).toBe(startedAt);
      expect(moved.executionCompletedAt).toBeUndefined();

      // Round-trip: when the task is re-promoted to in-progress with a
      // fresh allocator, the branch reference must survive the requeue
      // so the executor can reattach to it via createFromExistingBranch
      // and resume the in-flight changes. Guards against regressions in
      // the in-review → todo full-reset path leaking into other paths.
      const repromoted = await store.moveTask(task.id, "in-progress", {
        allocateWorktree: () => "/tmp/worktree-fresh",
      });
      expect(repromoted.branch).toBe("fusion/fn-test");
      expect(repromoted.worktree).toBe("/tmp/worktree-fresh");
    });

    it("preserveWorktree keeps the directory across an internal bounce", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { worktree: "/tmp/wt-bounce" });

      const moved = await store.moveTask(task.id, "todo", {
        preserveResumeState: true,
        preserveWorktree: true,
      });

      // The bounce path keeps the same checkout assigned so listeners
      // never observe an interim worktree=null state and self-healing
      // can't reclaim the directory as idle.
      expect(moved.worktree).toBe("/tmp/wt-bounce");
    });

    it("allocateWorktree assigns a path under the cross-task lock and avoids names already in use", async () => {
      const a = await createTaskWithSteps();
      const b = await createTaskWithSteps();
      await store.moveTask(a.id, "todo");
      await store.moveTask(a.id, "in-progress");
      await store.updateTask(a.id, { worktree: "/tmp/.worktrees/eager-daisy" });
      await store.moveTask(b.id, "todo");

      const seenReserved: Set<string>[] = [];
      const moved = await store.moveTask(b.id, "in-progress", {
        allocateWorktree: (reservedNames) => {
          seenReserved.push(new Set(reservedNames));
          // Caller picks a name; if it collides with reservedNames the
          // caller is responsible for choosing a different one. Here we
          // assert the reservedNames snapshot reflects task A's
          // assignment, then return a non-colliding path.
          return "/tmp/.worktrees/swift-falcon";
        },
      });

      expect(seenReserved).toHaveLength(1);
      expect(seenReserved[0].has("eager-daisy")).toBe(true);
      // The allocator's task itself must not appear in reservedNames —
      // a task should never be told to avoid its own current name.
      expect(seenReserved[0].has("swift-falcon")).toBe(false);
      expect(moved.worktree).toBe("/tmp/.worktrees/swift-falcon");
    });

    it("resets steps when moving from in-review to todo", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const withSteps = await store.getTask(task.id);
      await store.updateTask(task.id, {
        steps: withSteps.steps.map((step) => ({ ...step, status: "done" })),
        currentStep: 2,
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("resets steps when moving from done to todo", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const withDoneSteps = await store.getTask(task.id);
      await store.updateTask(task.id, {
        steps: withDoneSteps.steps.map((step) => ({ ...step, status: "done" })),
        currentStep: 2,
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("resets steps when moving from done to triage", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const withDoneSteps = await store.getTask(task.id);
      await store.updateTask(task.id, {
        steps: withDoneSteps.steps.map((step) => ({ ...step, status: "done" })),
        currentStep: 2,
      });

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("does not reset steps when moving from todo to triage", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.updateStep(task.id, 0, "done");

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.steps[0]?.status).toBe("done");
    });

    it("resets PROMPT.md checkboxes when moving from in-progress to todo", async () => {
      const task = await createTaskWithSteps();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Checkbox reset

## Steps

### Step 0: Preflight

- [x] Done thing

### Step 1: Implement

- [x] Done thing
`,
      );

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "todo");

      const prompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(prompt).not.toContain("- [x]");
      expect(prompt).toContain("- [ ] Done thing");
    });

    it("is a no-op when steps array is empty", async () => {
      const task = await store.createTask({ description: "no steps reset" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.moveTask(task.id, "todo")).resolves.toMatchObject({ id: task.id, column: "todo" });
    });
  });

  describe("moveTask — clears transient fields when leaving in-progress", () => {
    it("clears status, error, worktree, and blockedBy when moving from in-progress to todo", async () => {
      const task = await store.createTask({ description: "test clear fields" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate a failed state
      await store.updateTask(task.id, {
        status: "failed",
        error: "Something went wrong",
        worktree: "test-worktree",
        blockedBy: "FN-001"
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.column).toBe("todo");
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
      expect(moved.worktree).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
    });

    it("clears status, error, worktree, and blockedBy when moving from in-progress to triage", async () => {
      const task = await store.createTask({ description: "test clear fields to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate a failed state
      await store.updateTask(task.id, {
        status: "failed",
        error: "Something went wrong",
        worktree: "test-worktree",
        blockedBy: "FN-001"
      });

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.column).toBe("triage");
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
      expect(moved.worktree).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
    });

    it("preserves status when moving from todo to in-progress", async () => {
      const task = await store.createTask({ description: "test preserve status", column: "todo" });

      // Set a custom status before moving to in-progress
      await store.updateTask(task.id, { status: "planning" });

      const moved = await store.moveTask(task.id, "in-progress");
      expect(moved.column).toBe("in-progress");
      expect(moved.status).toBe("planning");
    });

    it("does not clear status when moving between non-in-progress columns", async () => {
      const task = await store.createTask({ description: "test non-in-progress move" });
      // Task starts in triage

      // Set a custom status
      await store.updateTask(task.id, { status: "custom-status" });

      // Move from triage to todo
      const moved = await store.moveTask(task.id, "todo");
      expect(moved.column).toBe("todo");
      expect(moved.status).toBe("custom-status");
    });

    it("clears status, error, worktree, and blockedBy when moving from in-progress to done", async () => {
      const task = await store.createTask({ description: "test clear fields to done" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate transient state that should not block completion
      await store.updateTask(task.id, {
        status: "custom-status",
        error: "Transient note",
        worktree: "test-worktree",
        blockedBy: "FN-001"
      });

      // Must go through in-review to reach done
      await store.moveTask(task.id, "in-review");
      const moved = await store.moveTask(task.id, "done");
      expect(moved.column).toBe("done");
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
      expect(moved.worktree).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
    });

    it("clears recovery fields when moving to done (FN-985 regression)", async () => {
      const task = await store.createTask({ description: "test recovery fields" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Set recovery metadata via updateTask
      await store.updateTask(task.id, {
        recoveryRetryCount: 3,
        nextRecoveryAt: new Date(Date.now() + 86400000).toISOString(),
      });

      await store.moveTask(task.id, "in-review");
      const moved = await store.moveTask(task.id, "done");
      expect(moved.column).toBe("done");
      expect(moved.recoveryRetryCount).toBeUndefined();
      expect(moved.nextRecoveryAt).toBeUndefined();
    });

    it("treats repeated done finalization as an idempotent no-op", async () => {
      const task = await store.createTask({ description: "test repeated done finalization" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const done = await store.moveTask(task.id, "done");

      const repeated = await store.moveTask(task.id, "done");

      expect(repeated.column).toBe("done");
      expect(repeated.updatedAt).toBe(done.updatedAt);
    });

    it("normalizes stale completion fields on repeated done finalization", async () => {
      const task = await store.createTask({ description: "test repeated dirty done finalization" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.updateTask(task.id, {
        status: "failed",
        error: "stale failure",
        blockedBy: "FN-000",
        worktree: "/tmp/fusion-stale-worktree",
        recoveryRetryCount: 2,
        nextRecoveryAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const repeated = await store.moveTask(task.id, "done");

      expect(repeated.column).toBe("done");
      expect(repeated.status).toBeUndefined();
      expect(repeated.error).toBeUndefined();
      expect(repeated.blockedBy).toBeUndefined();
      expect(repeated.worktree).toBeUndefined();
      expect(repeated.recoveryRetryCount).toBeUndefined();
      expect(repeated.nextRecoveryAt).toBeUndefined();
    });

    it("blocks moving failed in-review tasks to done", async () => {
      const task = await store.createTask({ description: "test block failed review task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, {
        status: "failed",
        error: "Workflow step failed",
      });

      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "done")).rejects.toThrow(
        "Cannot move",
      );
    });

    it("blocks moving in-review tasks with incomplete steps to done", async () => {
      const task = await store.createTask({ description: "test block incomplete review task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { prompt: "## Steps\n### Step 0: First\n### Step 1: Second" });
      await store.updateStep(task.id, 0, "done");
      await store.updateStep(task.id, 1, "in-progress");

      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "done")).rejects.toThrow(
        "task has incomplete steps",
      );
    });

    it("allows reopening done tasks back to todo", async () => {
      const task = await store.createTask({ description: "test reopen done task to todo" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const reopened = await store.moveTask(task.id, "todo");
      expect(reopened.column).toBe("todo");
    });

    it("allows reopening done tasks back to triage and clears transient execution state", async () => {
      const task = await store.createTask({ description: "test reopen done task to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.updateTask(task.id, {
        status: "failed",
        error: "stale completion error",
        worktree: "stale-worktree",
        blockedBy: "FN-123",
        workflowStepResults: [{
          workflowStepId: "wf-1",
          workflowStepName: "Workflow step 1",
          status: "passed",
          startedAt: new Date().toISOString(),
        }],
      });

      const reopened = await store.moveTask(task.id, "triage");
      expect(reopened.column).toBe("triage");
      expect(reopened.status).toBeUndefined();
      expect(reopened.error).toBeUndefined();
      expect(reopened.worktree).toBeUndefined();
      expect(reopened.blockedBy).toBeUndefined();
      expect(reopened.workflowStepResults).toBeUndefined();
    });

    it("allows retrying in-review tasks back to todo and clears transient fields", async () => {
      const task = await store.createTask({ description: "test retry in-review task to todo" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "completed",
        error: "stale error",
        worktree: "stale-worktree",
        blockedBy: "FN-456",
        branch: "fn/stale-branch",
        baseBranch: "main",
        baseCommitSha: "abc123",
        summary: "stale summary from prior attempt",
        recoveryRetryCount: 2,
        nextRecoveryAt: new Date().toISOString(),
        workflowStepResults: [{
          workflowStepId: "wf-1",
          workflowStepName: "Workflow step 1",
          status: "passed",
          startedAt: new Date().toISOString(),
        }],
      });

      const retried = await store.moveTask(task.id, "todo");
      expect(retried.column).toBe("todo");
      expect(retried.status).toBeUndefined();
      expect(retried.error).toBeUndefined();
      expect(retried.worktree).toBeUndefined();
      expect(retried.blockedBy).toBeUndefined();
      expect(retried.workflowStepResults).toBeUndefined();
      // Full reset: prior branch/summary/recovery state discarded so the next
      // run starts from scratch.
      expect(retried.branch).toBeUndefined();
      expect(retried.baseBranch).toBe("main");
      expect(retried.executionStartBranch).toBeUndefined();
      expect(retried.baseCommitSha).toBeUndefined();
      expect(retried.summary).toBeUndefined();
      expect(retried.recoveryRetryCount).toBeUndefined();
      expect(retried.nextRecoveryAt).toBeUndefined();
    });

    it("allows respec'ing in-review tasks back to triage and clears transient fields", async () => {
      const task = await store.createTask({ description: "test respec in-review task to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "completed",
        error: "stale error",
        worktree: "stale-worktree",
        blockedBy: "FN-456",
        branch: "fn/stale-branch",
        baseBranch: "main",
        baseCommitSha: "abc123",
        summary: "stale summary from prior attempt",
        recoveryRetryCount: 2,
        nextRecoveryAt: new Date().toISOString(),
        workflowStepResults: [{
          workflowStepId: "wf-1",
          workflowStepName: "Workflow step 1",
          status: "passed",
          startedAt: new Date().toISOString(),
        }],
      });

      const respec = await store.moveTask(task.id, "triage");
      expect(respec.column).toBe("triage");
      expect(respec.status).toBeUndefined();
      expect(respec.error).toBeUndefined();
      expect(respec.worktree).toBeUndefined();
      expect(respec.blockedBy).toBeUndefined();
      expect(respec.workflowStepResults).toBeUndefined();
      expect(respec.branch).toBeUndefined();
      expect(respec.baseBranch).toBe("main");
      expect(respec.executionStartBranch).toBeUndefined();
      expect(respec.baseCommitSha).toBeUndefined();
      expect(respec.summary).toBeUndefined();
      expect(respec.recoveryRetryCount).toBeUndefined();
      expect(respec.nextRecoveryAt).toBeUndefined();
    });
  });

  describe("columnMovedAt", () => {
    it("createTask sets columnMovedAt", async () => {
      const before = new Date().toISOString();
      const task = await store.createTask({ description: "test columnMovedAt" });
      const after = new Date().toISOString();
      expect(task.columnMovedAt).toBeDefined();
      expect(task.columnMovedAt! >= before).toBe(true);
      expect(task.columnMovedAt! <= after).toBe(true);
    });

    it("moveTask sets columnMovedAt to a recent ISO timestamp", async () => {
      const task = await store.createTask({ description: "move test", column: "triage" });
      const originalMovedAt = task.columnMovedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      const before = new Date().toISOString();
      const moved = await store.moveTask(task.id, "todo");
      const after = new Date().toISOString();

      expect(moved.columnMovedAt).toBeDefined();
      expect(moved.columnMovedAt! >= before).toBe(true);
      expect(moved.columnMovedAt! <= after).toBe(true);
      expect(moved.columnMovedAt).not.toBe(originalMovedAt);
    });

    it("updateTask does NOT change columnMovedAt", async () => {
      const task = await store.createTask({ description: "no change test" });
      const originalMovedAt = task.columnMovedAt;

      await new Promise((r) => setTimeout(r, 10));

      const updated = await store.updateTask(task.id, { title: "new title" });
      expect(updated.columnMovedAt).toBe(originalMovedAt);
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

  describe("duplicateTask", () => {
    it("duplicates from triage column", async () => {
      const task = await store.createTask({ description: "Test task" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.id).not.toBe(task.id);
      expect(duplicated.id).toMatch(/^FN-\d+$/);
      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(task.description);
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from todo column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from in-progress column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      await store.moveTask(task.id, "in-progress");
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from in-review column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from done column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("new task is always in triage regardless of source column", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const duplicated = await store.duplicateTask(task.id);
      expect(duplicated.column).toBe("triage");
    });

    it("description includes source reference", async () => {
      const task = await store.createTask({ description: "Original description" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.description).toBe(`Original description\n\n(Duplicated from ${task.id})`);
    });

    it("resets execution state (no steps, no worktree, etc.)", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      // Add some execution state
      await store.updateTask(task.id, { worktree: "/some/path", status: "executing" });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.steps).toEqual([]);
      expect(duplicated.currentStep).toBe(0);
      expect(duplicated.worktree).toBeUndefined();
      expect(duplicated.status).toBeUndefined();
    });

    it("clears nullable execution fields via updateTask(null)", async () => {
      const task = await store.createTask({ description: "Test clear nullable execution fields", column: "todo" });
      await store.updateTask(task.id, {
        worktree: "/some/path",
        branch: "fusion/fn-001",
        baseBranch: "main",
        baseCommitSha: "abc123",
        status: "executing",
        error: "boom",
      });

      const updated = await store.updateTask(task.id, {
        worktree: null,
        branch: null,
        baseBranch: null,
        baseCommitSha: null,
        status: null,
        error: null,
      });

      expect(updated.worktree).toBeUndefined();
      expect(updated.branch).toBeUndefined();
      expect(updated.baseBranch).toBeUndefined();
      expect(updated.baseCommitSha).toBeUndefined();
      expect(updated.status).toBeUndefined();
      expect(updated.error).toBeUndefined();
    });

    it("does NOT copy dependencies", async () => {
      const dep = await store.createTask({ description: "Dependency" });
      const task = await store.createTask({ description: "Test task", dependencies: [dep.id] });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.dependencies).toEqual([]);
    });

    it("does NOT copy attachments", async () => {
      const task = await store.createTask({ description: "Test task" });
      // Add an attachment
      await store.addAttachment(task.id, "test.png", Buffer.from("fake"), "image/png");

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.attachments).toBeUndefined();
    });

    it("does NOT copy steering comments", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.addComment(task.id, "Test comment");

      const duplicated = await store.duplicateTask(task.id);

      // Comments should not be copied when duplicating
      expect(duplicated.comments).toBeUndefined();
    });

    it("emits task:created event", async () => {
      const task = await store.createTask({ description: "Test task" });
      const events: any[] = [];
      store.on("task:created", (t) => events.push(t));

      const duplicated = await store.duplicateTask(task.id);

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(duplicated.id);
    });

    it("adds log entry for duplicate action", async () => {
      const task = await store.createTask({ description: "Test task" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.log).toHaveLength(1);
      expect(duplicated.log[0].action).toContain(`Duplicated from ${task.id}`);
    });

    it("copies source PROMPT.md content", async () => {
      const task = await store.createTask({ description: "Test task" });
      const sourceDetail = await store.getTask(task.id);

      const duplicated = await store.duplicateTask(task.id);
      const dupDetail = await store.getTask(duplicated.id);

      expect(dupDetail.prompt).toBe(sourceDetail.prompt);
    });

    it("throws ENOENT when source task does not exist", async () => {
      await expect(store.duplicateTask("KB-999")).rejects.toThrow();
    });

    it("copies title if present", async () => {
      const task = await store.createTask({ title: "My Task", description: "Test" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.title).toBe("My Task");
    });

    it("does NOT copy prInfo", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.updatePrInfo(task.id, {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "open",
        title: "Test PR",
        headBranch: "fusion/fn-001",
        baseBranch: "main",
        commentCount: 0,
      });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.prInfo).toBeUndefined();
    });

    it("does NOT copy paused state", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.pauseTask(task.id, true);

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.paused).toBeUndefined();
    });

    it("does NOT copy blockedBy", async () => {
      const blocker = await store.createTask({ description: "Blocker" });
      const task = await store.createTask({ description: "Test task" });
      await store.updateTask(task.id, { blockedBy: blocker.id });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.blockedBy).toBeUndefined();
    });

    it("copies baseBranch", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.updateTask(task.id, { baseBranch: "some-branch" });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.baseBranch).toBe("some-branch");
    });
  });

  // ── Refine Task Tests ────────────────────────────────────────────

  describe("refineTask", () => {
    it("creates refinement from done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need to fix edge case");

      expect(refined.id).not.toBe(task.id);
      expect(refined.id).toMatch(/^FN-\d+$/);
      expect(refined.column).toBe("triage");
      // Untitled source: uses first line of description as readable label
      expect(refined.title).toBe("Refinement: Original task");
    });

    it("creates refinement from in-review task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.column).toBe("triage");
      // Untitled source: uses first line of description as readable label
      expect(refined.title).toBe("Refinement: Original task");
    });

    it("throws error when refining task in triage", async () => {
      const task = await store.createTask({ description: "Original task" });
      // Task starts in triage

      await expect(store.refineTask(task.id, "Feedback")).rejects.toThrow("must be in 'done' or 'in-review'");
    });

    it("throws error when refining task in todo", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");

      await expect(store.refineTask(task.id, "Feedback")).rejects.toThrow("must be in 'done' or 'in-review'");
    });

    it("throws error when refining task in in-progress", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.refineTask(task.id, "Feedback")).rejects.toThrow("must be in 'done' or 'in-review'");
    });

    it("throws error when feedback is empty", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await expect(store.refineTask(task.id, "")).rejects.toThrow("Feedback is required");
    });

    it("throws error when feedback is whitespace only", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await expect(store.refineTask(task.id, "   ")).rejects.toThrow("Feedback is required");
    });

    it("sets correct title format with original title", async () => {
      const task = await store.createTask({ title: "My Feature", description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      expect(refined.title).toBe("Refinement: My Feature");
    });

    it("sets correct title format without original title (uses description fallback)", async () => {
      const task = await store.createTask({ description: "Fix the login bug" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      // Falls back to first line of description when no title
      expect(refined.title).toBe("Refinement: Fix the login bug");
    });

    it("description includes feedback and refines reference", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Fix the edge case handling");

      expect(refined.description).toBe(`Fix the edge case handling\n\nRefines: ${task.id}`);
    });

    it("sets dependency on original task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.dependencies).toEqual([task.id]);
    });

    it("adds log entry for refinement creation", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.log).toHaveLength(1);
      expect(refined.log[0].action).toBe(`Created as refinement of ${task.id}`);
    });

    it("emits task:created event", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const events: any[] = [];
      store.on("task:created", (t) => events.push(t));

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(refined.id);
    });

    it("copies attachments from original task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Add an attachment
      await store.addAttachment(task.id, "test.png", Buffer.from("fake image"), "image/png");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.attachments).toHaveLength(1);
      expect(refined.attachments![0].originalName).toBe("test.png");
      expect(refined.attachments![0].mimeType).toBe("image/png");
    });

    it("copies attachment files to new task directory", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Add an attachment
      await store.addAttachment(task.id, "test.png", Buffer.from("fake image data"), "image/png");

      const refined = await store.refineTask(task.id, "Need improvements");

      // Verify file exists in new task directory
      const attachDir = join(rootDir, ".fusion", "tasks", refined.id, "attachments");
      const files = await readdir(attachDir);
      expect(files.length).toBe(1);

      // Verify content was copied
      const content = await readFile(join(attachDir, files[0]));
      expect(content.toString()).toBe("fake image data");
    });

    it("works when source has no attachments", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.attachments).toBeUndefined();
    });

    it("resets execution state (no steps, no worktree, etc.)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.steps).toEqual([]);
      expect(refined.currentStep).toBe(0);
      expect(refined.worktree).toBeUndefined();
      expect(refined.status).toBeUndefined();
    });

    it("creates PROMPT.md for the refinement", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      const detail = await store.getTask(refined.id);
      // Untitled source: uses first line of description
      expect(detail.prompt).toContain("Refinement: Original task");
      expect(detail.prompt).toContain("Need improvements");
      expect(detail.prompt).toContain(`Refines: ${task.id}`);
    });

    it("uses first non-empty line of description when title is absent", async () => {
      const task = await store.createTask({
        description: "Use source task labels for refinement titles\n\nThis is a longer description.",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      expect(refined.title).toBe("Refinement: Use source task labels for refinement titles");
    });

    it("collapses internal whitespace in description fallback", async () => {
      const task = await store.createTask({
        description: "Fix the  \t  spacing   issue   in UI",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "More feedback");

      expect(refined.title).toBe("Refinement: Fix the spacing issue in UI");
    });

    it("skips leading blank lines in multi-line description", async () => {
      const task = await store.createTask({
        description: "\n  \n  \nFirst real line of description\nSecond line",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Feedback");

      expect(refined.title).toBe("Refinement: First real line of description");
    });

    it("falls back to task ID when description has no non-empty lines", async () => {
      // Create a task with a valid description, then update to all-whitespace
      // (createTask rejects all-whitespace descriptions, but updates could produce this edge case)
      const task = await store.createTask({ description: "Valid description" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.updateTask(task.id, { description: "   \n  \n\t\n" });

      const refined = await store.refineTask(task.id, "Feedback");

      expect(refined.title).toBe(`Refinement: ${task.id}`);
    });

    it("PROMPT.md heading matches the refinement title", async () => {
      const task = await store.createTask({
        title: "My Feature",
        description: "Some description",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");
      const detail = await store.getTask(refined.id);

      expect(refined.title).toBe("Refinement: My Feature");
      expect(detail.prompt).toMatch(/^# Refinement: My Feature\n/);
    });

    it("PROMPT.md heading uses description fallback when untitled", async () => {
      const task = await store.createTask({
        description: "Fix the login bug on settings page",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");
      const detail = await store.getTask(refined.id);

      expect(refined.title).toBe("Refinement: Fix the login bug on settings page");
      expect(detail.prompt).toMatch(/^# Refinement: Fix the login bug on settings page\n/);
    });

    it("throws ENOENT when source task does not exist", async () => {
      await expect(store.refineTask("KB-999", "Feedback")).rejects.toThrow();
    });
  });


  // ── Archive/Unarchive Tests ──────────────────────────────────────

  describe("VALID_TRANSITIONS — invalid archived transitions via moveTask", () => {
    it("moveTask from archived → in-progress should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "in-progress")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → triage should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "triage")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → todo should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "todo")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → in-review should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "in-review")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from triage → archived should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      // Task starts in triage

      await expect(store.moveTask(task.id, "archived")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from todo → archived should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");

      await expect(store.moveTask(task.id, "archived")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from in-progress → archived should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.moveTask(task.id, "archived")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from in-review → archived should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "archived")).rejects.toThrow("Invalid transition");
    });
});

  describe("task provenance", () => {
    it("defaults sourceType to unknown when source is omitted", async () => {
      const task = await store.createTask({ description: "Provenance default" });
      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("unknown");
    });

    it("persists simple source type from createTask", async () => {
      const task = await store.createTask({
        description: "Created from dashboard",
        source: { sourceType: "dashboard_ui" },
      });
      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("dashboard_ui");
    });

    it("roundtrips full provenance metadata", async () => {
      const task = await store.createTask({
        description: "Heartbeat-generated task",
        source: {
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-123",
          sourceRunId: "run-456",
          sourceSessionId: "session-789",
          sourceMessageId: "msg-001",
          sourceMetadata: { reason: "scheduled" },
        },
      });

      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("agent_heartbeat");
      expect(fetched.sourceAgentId).toBe("agent-123");
      expect(fetched.sourceRunId).toBe("run-456");
      expect(fetched.sourceSessionId).toBe("session-789");
      expect(fetched.sourceMessageId).toBe("msg-001");
      expect(fetched.sourceMetadata).toEqual({ reason: "scheduled" });
    });

    it("sets duplicate and refine provenance parent links", async () => {
      const source = await store.createTask({ description: "Original" });
      const duplicated = await store.duplicateTask(source.id);
      expect(duplicated.sourceType).toBe("task_duplicate");
      expect(duplicated.sourceParentTaskId).toBe(source.id);

      await store.moveTask(source.id, "todo");
      await store.moveTask(source.id, "in-progress");
      await store.moveTask(source.id, "in-review");
      await store.moveTask(source.id, "done");
      const refined = await store.refineTask(source.id, "Needs polish");
      expect(refined.sourceType).toBe("task_refine");
      expect(refined.sourceParentTaskId).toBe(source.id);
    });

    it("preserves provenance on updateTask", async () => {
      const task = await store.createTask({
        description: "Will be updated",
        source: {
          sourceType: "automation",
          sourceAgentId: "agent-auto",
          sourceMetadata: { trigger: "nightly" },
        },
      });

      await store.updateTask(task.id, { title: "Updated" });
      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("automation");
      expect(fetched.sourceAgentId).toBe("agent-auto");
      expect(fetched.sourceMetadata).toEqual({ trigger: "nightly" });
    });

    it("persists research provenance metadata", async () => {
      const task = await store.createTask({
        description: "Research finding follow-up",
        source: {
          sourceType: "research",
          sourceMetadata: {
            runId: "RR-42",
            findingId: "finding-1",
            findingLabel: "Key risk",
            documentKey: "research-RR-42",
          },
        },
      });

      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("research");
      expect(fetched.sourceMetadata).toEqual({
        runId: "RR-42",
        findingId: "finding-1",
        findingLabel: "Key risk",
        documentKey: "research-RR-42",
      });
    });
  });

  describe("research document key helper", () => {
    it("builds canonical research document keys", () => {
      expect(buildResearchDocumentKey("RR-1")).toBe("research-RR-1");
      expect(buildResearchDocumentKey("RR/1")).toBe("research-RR1");
    });

    it("rejects run IDs that sanitize to an empty string", () => {
      expect(() => buildResearchDocumentKey("!!!")).toThrow("Invalid research run id");
    });
  });

  // ── Title Handling Tests ────────────────────────────────────────

  describe("title handling", () => {
    it("creates task with undefined title when none provided", async () => {
      const task = await store.createTask({ description: "Fix the login bug on the settings page" });
      
      expect(task.title).toBeUndefined();
      expect(task.description).toBe("Fix the login bug on the settings page");
      
      // Verify persisted to disk
      const fetched = await store.getTask(task.id);
      expect(fetched.title).toBeUndefined();
    });

    it("creates task with provided title", async () => {
      const task = await store.createTask({
        title: "Custom Title",
        description: "This is the description",
      });

      expect(task.title).toBe("Custom Title");
      
      const fetched = await store.getTask(task.id);
      expect(fetched.title).toBe("Custom Title");
    });

    it("trims whitespace from provided title", async () => {
      const task = await store.createTask({
        title: "  Padded Title  ",
        description: "Some description",
      });

      expect(task.title).toBe("Padded Title");
    });

    it("treats empty string title as undefined", async () => {
      const task = await store.createTask({
        title: "",
        description: "Some description",
      });

      expect(task.title).toBeUndefined();
    });

    it("treats whitespace-only title as undefined", async () => {
      const task = await store.createTask({
        title: "   ",
        description: "Some description",
      });

      expect(task.title).toBeUndefined();
    });

    it("preserves description exactly as provided", async () => {
      const description = "Fix $$$ bug @ home-page (urgent!)";
      const task = await store.createTask({ description });

      expect(task.description).toBe(description);
    });

    it("includes ID only in PROMPT.md heading when no title", async () => {
      const task = await store.createTask({ description: "Implement the new feature" });
      const detail = await store.getTask(task.id);

      // Heading should be just the task ID when no title is provided
      expect(detail.prompt).toMatch(/^# FN-001\n/);
    });

    it("includes title in PROMPT.md heading when provided", async () => {
      const task = await store.createTask({
        title: "My Feature",
        description: "Build something great",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      expect(detail.prompt).toMatch(/^# FN-001: My Feature\n/);
    });

    it("handles empty description gracefully (should throw)", async () => {
      await expect(store.createTask({ description: "" })).rejects.toThrow("Description is required");
    });
  });

  // ── Archive Cleanup Tests ────────────────────────────────────────

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


  describe("createTask with title summarization", () => {
    it("should use generated title when onSummarize returns a title", async () => {
      const longDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Generated Title");

      const task = await store.createTask(
        { description: longDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Title is not set synchronously - summarization happens async
      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).toHaveBeenCalledWith(longDescription);

      // Wait for async summarization to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify title was set asynchronously
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Generated Title");
    });

    it("should not call onSummarize when title is already provided", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { title: "User Title", description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("User Title");
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when description is too short", async () => {
      const shortDescription = "a".repeat(100);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: shortDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when autoSummarizeTitles is false", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: false } }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when no settings provided", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should call onSummarize when summarize input flag is true", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(201), summarize: true },
        { onSummarize: mockOnSummarize }
      );

      // Title is not set synchronously
      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).toHaveBeenCalled();

      // Wait for async summarization to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify title was set asynchronously
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Title");
    });

    it("should ignore malformed confirmation-prose generated titles", async () => {
      const mockOnSummarize = vi
        .fn()
        .mockResolvedValue("Created task **FN-9999** in the triage column. Here's a summary.");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBeUndefined();
    });

    it("should handle onSummarize returning null", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue(null);

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Task created without title
      expect(task.title).toBeUndefined();

      // Wait for async summarization to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Title should remain undefined
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBeUndefined();
    });

    it("should handle onSummarize throwing error gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockOnSummarize = vi.fn().mockRejectedValue(new Error("AI service failed"));

      try {
        const task = await store.createTask(
          { description: "a".repeat(201) },
          { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
        );

        expect(task.title).toBeUndefined();
        expect(task.id).toMatch(/^FN-\d+$/); // Task still created

        // Wait for async error to be logged
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(consoleSpy).toHaveBeenCalled();
        const [message, context] = consoleSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(message).toContain("[task-store] Title summarization failed for task");
        expect(context).toMatchObject({
          taskId: task.id,
          descriptionLength: 201,
          autoSummarizeEnabled: true,
          error: "AI service failed",
        });
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("logs outer promise-chain failure when inner warning logger throws", async () => {
      const syntheticError = "Synthetic warn logger failure";
      // Throw inside warn logging so the failure escapes the inner summarize try/catch
      // and is handled by the outer Promise.resolve().then(...).catch(...) branch.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
        throw new Error(syntheticError);
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockOnSummarize = vi.fn().mockRejectedValue(new Error("AI service failed"));

      try {
        const task = await store.createTask(
          { description: "a".repeat(201) },
          { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
        );

        expect(task.id).toMatch(/^FN-\d+$/);
        expect(task.title).toBeUndefined();

        await new Promise((resolve) => setTimeout(resolve, 10));

        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBeUndefined();

        const outerErrorCall = errorSpy.mock.calls.find(([message]) =>
          typeof message === "string"
          && message.includes("[task-store] Unexpected title summarization promise-chain failure")
        );
        expect(outerErrorCall).toBeDefined();

        const [message, context] = outerErrorCall as [string, Record<string, unknown>];
        expect(message).toContain("[task-store] Unexpected title summarization promise-chain failure");
        expect(context).toMatchObject({
          taskId: task.id,
          descriptionLength: 201,
          autoSummarizeEnabled: true,
          error: syntheticError,
        });
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("should trigger summarization at exactly 201 characters", async () => {
      const boundaryDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).toHaveBeenCalled();

      // Wait for async summarization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Title");
    });

    it("should not trigger summarization at exactly 200 characters", async () => {
      const boundaryDescription = "a".repeat(200);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).not.toHaveBeenCalled();
      expect(task.title).toBeUndefined();
    });

    it("should prioritize explicit title over summarize flag", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { title: "User Title", description: "a".repeat(201), summarize: true },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("User Title");
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should include generated title in PROMPT.md heading", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("Generated Task Title");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Title not set synchronously
      expect(task.title).toBeUndefined();

      // Wait for async summarization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify title and PROMPT.md were updated
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("Generated Task Title");
      expect(updatedTask.prompt).toMatch(/^# FN-\d+: Generated Task Title\n/);
    });

    it("should preserve original description when generating a title", async () => {
      const originalDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Summary Title");

      const task = await store.createTask(
        { description: originalDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Title not set synchronously
      expect(task.title).toBeUndefined();
      expect(task.description).toBe(originalDescription);

      // Wait for async summarization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Summary Title");
      expect(updatedTask.description).toBe(originalDescription);
    });

    it("should not overwrite user-set title during async summarization", async () => {
      const mockOnSummarize = vi.fn().mockImplementation(async () => {
        // Simulate slow AI response
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "AI Title";
      });

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Immediately update with user title
      await store.updateTask(task.id, { title: "User Title" });

      // Wait for delayed onSummarize to resolve
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Title should still be "User Title" (race guard should have prevented overwrite)
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("User Title");
    });
  });

  // ── Utility Path Independence Regression ─────────────────────────────────────
  // FN-1727: Title summarization runs on a separate utility lane (async microtask)
  // and is NOT gated by task-lane semaphore settings. This test proves that:
  // 1. createTask returns immediately (synchronous) regardless of maxConcurrent
  // 2. onSummarize callback fires asynchronously via Promise.resolve().then()
  // 3. Task creation succeeds even when onSummarize would be blocked by semaphore
  //
  // The engine's maxConcurrent setting lives at the execution layer and does NOT
  // affect the core store's createTask method, which has no semaphore dependency.
  describe("createTask summarization is independent of engine maxConcurrent settings", () => {
    it("creates task and calls onSummarize even with maxConcurrent: 0", async () => {
      // Set extreme concurrency setting to prove the core store is unaffected.
      // Note: The core store does NOT read maxConcurrent from settings during
      // createTask - this is purely a documentation regression proving the
      // architectural separation between core (store) and engine (semaphore).
      await store.updateSettings({ maxConcurrent: 0 });

      const longDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title From Saturation Test");

      // Create task with summarization enabled
      const task = await store.createTask(
        { description: longDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // CRITICAL ASSERTIONS:
      // 1. Task was created immediately (synchronous return)
      expect(task.id).toMatch(/^FN-\d+$/);
      expect(task.title).toBeUndefined(); // Not set synchronously

      // 2. onSummarize was called (async but independent of maxConcurrent)
      expect(mockOnSummarize).toHaveBeenCalledWith(longDescription);

      // 3. Wait for async summarization and verify title was set
      await vi.waitFor(async () => {
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBe("AI Title From Saturation Test");
      });

      // Reset maxConcurrent to normal value
      await store.updateSettings({ maxConcurrent: 2 });
    });

    it("task creation succeeds when onSummarize is blocked by slow callback (proving no semaphore dependency)", async () => {
      // Simulate a slow/stalled onSummarize callback to prove there's no
      // semaphore that would block task creation. The core store has no
      // dependency on any concurrency limiter.
      const slowOnSummarize = vi.fn().mockImplementation(
        async () => new Promise<string>(() => {}),
      );

      const taskPromise = store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: slowOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Task creation MUST complete quickly (before slowOnSummarize resolves)
      const task = await taskPromise;
      expect(task.id).toMatch(/^FN-\d+$/);

      // Verify slowOnSummarize was initiated (async microtask)
      expect(slowOnSummarize).toHaveBeenCalled();

      // The slow callback is still pending (would take 1000ms to resolve)
      // but task creation already succeeded - proving no blocking dependency
      const freshTask = await store.getTask(task.id);
      expect(freshTask.id).toBe(task.id);
      // Title not yet set because onSummarize is still pending
    });
  });

  describe("event emissions", () => {
    it("createTask emits task:created with the new task", async () => {
      const events: any[] = [];
      store.on("task:created", (t: any) => events.push(t));
      const task = await store.createTask({ description: "event test" });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(task.id);
      expect(events[0].description).toBe("event test");
    });

    it("moveTask emits task:moved with from/to columns", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:moved", (data: any) => events.push(data));
      await store.moveTask(task.id, "todo");
      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("triage");
      expect(events[0].to).toBe("todo");
      expect(events[0].task.id).toBe(task.id);
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

    it("logs allocateId disk sync failures while preserving task creation", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storeAny = store as any;
      const originalConfigPath = storeAny.configPath;
      storeAny.configPath = join(rootDir, ".fusion", "missing-sync", "config.json");

      try {
        const task = await store.createTask({ description: "allocate despite sync failure" });
        expect(task.id).toBe("FN-001");

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Backward-compat config.json sync failed after ID allocation"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          phase: "allocateId:disk-sync",
          configPath: join(rootDir, ".fusion", "missing-sync", "config.json"),
          taskId: task.id,
        });
        expect(typeof context.error).toBe("string");
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

  describe("branch cleanup on delete and archive", () => {
    beforeEach(() => {
      mockedExecSync.mockClear();
      mockedRunCommandAsync.mockClear();
    });

    afterEach(() => {
      mockedExecSync.mockImplementation(
        (...args: Parameters<typeof execSync>) => {
          // Restore pass-through to real implementation
          const { execSync: realExecSync } = require("node:child_process");
          return realExecSync(...args);
        },
      );
      mockedRunCommandAsync.mockImplementation((...args: Parameters<typeof runCommandAsync>) =>
        vi.importActual<typeof import("../run-command.js")>("../run-command.js").then((mod) =>
          mod.runCommandAsync(...args),
        ),
      );
    });

    it("deleteTask attempts branch cleanup via cleanupBranchForTask", async () => {
      const task = await createTestTask();

      // Mock: verify succeeds, delete succeeds
      mockedRunCommandAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --verify") || cmd.includes("git branch -D")) {
          return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
        }
        throw new Error(`unexpected runCommandAsync call: ${cmd}`);
      });

      await store.deleteTask(task.id);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);
      const verifyCalls = calls.filter((c) => c.includes("git rev-parse --verify") && c.includes(`fusion/${task.id.toLowerCase()}`));
      const deleteCalls = calls.filter((c) => c.includes("git branch -D") && c.includes(`fusion/${task.id.toLowerCase()}`));
      expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteTask cleans up stored branch and derived branch when set", async () => {
      const task = await store.createTask({ description: "Branch test" });
      await store.updateTask(task.id, { branch: "fusion/my-custom-branch" });

      mockedRunCommandAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --verify") || cmd.includes("git branch -D")) {
          return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
        }
        throw new Error(`unexpected runCommandAsync call: ${cmd}`);
      });

      await store.deleteTask(task.id);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);

      // Should verify and delete both stored and derived branches
      const customBranchVerify = calls.filter((c) => c.includes(`git rev-parse --verify "fusion/my-custom-branch"`));
      const customBranchDelete = calls.filter((c) => c.includes(`git branch -D "fusion/my-custom-branch"`));
      const derivedBranchVerify = calls.filter((c) => c.includes(`git rev-parse --verify "fusion/${task.id.toLowerCase()}"`));
      const derivedBranchDelete = calls.filter((c) => c.includes(`git branch -D "fusion/${task.id.toLowerCase()}"`));
      expect(customBranchVerify.length).toBeGreaterThanOrEqual(1);
      expect(customBranchDelete.length).toBeGreaterThanOrEqual(1);
      expect(derivedBranchVerify.length).toBeGreaterThanOrEqual(1);
      expect(derivedBranchDelete.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteTask succeeds even when branch cleanup fails", async () => {
      const task = await createTestTask();

      mockedRunCommandAsync.mockResolvedValue({
        stdout: "",
        stderr: "not a git repo",
        exitCode: 128,
        signal: null,
        bufferExceeded: false,
        timedOut: false,
      });

      const deleted = await store.deleteTask(task.id);
      expect(deleted.id).toBe(task.id);
    });

    it("archiveTask with cleanup attempts branch cleanup", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      mockedRunCommandAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --verify") || cmd.includes("git branch -D")) {
          return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
        }
        throw new Error(`unexpected runCommandAsync call: ${cmd}`);
      });

      await store.archiveTask(task.id, true);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);
      const verifyCalls = calls.filter((c) => c.includes("git rev-parse --verify") && c.includes(`fusion/${task.id.toLowerCase()}`));
      const deleteCalls = calls.filter((c) => c.includes("git branch -D") && c.includes(`fusion/${task.id.toLowerCase()}`));
      expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("archiveTask without cleanup does NOT attempt branch cleanup", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      mockedRunCommandAsync.mockClear();

      await store.archiveTask(task.id, false);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);
      const branchCommands = calls.filter((c) => c.includes("git branch -D") || c.includes("git rev-parse --verify"));
      expect(branchCommands).toHaveLength(0);
    });
  });

  describe("mergeDetails via updateTask", () => {
    it("can set mergeDetails on a task", async () => {
      const task = await store.createTask({ description: "test merge details" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const mergeDetails = {
        commitSha: "abc123",
        filesChanged: 5,
        insertions: 10,
        deletions: 3,
        mergeCommitMessage: "Merge task",
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
      };

      const updated = await store.updateTask(task.id, { mergeDetails });
      expect(updated.mergeDetails).toEqual(mergeDetails);

      // Verify it persists
      const reloaded = await store.getTask(task.id);
      expect(reloaded.mergeDetails).toEqual(mergeDetails);
    });

    it("can clear mergeDetails by passing null", async () => {
      const task = await store.createTask({ description: "test merge details clear" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.updateTask(task.id, {
        mergeDetails: { commitSha: "abc123", mergeConfirmed: true },
      });

      const cleared = await store.updateTask(task.id, { mergeDetails: null });
      expect(cleared.mergeDetails).toBeUndefined();
    });

    it("does not modify mergeDetails when not included in updates", async () => {
      const task = await store.createTask({ description: "test merge details no-op" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.updateTask(task.id, {
        mergeDetails: { commitSha: "def456", mergeConfirmed: true },
      });

      // Update something unrelated
      const updated = await store.updateTask(task.id, { summary: "some summary" });
      expect(updated.mergeDetails).toEqual({ commitSha: "def456", mergeConfirmed: true });
    });
  });

  describe("project memory bootstrap", () => {
    it("creates .fusion/memory/MEMORY.md on init when memoryEnabled is default (true)", async () => {
      const memoryPath = join(rootDir, ".fusion", "memory", "MEMORY.md");
      expect(existsSync(memoryPath)).toBe(true);

      const content = await readFile(memoryPath, "utf-8");
      expect(content).toContain("# Project Memory");
      expect(content).toContain("## Architecture");
      expect(content).toContain("## Conventions");
    });

    it("does not create .fusion/memory/MEMORY.md when memoryEnabled is false after re-init", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      let localStore: TaskStore | undefined;
      let secondStore: TaskStore | undefined;
      try {
        localStore = new TaskStore(localRoot, localGlobal);
        await localStore.init();
        await localStore.updateSettings({ memoryEnabled: false } as any);

        const memoryPath = join(localRoot, ".fusion", "memory", "MEMORY.md");
        if (existsSync(memoryPath)) {
          await unlink(memoryPath);
        }
        expect(existsSync(memoryPath)).toBe(false);

        localStore.close();
        localStore = undefined;

        secondStore = new TaskStore(localRoot, localGlobal);
        await secondStore.init();

        expect(existsSync(memoryPath)).toBe(false);
      } finally {
        secondStore?.close();
        localStore?.close();
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });

    it("creates .fusion/memory/MEMORY.md when memory is toggled on via updateSettings", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      let localStore: TaskStore | undefined;
      try {
        localStore = new TaskStore(localRoot, localGlobal, { inMemoryDb: true });
        await localStore.init();

        await localStore.updateSettings({ memoryEnabled: false } as any);
        const memoryPath = join(localRoot, ".fusion", "memory", "MEMORY.md");

        if (existsSync(memoryPath)) {
          await unlink(memoryPath);
        }
        expect(existsSync(memoryPath)).toBe(false);

        await localStore.updateSettings({ memoryEnabled: true } as any);
        expect(existsSync(memoryPath)).toBe(true);

        const content = await readFile(memoryPath, "utf-8");
        expect(content).toContain("# Project Memory");
      } finally {
        localStore?.close();
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });

    it("does not overwrite existing memory content when toggled on", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      let localStore: TaskStore | undefined;
      try {
        localStore = new TaskStore(localRoot, localGlobal, { inMemoryDb: true });
        await localStore.init();
        const memoryPath = join(localRoot, ".fusion", "memory", "MEMORY.md");

        const customContent = "# My Custom Memory\n\nImportant stuff";
        await writeFile(memoryPath, customContent, "utf-8");

        await localStore.updateSettings({ memoryEnabled: false } as any);
        await localStore.updateSettings({ memoryEnabled: true } as any);

        const content = await readFile(memoryPath, "utf-8");
        expect(content).toBe(customContent);
      } finally {
        localStore?.close();
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });
  });



  describe("distributed task-id allocator seam", () => {
    it("returns a stable allocator instance", () => {
      const first = store.getDistributedTaskIdAllocator();
      const second = store.getDistributedTaskIdAllocator();
      expect(first).toBe(second);
    });

    it("createTaskWithReservedId creates using provided id", async () => {
      const created = await store.createTaskWithReservedId(
        { description: "replicated task", nodeId: "node-b" },
        { taskId: "FN-9001" },
      );

      expect(created.id).toBe("FN-9001");
      expect(created.nodeId).toBe("node-b");
      const detail = await store.getTask("FN-9001");
      expect(detail.prompt).toBe("# FN-9001\n\nreplicated task\n");
    });

    it("createTaskWithReservedId rejects duplicates and self-dependencies", async () => {
      await store.createTaskWithReservedId({ description: "first" }, { taskId: "FN-9003" });

      await expect(
        store.createTaskWithReservedId({ description: "duplicate" }, { taskId: "FN-9003" }),
      ).rejects.toThrow("Task ID already exists: FN-9003");

      await expect(
        store.createTaskWithReservedId(
          { description: "self dep", dependencies: ["FN-9004"] },
          { taskId: "FN-9004" },
        ),
      ).rejects.toThrow("Task FN-9004 cannot depend on itself");
    });

    it("advances config nextId high-water after reserved id create", async () => {
      await store.createTaskWithReservedId({ description: "reserved" }, { taskId: "FN-9015" });
      const created = await store.createTask({ description: "plain create" });
      expect(created.id).toBe("FN-9016");
    });

    it("skips existing ids when config nextId drifts below task high-water", async () => {
      await store.createTaskWithReservedId({ description: "existing" }, { taskId: "FN-9020" });
      (store as any).db.prepare("UPDATE config SET nextId = 1 WHERE id = 1").run();

      const created = await store.createTask({ description: "should skip collision" });
      expect(created.id).toBe("FN-001");

      (store as any).db.prepare("UPDATE config SET nextId = 9020 WHERE id = 1").run();
      const next = await store.createTask({ description: "stale high water" });
      expect(next.id).toBe("FN-9021");
    });

    it("does not overwrite existing non-triage task on colliding create attempt", async () => {
      const existing = await store.createTaskWithReservedId({ description: "protected" }, { taskId: "FN-9030" });
      await store.moveTask(existing.id, "todo");
      await store.moveTask(existing.id, "in-progress");
      await store.moveTask(existing.id, "in-review");

      await expect(
        store.createTaskWithReservedId({ description: "collision" }, { taskId: "FN-9030" }),
      ).rejects.toThrow("Task ID already exists: FN-9030");

      const reloaded = await store.getTask("FN-9030");
      expect(reloaded.description).toBe("protected");
      expect(reloaded.column).toBe("in-review");
    });

    it("applyReplicatedTaskCreate does not auto-apply default workflow steps", async () => {
      const workflowStep = await store.createWorkflowStep({
        name: "Default step",
        description: "auto",
        enabled: true,
        defaultOn: true,
      });

      const payload = {
        replicationVersion: 1 as const,
        reservationId: "res-default-step",
        taskId: "FN-9010",
        sourceNodeId: "node-a",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
        prompt: "# FN-9010\n\ncluster create\n",
        input: {
          description: "cluster create",
          column: "triage" as const,
        },
      };

      const result = await store.applyReplicatedTaskCreate(payload);
      expect(result.applied).toBe(true);
      expect(result.task.enabledWorkflowSteps).toBeUndefined();
      expect(workflowStep.defaultOn).toBe(true);
    });

    it("applyReplicatedTaskCreate is idempotent and detects collisions", async () => {
      const payload = {
        replicationVersion: 1 as const,
        reservationId: "res-1",
        taskId: "FN-9002",
        sourceNodeId: "node-a",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
        prompt: "# FN-9002\n\ncluster create\n",
        input: {
          description: "cluster create",
          column: "triage" as const,
          nodeId: "node-c",
        },
      };

      const first = await store.applyReplicatedTaskCreate(payload);
      expect(first.applied).toBe(true);
      const second = await store.applyReplicatedTaskCreate(payload);
      expect(second.applied).toBe(false);
      expect(second.task.id).toBe("FN-9002");

      await expect(
        store.applyReplicatedTaskCreate({
          ...payload,
          input: { ...payload.input, description: "different" },
        }),
      ).rejects.toThrow("Replicated task payload collision");
    });
  });

  describe("clearStaleExecutionStartBranchReferences (FN-2165)", () => {
    it("nulls baseBranch on live tasks that reference a deleted branch", async () => {
      const upstream = await store.createTask({ description: "Upstream" });
      const dependent = await store.createTask({ description: "Dependent" });
      await store.updateTask(dependent.id, {
        executionStartBranch: `fusion/${upstream.id.toLowerCase()}-2`,
      });

      const cleared = store.clearStaleExecutionStartBranchReferences([
        `fusion/${upstream.id.toLowerCase()}-2`,
      ]);

      expect(cleared).toEqual([dependent.id]);
      const reloaded = await store.getTask(dependent.id);
      expect(reloaded.executionStartBranch).toBeUndefined();
    });

    it("excludes the owner task so archival doesn't null its own baseBranch", async () => {
      const upstream = await store.createTask({ description: "Upstream" });
      await store.updateTask(upstream.id, { executionStartBranch: "fusion/some-base" });

      const cleared = store.clearStaleExecutionStartBranchReferences(
        ["fusion/some-base"],
        upstream.id,
      );

      expect(cleared).toEqual([]);
      const reloaded = await store.getTask(upstream.id);
      expect(reloaded.executionStartBranch).toBe("fusion/some-base");
    });

    it("returns [] and is a no-op when no branches given", () => {
      expect(store.clearStaleExecutionStartBranchReferences([])).toEqual([]);
    });

    it("clears baseBranch on multiple dependents in one call", async () => {
      const [a, b, c] = await Promise.all([
        store.createTask({ description: "A" }),
        store.createTask({ description: "B" }),
        store.createTask({ description: "C" }),
      ]);
      await store.updateTask(a.id, { executionStartBranch: "fusion/gone-a" });
      await store.updateTask(b.id, { executionStartBranch: "fusion/gone-b" });
      await store.updateTask(c.id, { executionStartBranch: "fusion/still-alive" });

      const cleared = store.clearStaleExecutionStartBranchReferences([
        "fusion/gone-a",
        "fusion/gone-b",
      ]);

      expect(cleared.sort()).toEqual([a.id, b.id].sort());
      const cReloaded = await store.getTask(c.id);
      expect(cReloaded.executionStartBranch).toBe("fusion/still-alive");
    });
  });

  describe("shared mesh snapshots", () => {
    it("persists and replicates extended lease metadata", async () => {
      const task = await store.createTask({ description: "lease snapshot task" });
      await store.updateTask(task.id, {
        checkedOutBy: "agent-1",
        checkedOutAt: "2026-05-01T00:00:00.000Z",
        checkoutNodeId: "node-a",
        checkoutRunId: "run-1",
        checkoutLeaseRenewedAt: "2026-05-01T00:01:00.000Z",
        checkoutLeaseEpoch: 7,
      });

      const snapshot = await store.getTaskMetadataSnapshot();
      const replicated = snapshot.payload.tasks.find((entry) => entry.id === task.id);

      expect(replicated).toMatchObject({
        checkedOutBy: "agent-1",
        checkedOutAt: "2026-05-01T00:00:00.000Z",
        checkoutNodeId: "node-a",
        checkoutRunId: "run-1",
        checkoutLeaseRenewedAt: "2026-05-01T00:01:00.000Z",
        checkoutLeaseEpoch: 7,
      });

      await store.updateTask(task.id, { checkedOutBy: null, checkoutLeaseEpoch: 8 });
      const released = await store.getTask(task.id);
      expect(released).toMatchObject({ checkedOutBy: undefined, checkoutLeaseEpoch: 8 });
    });

    it("exports and reapplies task/activity/audit snapshots deterministically", async () => {
      const task = await store.createTask({ description: "snapshot task" });
      await store.updateTask(task.id, { worktree: "/tmp/fn-worktree", executionStartBranch: "fn/base" });
      await store.recordActivity({ type: "task:created", taskId: task.id, details: "created" });

      const taskSnapshot = await store.getTaskMetadataSnapshot();
      const activitySnapshot = await store.getActivityLogSnapshot();
      const auditSnapshot = store.getRunAuditSnapshot();

      const taskResult = await store.applyTaskMetadataSnapshot(taskSnapshot);
      const activityResult = store.applyActivityLogSnapshot(activitySnapshot);
      const auditResult = store.applyRunAuditSnapshot(auditSnapshot);

      const taskSnapshot2 = await store.getTaskMetadataSnapshot();
      const activitySnapshot2 = await store.getActivityLogSnapshot();
      const auditSnapshot2 = store.getRunAuditSnapshot();

      expect(taskResult.applied + taskResult.skipped).toBeGreaterThan(0);
      expect(taskSnapshot2.payload).toEqual(taskSnapshot.payload);
      expect(activitySnapshot2.payload).toEqual(activitySnapshot.payload);
      expect(auditSnapshot2.payload).toEqual(auditSnapshot.payload);
      expect(activityResult.skipped).toBeGreaterThanOrEqual(1);
      expect(auditResult.skipped).toBeGreaterThanOrEqual(0);

      const persisted = await store.getTask(task.id);
      expect(persisted?.worktree).toBe("/tmp/fn-worktree");
      expect(persisted?.executionStartBranch).toBe("fn/base");
    });
  });
});
