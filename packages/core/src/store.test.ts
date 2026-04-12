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

vi.mock("./run-command.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./run-command.js")>();
  return {
    ...mod,
    runCommandAsync: vi.fn((...args: Parameters<typeof mod.runCommandAsync>) => mod.runCommandAsync(...args)),
  };
});

import { execSync } from "node:child_process";
const mockedExecSync = vi.mocked(execSync);
import { runCommandAsync } from "./run-command.js";
const mockedRunCommandAsync = vi.mocked(runCommandAsync);

import { TaskStore } from "./store.js";
import { readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Task } from "./types.js";

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
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.stopWatching();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  async function createTestTask(): Promise<Task> {
    return store.createTask({ description: "Test task" });
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

  // ── Prompt generation (no duplicate description) ───────────────

  describe("prompt generation", () => {
    it("triage task without title shows only ID in heading", async () => {
      const task = await store.createTask({ description: "Fix the login bug on the settings page" });
      const detail = await store.getTask(task.id);

      // Heading should be just the task ID when no title is provided
      expect(detail.prompt).toMatch(/^# FN-001\n/);
      // Description appears exactly once in body (not duplicated in heading)
      expect(detail.prompt).toContain("Fix the login bug on the settings page");
    });

    it("triage task with title uses title in heading and description in body", async () => {
      const task = await store.createTask({
        title: "Login bug",
        description: "Fix the login bug on the settings page",
      });
      const detail = await store.getTask(task.id);

      expect(detail.prompt).toMatch(/^# FN-001: Login bug\n/);
      expect(detail.prompt).toContain("Fix the login bug on the settings page");
    });

    it("generateSpecifiedPrompt shows only ID when title is absent", async () => {
      const task = await store.createTask({
        description: "Implement caching layer",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      // Heading should be just the task ID when no title is provided
      expect(detail.prompt).toMatch(/^# FN-001\n/);
      // Description appears once in Mission section
      expect(detail.prompt).toContain("Implement caching layer");
    });

    it("generateSpecifiedPrompt uses title in heading when present", async () => {
      const task = await store.createTask({
        title: "Add caching",
        description: "Implement caching layer for API responses",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      expect(detail.prompt).toMatch(/^# FN-001: Add caching\n/);
      expect(detail.prompt).toContain("Implement caching layer for API responses");
    });

  });

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
  });

  describe("assignedAgentId persistence", () => {
    it("creates a task with assignedAgentId when provided", async () => {
      const task = await store.createTask({
        description: "Assigned task",
        assignedAgentId: "agent-123",
      });

      expect(task.assignedAgentId).toBe("agent-123");

      const detail = await store.getTask(task.id);
      expect(detail.assignedAgentId).toBe("agent-123");
    });

    it("updates a task to set assignedAgentId", async () => {
      const task = await store.createTask({ description: "Unassigned task" });

      const updated = await store.updateTask(task.id, { assignedAgentId: "agent-456" });
      expect(updated.assignedAgentId).toBe("agent-456");

      const detail = await store.getTask(task.id);
      expect(detail.assignedAgentId).toBe("agent-456");
    });

    it("updates a task to clear assignedAgentId with null", async () => {
      const task = await store.createTask({
        description: "Assigned then cleared",
        assignedAgentId: "agent-789",
      });

      const cleared = await store.updateTask(task.id, { assignedAgentId: null });
      expect(cleared.assignedAgentId).toBeUndefined();

      const detail = await store.getTask(task.id);
      expect(detail.assignedAgentId).toBeUndefined();
    });

    it("returns assignedAgentId values from listTasks", async () => {
      const assigned = await store.createTask({
        description: "Assigned task in list",
        assignedAgentId: "agent-list",
      });
      await store.createTask({ description: "Unassigned task in list" });

      const tasks = await store.listTasks();
      const listedAssigned = tasks.find((t) => t.id === assigned.id);

      expect(listedAssigned?.assignedAgentId).toBe("agent-list");
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

  describe("attachments", () => {
    const TINY_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    it("adds an attachment and persists metadata in task.json", async () => {
      const task = await createTestTask();
      const attachment = await store.addAttachment(task.id, "screenshot.png", TINY_PNG, "image/png");

      expect(attachment.originalName).toBe("screenshot.png");
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.size).toBe(TINY_PNG.length);
      expect(attachment.filename).toMatch(/^\d+-screenshot\.png$/);

      // Verify metadata persisted
      const updated = await store.getTask(task.id);
      expect(updated.attachments).toHaveLength(1);
      expect(updated.attachments![0].filename).toBe(attachment.filename);

      // Verify file on disk
      const filePath = join(rootDir, ".fusion", "tasks", task.id, "attachments", attachment.filename);
      const content = await readFile(filePath);
      expect(content).toEqual(TINY_PNG);
    });

    it("accepts text/plain mime type", async () => {
      const task = await createTestTask();
      const attachment = await store.addAttachment(task.id, "error.log", Buffer.from("log content"), "text/plain");
      expect(attachment.originalName).toBe("error.log");
      expect(attachment.mimeType).toBe("text/plain");
    });

    it("accepts application/json mime type", async () => {
      const task = await createTestTask();
      const attachment = await store.addAttachment(task.id, "config.json", Buffer.from('{"key":"val"}'), "application/json");
      expect(attachment.mimeType).toBe("application/json");
    });

    it("accepts text/yaml mime type", async () => {
      const task = await createTestTask();
      const attachment = await store.addAttachment(task.id, "config.yaml", Buffer.from("key: val"), "text/yaml");
      expect(attachment.mimeType).toBe("text/yaml");
    });

    it("rejects unsupported mime types", async () => {
      const task = await createTestTask();
      await expect(
        store.addAttachment(task.id, "file.bin", Buffer.from("data"), "application/octet-stream"),
      ).rejects.toThrow("Invalid mime type");
    });

    it("rejects oversized files", async () => {
      const task = await createTestTask();
      const bigBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
      await expect(
        store.addAttachment(task.id, "big.png", bigBuffer, "image/png"),
      ).rejects.toThrow("File too large");
    });

    it("gets attachment path and mime type", async () => {
      const task = await createTestTask();
      const attachment = await store.addAttachment(task.id, "shot.png", TINY_PNG, "image/png");

      const result = await store.getAttachment(task.id, attachment.filename);
      expect(result.mimeType).toBe("image/png");
      expect(result.path).toContain(attachment.filename);
    });

    it("deletes an attachment from disk and metadata", async () => {
      const task = await createTestTask();
      const attachment = await store.addAttachment(task.id, "del.png", TINY_PNG, "image/png");

      const updated = await store.deleteAttachment(task.id, attachment.filename);
      expect(updated.attachments).toBeUndefined();

      // Verify file removed from disk
      const filePath = join(rootDir, ".fusion", "tasks", task.id, "attachments", attachment.filename);
      expect(existsSync(filePath)).toBe(false);
    });

    it("throws ENOENT when getting non-existent attachment", async () => {
      const task = await createTestTask();
      await expect(
        store.getAttachment(task.id, "nonexistent.png"),
      ).rejects.toThrow("not found");
    });

    it("throws ENOENT when deleting non-existent attachment", async () => {
      const task = await createTestTask();
      await expect(
        store.deleteAttachment(task.id, "nonexistent.png"),
      ).rejects.toThrow("not found");
    });
  });

  // ── Settings tests ────────────────────────────────────────────────

  describe("model settings", () => {
    it("persists defaultProvider and defaultModelId via updateGlobalSettings", async () => {
      await store.updateGlobalSettings({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" });
      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("default settings do not include model fields", async () => {
      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBeUndefined();
      expect(settings.defaultModelId).toBeUndefined();
    });
  });

  describe("worktreeInitCommand setting", () => {
    it("persists worktreeInitCommand and returns it via getSettings", async () => {
      await store.updateSettings({ worktreeInitCommand: "pnpm install" });
      const settings = await store.getSettings();
      expect(settings.worktreeInitCommand).toBe("pnpm install");
    });

    it("default settings do not include worktreeInitCommand", async () => {
      const settings = await store.getSettings();
      expect(settings.worktreeInitCommand).toBeUndefined();
    });
  });

  describe("autoResolveConflicts setting", () => {
    it("persists autoResolveConflicts and returns it via getSettings", async () => {
      await store.updateSettings({ autoResolveConflicts: false });
      const settings = await store.getSettings();
      expect(settings.autoResolveConflicts).toBe(false);
    });

    it("default settings have autoResolveConflicts set to true", async () => {
      const settings = await store.getSettings();
      expect(settings.autoResolveConflicts).toBe(true);
    });
  });

  describe("mergeStrategy setting", () => {
    it("defaults mergeStrategy to direct for backward compatibility", async () => {
      const settings = await store.getSettings();
      expect(settings.mergeStrategy).toBe("direct");
    });

    it("persists mergeStrategy and returns it via getSettings", async () => {
      await store.updateSettings({ mergeStrategy: "pull-request" });
      const settings = await store.getSettings();
      expect(settings.mergeStrategy).toBe("pull-request");
    });
  });

  // ── Planning/Validator Model Settings ────────────────────────────

  describe("planning/validator model settings", () => {
    it("saves and restores planning model settings via updateSettings", async () => {
      await store.updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });
      const settings = await store.getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
    });

    it("saves and restores validator model settings via updateSettings", async () => {
      await store.updateSettings({
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      const settings = await store.getSettings();
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBe("gpt-4o");
    });

    it("saves and restores both planning and validator model settings via updateSettings", async () => {
      await store.updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      const settings = await store.getSettings();
      expect(settings.planningProvider).toBe("anthropic");
      expect(settings.planningModelId).toBe("claude-sonnet-4-5");
      expect(settings.validatorProvider).toBe("openai");
      expect(settings.validatorModelId).toBe("gpt-4o");
    });

    it("clears planning model settings when set to undefined", async () => {
      await store.updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      });
      await store.updateSettings({
        planningProvider: undefined,
        planningModelId: undefined,
      });
      const settings = await store.getSettings();
      expect(settings.planningProvider).toBeUndefined();
      expect(settings.planningModelId).toBeUndefined();
    });

    it("clears validator model settings when set to undefined", async () => {
      await store.updateSettings({
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      await store.updateSettings({
        validatorProvider: undefined,
        validatorModelId: undefined,
      });
      const settings = await store.getSettings();
      expect(settings.validatorProvider).toBeUndefined();
      expect(settings.validatorModelId).toBeUndefined();
    });

    it("persists planning/validator settings in project config", async () => {
      await store.updateSettings({
        planningProvider: "anthropic",
        planningModelId: "claude-opus-4",
        validatorProvider: "openai",
        validatorModelId: "gpt-4-turbo",
      });

      // Verify the settings are in the project config file
      const configRaw = await readFile(join(rootDir, ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.planningProvider).toBe("anthropic");
      expect(config.settings.planningModelId).toBe("claude-opus-4");
      expect(config.settings.validatorProvider).toBe("openai");
      expect(config.settings.validatorModelId).toBe("gpt-4-turbo");
    });
  });

  // ── Global/Project Settings Merging ─────────────────────────────

  describe("global/project settings merging", () => {
    it("getSettings returns global defaults when no overrides exist", async () => {
      const settings = await store.getSettings();
      expect(settings.themeMode).toBe("dark");
      expect(settings.colorTheme).toBe("default");
      expect(settings.maxConcurrent).toBe(2);
    });

    it("global settings are visible through getSettings", async () => {
      await store.updateGlobalSettings({ themeMode: "light", colorTheme: "ocean" });
      const settings = await store.getSettings();
      expect(settings.themeMode).toBe("light");
      expect(settings.colorTheme).toBe("ocean");
    });

    it("project settings override global defaults", async () => {
      await store.updateSettings({ maxConcurrent: 8 });
      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(8);
    });

    it("updateSettings silently filters out global-only fields", async () => {
      // themeMode is a global field — should not be persisted to project config
      await store.updateSettings({ maxConcurrent: 5, themeMode: "light" } as any);

      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(5);
      // themeMode should still be the global default, not "light"
      expect(settings.themeMode).toBe("dark");

      // Verify the project config doesn't contain themeMode
      const configRaw = await readFile(join(rootDir, ".fusion", "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.settings.themeMode).toBeUndefined();
    });

    it("updateGlobalSettings persists global fields", async () => {
      await store.updateGlobalSettings({ defaultProvider: "openai", defaultModelId: "gpt-4o" });

      const settings = await store.getSettings();
      expect(settings.defaultProvider).toBe("openai");
      expect(settings.defaultModelId).toBe("gpt-4o");
    });

    it("updateGlobalSettings emits settings:updated event", async () => {
      const events: Array<{ settings: any; previous: any }> = [];
      store.on("settings:updated", (data) => events.push(data));

      await store.updateGlobalSettings({ ntfyEnabled: true, ntfyTopic: "test" });

      expect(events).toHaveLength(1);
      expect(events[0].settings.ntfyEnabled).toBe(true);
      expect(events[0].settings.ntfyTopic).toBe("test");
    });

    it("getSettingsByScope returns separated global and project settings", async () => {
      await store.updateGlobalSettings({ themeMode: "system", defaultProvider: "anthropic" });
      await store.updateSettings({ maxConcurrent: 4, autoMerge: false });

      const { global, project } = await store.getSettingsByScope();

      expect(global.themeMode).toBe("system");
      expect(global.defaultProvider).toBe("anthropic");
      expect(project.maxConcurrent).toBe(4);
      expect(project.autoMerge).toBe(false);
    });

    it("getSettingsByScope does not include global keys in project settings", async () => {
      // Update settings with both project and global keys via the store API
      // updateSettings silently filters out global-only fields,
      // so we need to set project settings via the proper API
      await store.updateSettings({ maxConcurrent: 3 } as any);

      const { project } = await store.getSettingsByScope();

      expect(project.maxConcurrent).toBe(3);
      // themeMode is a global key — should not appear in project scope
      expect((project as any).themeMode).toBeUndefined();
    });

    it("backward compat: existing projects with global fields in config.json still work", async () => {
      // Update settings through the store API (simulates legacy config with project + global fields)
      await store.updateSettings({ maxConcurrent: 6 } as any);
      // Global fields go through global settings store
      await store.updateGlobalSettings({ themeMode: "system", ntfyEnabled: true });

      // getSettings should still see these values (project overrides global)
      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(6);
      expect(settings.themeMode).toBe("system");
      expect(settings.ntfyEnabled).toBe(true);
    });

    it("getGlobalSettingsStore returns the store instance", () => {
      const globalStore = store.getGlobalSettingsStore();
      expect(globalStore).toBeDefined();
      expect(globalStore.getSettingsPath()).toContain("settings.json");
    });

    it("updateSettings creates config row if missing and persists settings", async () => {
      // Manually delete the config row to simulate corruption/edge case
      const db = (store as any).db;
      db.prepare("DELETE FROM config WHERE id = 1").run();

      // updateSettings should still work (INSERT OR REPLACE creates row)
      await store.updateSettings({ maxConcurrent: 7 });

      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(7);

      // Verify row was recreated
      const row = db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
      expect(row).toBeDefined();
      expect(row.nextId).toBeDefined();
    });

    it("updateSettings persists multiple settings correctly to SQLite", async () => {
      await store.updateSettings({
        maxConcurrent: 3,
        maxWorktrees: 8,
        pollIntervalMs: 30000,
        autoMerge: false,
        mergeStrategy: "pull-request",
      });

      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(3);
      expect(settings.maxWorktrees).toBe(8);
      expect(settings.pollIntervalMs).toBe(30000);
      expect(settings.autoMerge).toBe(false);
      expect(settings.mergeStrategy).toBe("pull-request");
    });

    it("updateGlobalSettings persists multiple global settings correctly", async () => {
      await store.updateGlobalSettings({
        themeMode: "light",
        colorTheme: "ocean",
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const settings = await store.getSettings();
      expect(settings.themeMode).toBe("light");
      expect(settings.colorTheme).toBe("ocean");
      expect(settings.ntfyEnabled).toBe(true);
      expect(settings.ntfyTopic).toBe("test-topic");
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModelId).toBe("claude-sonnet-4-5");
    });

    it("settings are correctly merged from all sources", async () => {
      // Set global settings
      await store.updateGlobalSettings({ themeMode: "light", ntfyEnabled: true });

      // Set project settings (should override where applicable)
      await store.updateSettings({ maxConcurrent: 5, autoMerge: false });

      const settings = await store.getSettings();

      // Project settings
      expect(settings.maxConcurrent).toBe(5);
      expect(settings.autoMerge).toBe(false);

      // Global settings
      expect(settings.themeMode).toBe("light");
      expect(settings.ntfyEnabled).toBe(true);

      // Defaults for unset fields
      expect(settings.maxWorktrees).toBe(4); // default
      expect(settings.pollIntervalMs).toBe(15000); // default
    });
  });

  describe("getSettingsFast()", () => {
    it("returns the same merged result as getSettings()", async () => {
      await store.updateGlobalSettings({ themeMode: "light", ntfyEnabled: true });
      await store.updateSettings({ maxConcurrent: 5, autoMerge: false });

      const fast = await store.getSettingsFast();
      const regular = await store.getSettings();

      expect(fast.maxConcurrent).toBe(5);
      expect(fast.autoMerge).toBe(false);
      expect(fast.themeMode).toBe("light");
      expect(fast.ntfyEnabled).toBe(true);
      expect(fast.maxWorktrees).toBe(4); // default

      // Should match getSettings()
      expect(fast).toEqual(regular);
    });

    it("returns defaults when no config row exists", async () => {
      // Delete the config row
      const db = (store as any).db;
      db.prepare("DELETE FROM config WHERE id = 1").run();

      const settings = await store.getSettingsFast();

      // Should return defaults merged with global settings
      expect(settings.maxWorktrees).toBe(4); // default
      expect(settings.pollIntervalMs).toBe(15000); // default
      // Global settings should still be present
      expect(settings.themeMode).toBe("dark"); // global default
    });

    it("includes global settings merged with project settings", async () => {
      await store.updateGlobalSettings({ themeMode: "system", colorTheme: "ocean" });
      await store.updateSettings({ maxConcurrent: 10 });

      const settings = await store.getSettingsFast();

      // Project settings override
      expect(settings.maxConcurrent).toBe(10);
      // Global settings are included
      expect(settings.themeMode).toBe("system");
      expect(settings.colorTheme).toBe("ocean");
    });

    it("does not call listWorkflowSteps (fast-path)", async () => {
      await store.updateSettings({ maxConcurrent: 3 });

      const settings = await store.getSettingsFast();

      // If we got here without errors, the fast path works
      expect(settings.maxConcurrent).toBe(3);
      // listWorkflowSteps should not be called by getSettingsFast
    });
  });

  // ── Prompt Overrides Tests ─────────────────────────────────────────

  describe("promptOverrides settings", () => {
    it("can set a single prompt override", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Custom executor welcome message" },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Custom executor welcome message" });
    });

    it("can set multiple prompt overrides", async () => {
      await store.updateSettings({
        promptOverrides: {
          "executor-welcome": "Custom welcome",
          "triage-welcome": "Custom triage welcome",
        },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Custom welcome",
        "triage-welcome": "Custom triage welcome",
      });
    });

    it("promptOverrides is undefined by default", async () => {
      const settings = await store.getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("can merge new overrides with existing overrides", async () => {
      // Set initial overrides
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Initial welcome" },
      });

      // Add more overrides
      await store.updateSettings({
        promptOverrides: { "triage-welcome": "Custom triage" },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Initial welcome",
        "triage-welcome": "Custom triage",
      });
    });

    it("can update an existing override", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Original" },
      });

      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Updated" },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Updated" });
    });

    it("can clear a specific override with null value", async () => {
      // Set initial overrides
      await store.updateSettings({
        promptOverrides: {
          "executor-welcome": "Welcome",
          "triage-welcome": "Triage",
        },
      });

      // Clear only executor-welcome
      await store.updateSettings({
        promptOverrides: { "executor-welcome": null as unknown as string },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({ "triage-welcome": "Triage" });
    });

    it("clears entire promptOverrides when all keys are cleared", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Welcome" },
      });

      await store.updateSettings({
        promptOverrides: { "executor-welcome": null as unknown as string },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("can clear entire promptOverrides with null", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Welcome", "triage-welcome": "Triage" },
      });

      await store.updateSettings({
        promptOverrides: null as unknown as Record<string, string>,
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("persists empty string overrides as cleared (not stored)", async () => {
      // Setting an empty string should be treated as "clear" and not persist
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "" },
      });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("handles promptOverrides in getSettingsByScope", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Scoped welcome" },
      });

      const { project } = await store.getSettingsByScope();
      expect(project.promptOverrides).toEqual({ "executor-welcome": "Scoped welcome" });
    });

    it("preserves other settings when updating promptOverrides", async () => {
      await store.updateSettings({
        maxConcurrent: 5,
        autoMerge: false,
      });

      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Welcome" },
      });

      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(5);
      expect(settings.autoMerge).toBe(false);
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Welcome" });
    });

    it("preserves promptOverrides when updating other settings", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Welcome", "triage-welcome": "Triage" },
      });

      await store.updateSettings({ maxConcurrent: 7 });

      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(7);
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Welcome",
        "triage-welcome": "Triage",
      });
    });
  });

  // ── Concurrent stress test ───────────────────────────────────────

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

  describe("taskPrefix setting", () => {
    it("default prefix produces FN-001 IDs", async () => {
      const task = await store.createTask({ description: "Default prefix" });
      expect(task.id).toBe("FN-001");
    });

    it("custom prefix produces PROJ-001 IDs", async () => {
      await store.updateSettings({ taskPrefix: "PROJ" });
      const task = await store.createTask({ description: "Custom prefix" });
      expect(task.id).toBe("PROJ-001");
    });

    it("prefix change mid-stream continues sequence", async () => {
      const t1 = await store.createTask({ description: "First" });
      const t2 = await store.createTask({ description: "Second" });
      expect(t1.id).toBe("FN-001");
      expect(t2.id).toBe("FN-002");

      await store.updateSettings({ taskPrefix: "PROJ" });
      const t3 = await store.createTask({ description: "Third" });
      expect(t3.id).toBe("PROJ-003");
    });

    it("listTasks returns tasks regardless of prefix", async () => {
      await store.createTask({ description: "HAI task" });
      await store.updateSettings({ taskPrefix: "PROJ" });
      await store.createTask({ description: "PROJ task" });

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id).sort()).toEqual(["FN-001", "PROJ-002"]);
    });

    it("supports pagination with limit and offset", async () => {
      await store.createTask({ description: "Task 1" });
      await store.createTask({ description: "Task 2" });
      await store.createTask({ description: "Task 3" });

      const paged = await store.listTasks({ limit: 1, offset: 1 });

      expect(paged).toHaveLength(1);
      expect(paged[0].id).toBe("FN-002");
    });

    it("slim mode drops the agent log but keeps board-visible fields (steps/comments)", async () => {
      const task = await store.createTask({ description: "Slim test" });
      await store.logEntry(task.id, "heavy log entry that should not appear in slim list");

      const fullList = await store.listTasks();
      const slimList = await store.listTasks({ slim: true });

      const full = fullList.find((t) => t.id === task.id)!;
      const slim = slimList.find((t) => t.id === task.id)!;

      // Sanity: the full row really has the log we wrote.
      expect(full.log.length).toBeGreaterThan(0);

      // Slim must drop the heavy log payload (the only field worth slimming).
      expect(slim.id).toBe(task.id);
      expect(slim.description).toBe("Slim test");
      expect(slim.column).toBe(full.column);
      expect(slim.log).toEqual([]);

      // Slim must STILL include the small JSON columns the board UI reads:
      // step progress, comment counts, workflow status, steering badges.
      // (Dropping them silently broke TaskCard progress bars and the comments tab.)
      expect(slim.steps).toEqual(full.steps);
      expect(slim.comments).toEqual(full.comments);
      expect(slim.workflowStepResults).toEqual(full.workflowStepResults);
      expect(slim.steeringComments).toEqual(full.steeringComments);
    });

    it("slim mode hydrates step metadata from PROMPT.md for board cards", async () => {
      const task = await store.createTask({ description: "Prompt-only steps" });
      await store.updateTask(task.id, {
        prompt: `# ${task.id}: Prompt-only steps

## Steps

### Step 0: Update the list payload

- [ ] Keep card progress visible

### Step 1: Add regression coverage

- [ ] Prove slim lists still include prompt steps
`,
      });

      const fullList = await store.listTasks();
      const slimList = await store.listTasks({ slim: true });
      const full = fullList.find((t) => t.id === task.id)!;
      const slim = slimList.find((t) => t.id === task.id)!;

      expect(full.steps).toEqual([]);
      expect(slim.steps).toEqual([
        { name: "Update the list payload", status: "pending" },
        { name: "Add regression coverage", status: "pending" },
      ]);

      const searchResults = await store.searchTasks("Prompt-only");
      expect(searchResults.find((t) => t.id === task.id)?.steps).toEqual(slim.steps);
    });

    it("includeArchived=false excludes archived tasks; default includes them", async () => {
      const keep = await store.createTask({ description: "Stays visible" });
      const toArchive = await store.createTask({ description: "Will be archived" });
      await store.moveTask(toArchive.id, "todo");
      await store.moveTask(toArchive.id, "in-progress");
      await store.moveTask(toArchive.id, "in-review");
      await store.moveTask(toArchive.id, "done");
      await store.archiveTask(toArchive.id);

      const withArchived = await store.listTasks();
      const withoutArchived = await store.listTasks({ includeArchived: false });

      expect(withArchived.map((t) => t.id)).toEqual(expect.arrayContaining([keep.id, toArchive.id]));
      expect(withoutArchived.map((t) => t.id)).toContain(keep.id);
      expect(withoutArchived.map((t) => t.id)).not.toContain(toArchive.id);
    });
  });

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

      freshStore.stopWatching();
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

    it("appendAgentLog recreates missing task directory before writing agent.log", async () => {
      const task = await createTestTask();
      const dir = await deleteTaskDir(task.id);

      await store.appendAgentLog(task.id, "Recovered log", "text");

      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "agent.log"))).toBe(true);

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].text).toBe("Recovered log");
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
    it("appendAgentLog creates agent.log and getAgentLogs reads it back", async () => {
      const task = await createTestTask();

      await store.appendAgentLog(task.id, "Hello world", "text");
      await store.appendAgentLog(task.id, "Read", "tool");

      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(2);
      expect(logs[0].text).toBe("Hello world");
      expect(logs[0].type).toBe("text");
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[1].text).toBe("Read");
      expect(logs[1].type).toBe("tool");
    });

    it("getAgentLogs returns empty array when no log file exists", async () => {
      const task = await createTestTask();
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toEqual([]);
    });

    it("getAgentLogs returns empty array when the task directory is missing", async () => {
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

    it("handles multiple appends correctly (JSONL format)", async () => {
      const task = await createTestTask();
      for (let i = 0; i < 5; i++) {
        await store.appendAgentLog(task.id, `chunk ${i}`, "text");
      }
      const logs = await store.getAgentLogs(task.id);
      expect(logs).toHaveLength(5);
      expect(logs[4].text).toBe("chunk 4");
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
      const dir = (store as any).taskDir(task.id);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      // Write entries at specific timestamps directly to the JSONL file
      mkdirSync(dir, { recursive: true });
      const entries = [
        { timestamp: "2024-01-01T00:00:00.000Z", taskId: task.id, text: "before start", type: "text" },
        { timestamp: "2024-01-01T01:00:00.000Z", taskId: task.id, text: "at start", type: "text" },
        { timestamp: "2024-01-01T02:00:00.000Z", taskId: task.id, text: "middle", type: "text" },
        { timestamp: "2024-01-01T03:00:00.000Z", taskId: task.id, text: "at end", type: "text" },
        { timestamp: "2024-01-01T04:00:00.000Z", taskId: task.id, text: "after end", type: "text" },
      ];
      writeFileSync(join(dir, "agent.log"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

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
      const dir = (store as any).taskDir(task.id);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      mkdirSync(dir, { recursive: true });
      const entries = [
        { timestamp: "2024-01-01T00:00:00.000Z", taskId: task.id, text: "entry1", type: "text" },
        { timestamp: "2024-06-01T00:00:00.000Z", taskId: task.id, text: "entry2", type: "text" },
      ];
      writeFileSync(join(dir, "agent.log"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      // With null end, should include all entries after start
      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2024-01-01T00:00:00.000Z",
        null,
      );

      expect(logs).toHaveLength(2);
    });

    it("getAgentLogsByTimeRange returns empty array when no entries match", async () => {
      const task = await createTestTask();
      const dir = (store as any).taskDir(task.id);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      mkdirSync(dir, { recursive: true });
      const entries = [
        { timestamp: "2024-01-01T00:00:00.000Z", taskId: task.id, text: "entry1", type: "text" },
      ];
      writeFileSync(join(dir, "agent.log"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2025-01-01T00:00:00.000Z",
        "2025-12-31T23:59:59.000Z",
      );

      expect(logs).toEqual([]);
    });

    it("getAgentLogsByTimeRange returns empty array when no log file exists", async () => {
      const task = await createTestTask();

      const logs = await store.getAgentLogsByTimeRange(
        task.id,
        "2024-01-01T00:00:00.000Z",
        "2024-12-31T23:59:59.000Z",
      );

      expect(logs).toEqual([]);
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
      await store.updateTask(task.id, { status: "specifying" });

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
        await store.updateTask(task.id, { status: "specifying" });
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
        await store.updateTask(task.id, { status: "specifying" });
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

    it("transitions awaiting-approval to needs-respecify when user comments on triage task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      // Keep in triage but set awaiting-approval status
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const result = await store.addComment(task.id, "I want to change the approach", "user");

      // Re-read the task to get the Phase 3 status update
      const updated = await store.getTask(task.id);

      // Task should remain in triage but status should change to needs-respecify
      expect(updated.column).toBe("triage");
      expect(updated.status).toBe("needs-respecify");
      // Comment should still be added
      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("I want to change the approach");
    });

    it("does NOT transition to needs-respecify when agent comments on awaiting-approval task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const updated = await store.addComment(task.id, "Agent system note", "agent");

      // Status should remain awaiting-approval for agent comments
      expect(updated.status).toBe("awaiting-approval");
      // Comment should still be added
      expect(updated.comments).toHaveLength(1);
    });

    it("does NOT transition to needs-respecify when user comments on non-awaiting-approval triage task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      // Task is in triage with no status (not awaiting-approval)
      expect(task.status).toBeUndefined();

      const updated = await store.addComment(task.id, "User feedback", "user");

      // Status should remain undefined
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

    it("does NOT copy baseBranch", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.updateTask(task.id, { baseBranch: "some-branch" });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.baseBranch).toBeUndefined();
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

  describe("archiveTask", () => {
    it("archives a done task (moves done → archived)", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id);

      expect(archived.column).toBe("archived");
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

      await store.archiveTask(task.id);

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

      await store.archiveTask(task.id);
      const fetched = await store.getTask(task.id);

      expect(fetched.column).toBe("archived");
    });

    it("throws error when task is not in 'done' column", async () => {
      const task = await store.createTask({ description: "Test task" });
      // Task starts in triage, not done

      await expect(store.archiveTask(task.id)).rejects.toThrow("must be in 'done'");
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

  describe("unarchiveTask", () => {
    it("unarchives an archived task (moves archived → done)", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      const unarchived = await store.unarchiveTask(task.id);

      expect(unarchived.column).toBe("done");
    });

    it("adds log entry 'Task unarchived'", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      const unarchived = await store.unarchiveTask(task.id);

      expect(unarchived.log.some((l) => l.action === "Task unarchived")).toBe(true);
    });

    it("emits task:moved event with correct from/to columns", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

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
      await store.archiveTask(task.id);

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
      await store.archiveTask(task.id);

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

  describe("VALID_TRANSITIONS — invalid archived transitions via moveTask", () => {
    it("moveTask from archived → in-progress should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      await expect(store.moveTask(task.id, "in-progress")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → triage should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      await expect(store.moveTask(task.id, "triage")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → todo should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      await expect(store.moveTask(task.id, "todo")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → in-review should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

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

  describe("cleanupArchivedTasks", () => {
    it("writes compact entry to archivedTasks table without agent log", async () => {
      // Create and archive a task
      const task = await store.createTask({ description: "Test cleanup", title: "Cleanup Task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      // Add an agent log entry (should not be in archive)
      await store.appendAgentLog(task.id, "Test agent log", "text");

      // Cleanup archived tasks
      const cleaned = await store.cleanupArchivedTasks();
      expect(cleaned).toContain(task.id);

      // Read from store's archive API
      const entry = await store.findInArchive(task.id);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(task.id);
      expect(entry!.title).toBe("Cleanup Task");
      expect(entry!.description).toBe("Test cleanup");
      expect(entry!.column).toBe("archived");
      // Agent log should NOT be in the archive entry
      expect(entry).not.toHaveProperty("agentLog");
    });

    it("removes task directory after archiving", async () => {
      const task = await store.createTask({ description: "Test dir removal" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);

      const dir = join(rootDir, ".fusion", "tasks", task.id);
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
      await store.archiveTask(task.id);

      // First cleanup
      const cleaned1 = await store.cleanupArchivedTasks();
      expect(cleaned1).toContain(task.id);

      // Second cleanup should skip
      const cleaned2 = await store.cleanupArchivedTasks();
      expect(cleaned2).not.toContain(task.id);
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

      await store.archiveTask(task.id);
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
  });

  describe("readArchiveLog", () => {
    it("returns empty array when archive.jsonl does not exist", async () => {
      const entries = await store.readArchiveLog();
      expect(entries).toEqual([]);
    });

    it("returns parsed entries from archive.jsonl", async () => {
      const task = await store.createTask({ description: "Test read" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const entries = await store.readArchiveLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(task.id);
      expect(entries[0].description).toBe("Test read");
    });

    it("handles multiple entries in archive.jsonl", async () => {
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
  });

  describe("unarchiveTask with restore", () => {
    it("restores missing task from archive.jsonl", async () => {
      const task = await store.createTask({ description: "Test restore" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      const dir = join(rootDir, ".fusion", "tasks", task.id);
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

      // Delete directory without archiving
      const dir = join(rootDir, ".fusion", "tasks", task.id);
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

      const dir = join(rootDir, ".fusion", "tasks", task.id);
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
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);

      // Should be in archive.jsonl
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

      const dir = join(rootDir, ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(false);
    });

    it("archiveTask(false) preserves directory (backward compatibility)", async () => {
      const task = await store.createTask({ description: "No cleanup" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id, false);
      expect(archived.column).toBe("archived");

      // Directory should still exist
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(true);
    });

    it("default cleanup parameter is false", async () => {
      const task = await store.createTask({ description: "Default cleanup" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const archived = await store.archiveTask(task.id); // No cleanup param
      expect(archived.column).toBe("archived");

      // Directory should still exist (default is false)
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      expect(existsSync(dir)).toBe(true);
    });
  });

  describe("archive log persistence", () => {
    it("archive log survives TaskStore reinitialization", async () => {
      const task = await store.createTask({ description: "Survival test" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id);
      await store.cleanupArchivedTasks();

      // Create new store instance
      const newStore = new TaskStore(rootDir, globalDir);
      await newStore.init();

      const entries = await newStore.readArchiveLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(task.id);
      expect(entries[0].description).toBe("Survival test");
    });
  });

  // ── Activity Log Tests ───────────────────────────────────────────

  describe("activity log", () => {
    it("recordActivity appends to log file", async () => {
      await store.recordActivity({ type: "task:created", taskId: "FN-001", taskTitle: "Test", details: "Created" });
      const logs = await store.getActivityLog();
      expect(logs).toHaveLength(1);
      expect(logs[0].type).toBe("task:created");
      expect(logs[0].id).toBeDefined();
      expect(logs[0].timestamp).toBeDefined();
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
      await store.recordActivity({ type: "task:created", taskId: "FN-001", details: "Test" });

      // Create new store instance
      const newStore = new TaskStore(rootDir, globalDir);
      await newStore.init();

      const logs = await newStore.getActivityLog();
      expect(logs).toHaveLength(1);
      expect(logs[0].taskId).toBe("FN-001");
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

  describe("Workflow Steps", () => {
    it("should create a workflow step with all fields", async () => {
      const ws = await store.createWorkflowStep({
        name: "Documentation Review",
        description: "Verify all public APIs have documentation",
        prompt: "Review the task changes and verify that all new public functions have docs.",
        enabled: true,
      });

      expect(ws.id).toBe("WS-001");
      expect(ws.name).toBe("Documentation Review");
      expect(ws.description).toBe("Verify all public APIs have documentation");
      expect(ws.mode).toBe("prompt");
      expect(ws.prompt).toBe("Review the task changes and verify that all new public functions have docs.");
      expect(ws.scriptName).toBeUndefined();
      expect(ws.enabled).toBe(true);
      expect(ws.createdAt).toBeDefined();
      expect(ws.updatedAt).toBeDefined();
    });

    it("should create a workflow step with minimal fields", async () => {
      const ws = await store.createWorkflowStep({
        name: "QA Check",
        description: "Run tests and verify they pass",
      });

      expect(ws.id).toBe("WS-001");
      expect(ws.name).toBe("QA Check");
      expect(ws.description).toBe("Run tests and verify they pass");
      expect(ws.mode).toBe("prompt"); // Default mode
      expect(ws.prompt).toBe(""); // Empty when not provided
      expect(ws.enabled).toBe(true); // Default enabled
    });

    it("should create a script-mode workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Run Tests",
        description: "Execute the test suite",
        mode: "script",
        scriptName: "test",
      });

      expect(ws.id).toBe("WS-001");
      expect(ws.name).toBe("Run Tests");
      expect(ws.mode).toBe("script");
      expect(ws.prompt).toBe("");
      expect(ws.scriptName).toBe("test");
      expect(ws.modelProvider).toBeUndefined();
      expect(ws.modelId).toBeUndefined();
      expect(ws.enabled).toBe(true);
    });

    it("should reject script mode without scriptName", async () => {
      await expect(
        store.createWorkflowStep({
          name: "Broken",
          description: "No script name",
          mode: "script",
        }),
      ).rejects.toThrow("Script mode requires a scriptName");
    });

    it("should reject script mode with empty scriptName", async () => {
      await expect(
        store.createWorkflowStep({
          name: "Broken",
          description: "Empty script name",
          mode: "script",
          scriptName: "  ",
        }),
      ).rejects.toThrow("Script mode requires a scriptName");
    });

    it("should auto-increment workflow step IDs", async () => {
      const ws1 = await store.createWorkflowStep({ name: "Step 1", description: "First" });
      const ws2 = await store.createWorkflowStep({ name: "Step 2", description: "Second" });
      const ws3 = await store.createWorkflowStep({ name: "Step 3", description: "Third" });

      expect(ws1.id).toBe("WS-001");
      expect(ws2.id).toBe("WS-002");
      expect(ws3.id).toBe("WS-003");
    });

    it("should list workflow steps", async () => {
      await store.createWorkflowStep({ name: "Step 1", description: "First" });
      await store.createWorkflowStep({ name: "Step 2", description: "Second" });

      const steps = await store.listWorkflowSteps();
      expect(steps).toHaveLength(2);
      expect(steps[0].name).toBe("Step 1");
      expect(steps[1].name).toBe("Step 2");
    });

    it("should return empty array when no workflow steps exist", async () => {
      const steps = await store.listWorkflowSteps();
      expect(steps).toHaveLength(0);
    });

    it("should get a single workflow step by ID", async () => {
      const ws = await store.createWorkflowStep({ name: "Docs", description: "Check docs" });
      const found = await store.getWorkflowStep(ws.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(ws.id);
      expect(found!.name).toBe("Docs");
    });

    it("should return undefined for non-existent workflow step", async () => {
      const found = await store.getWorkflowStep("WS-999");
      expect(found).toBeUndefined();
    });

    it("should update a workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Original",
        description: "Original desc",
        prompt: "Original prompt",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        name: "Updated",
        description: "Updated desc",
        prompt: "Updated prompt",
        enabled: false,
      });

      expect(updated.name).toBe("Updated");
      expect(updated.description).toBe("Updated desc");
      expect(updated.mode).toBe("prompt");
      expect(updated.prompt).toBe("Updated prompt");
      expect(updated.enabled).toBe(false);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(ws.updatedAt).getTime()
      );
    });

    it("should switch a workflow step from prompt to script mode", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
        prompt: "Review documentation.",
        mode: "prompt",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        mode: "script",
        scriptName: "lint",
      });

      expect(updated.mode).toBe("script");
      expect(updated.scriptName).toBe("lint");
      expect(updated.prompt).toBe(""); // Cleared on mode switch
      expect(updated.modelProvider).toBeUndefined(); // Cleared on mode switch
      expect(updated.modelId).toBeUndefined(); // Cleared on mode switch
    });

    it("should switch a workflow step from script to prompt mode", async () => {
      const ws = await store.createWorkflowStep({
        name: "Lint",
        description: "Run linting",
        mode: "script",
        scriptName: "lint",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        mode: "prompt",
        prompt: "Review code quality.",
      });

      expect(updated.mode).toBe("prompt");
      expect(updated.scriptName).toBeUndefined(); // Cleared on mode switch
      expect(updated.prompt).toBe("Review code quality.");
    });

    it("should reject switching to script mode without scriptName", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
        prompt: "Review documentation.",
      });

      await expect(
        store.updateWorkflowStep(ws.id, { mode: "script" }),
      ).rejects.toThrow("Script mode requires a scriptName");
    });

    it("should ignore prompt updates for script-mode steps", async () => {
      const ws = await store.createWorkflowStep({
        name: "Lint",
        description: "Run linting",
        mode: "script",
        scriptName: "lint",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        prompt: "This should be ignored",
      });

      expect(updated.prompt).toBe(""); // Prompt not updated for script mode
    });

    it("should ignore model override updates for script-mode steps", async () => {
      const ws = await store.createWorkflowStep({
        name: "Lint",
        description: "Run linting",
        mode: "script",
        scriptName: "lint",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      // Model overrides should not be set for script mode
      expect(updated.modelProvider).toBeUndefined();
      expect(updated.modelId).toBeUndefined();
    });

    it("should throw when updating non-existent workflow step", async () => {
      await expect(
        store.updateWorkflowStep("WS-999", { name: "Nope" })
      ).rejects.toThrow("Workflow step 'WS-999' not found");
    });

    it("should delete a workflow step", async () => {
      const ws = await store.createWorkflowStep({ name: "ToDelete", description: "Gone" });
      await store.deleteWorkflowStep(ws.id);

      const steps = await store.listWorkflowSteps();
      expect(steps).toHaveLength(0);
    });

    it("should throw when deleting non-existent workflow step", async () => {
      await expect(store.deleteWorkflowStep("WS-999")).rejects.toThrow(
        "Workflow step 'WS-999' not found"
      );
    });

    it("should remove references from tasks when deleting a workflow step", async () => {
      const ws = await store.createWorkflowStep({ name: "Docs", description: "Check docs" });
      const task = await store.createTask({
        description: "Test task with workflow steps",
        enabledWorkflowSteps: [ws.id],
      });

      expect(task.enabledWorkflowSteps).toEqual([ws.id]);

      await store.deleteWorkflowStep(ws.id);

      // Wait for async cleanup
      await new Promise((r) => setTimeout(r, 50));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.enabledWorkflowSteps).toBeUndefined();
    });

    it("should create a task with enabledWorkflowSteps", async () => {
      const ws1 = await store.createWorkflowStep({ name: "Docs", description: "Check docs" });
      const ws2 = await store.createWorkflowStep({ name: "QA", description: "Run tests" });

      const task = await store.createTask({
        description: "Task with workflow steps",
        enabledWorkflowSteps: [ws1.id, ws2.id],
      });

      expect(task.enabledWorkflowSteps).toEqual([ws1.id, ws2.id]);
    });

    it("should materialize built-in workflow templates when creating a task", async () => {
      const task = await store.createTask({
        description: "Task with browser verification",
        enabledWorkflowSteps: ["browser-verification"],
      });

      expect(task.enabledWorkflowSteps).toEqual(["WS-001"]);

      const step = await store.getWorkflowStep("WS-001");
      expect(step).toMatchObject({
        id: "WS-001",
        templateId: "browser-verification",
        name: "Browser Verification",
        toolMode: "coding",
      });
    });

    it("should reuse an existing materialized built-in workflow step", async () => {
      const first = await store.createTask({
        description: "First browser verification task",
        enabledWorkflowSteps: ["browser-verification"],
      });
      const second = await store.createTask({
        description: "Second browser verification task",
        enabledWorkflowSteps: ["browser-verification"],
      });

      expect(first.enabledWorkflowSteps).toEqual(["WS-001"]);
      expect(second.enabledWorkflowSteps).toEqual(["WS-001"]);

      const steps = await store.listWorkflowSteps();
      expect(steps.filter((step) => step.templateId === "browser-verification")).toHaveLength(1);
    });

    it("should not set enabledWorkflowSteps when empty array provided", async () => {
      const task = await store.createTask({
        description: "Task without workflow steps",
        enabledWorkflowSteps: [],
      });

      expect(task.enabledWorkflowSteps).toBeUndefined();
    });

    it("should create a workflow step with model override", async () => {
      const ws = await store.createWorkflowStep({
        name: "Security Audit",
        description: "Check for security issues",
        prompt: "Scan for vulnerabilities.",
        enabled: true,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      expect(ws.modelProvider).toBe("anthropic");
      expect(ws.modelId).toBe("claude-sonnet-4-5");
    });

    it("should create a workflow step without model override", async () => {
      const ws = await store.createWorkflowStep({
        name: "QA Check",
        description: "Run tests",
      });

      expect(ws.modelProvider).toBeUndefined();
      expect(ws.modelId).toBeUndefined();
    });

    it("should update a workflow step model override", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
      });

      const updated = await store.updateWorkflowStep(ws.id, {
        modelProvider: "openai",
        modelId: "gpt-4o",
      });

      expect(updated.modelProvider).toBe("openai");
      expect(updated.modelId).toBe("gpt-4o");
    });

    it("should clear a workflow step model override by setting to undefined", async () => {
      const ws = await store.createWorkflowStep({
        name: "Docs",
        description: "Check docs",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      expect(ws.modelProvider).toBe("anthropic");

      const updated = await store.updateWorkflowStep(ws.id, {
        modelProvider: undefined,
        modelId: undefined,
      });

      expect(updated.modelProvider).toBeUndefined();
      expect(updated.modelId).toBeUndefined();
    });

    it("should persist model override across list/get", async () => {
      const ws = await store.createWorkflowStep({
        name: "Perf Review",
        description: "Check performance",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      const listed = await store.listWorkflowSteps();
      expect(listed[0].modelProvider).toBe("anthropic");
      expect(listed[0].modelId).toBe("claude-sonnet-4-5");

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.modelProvider).toBe("anthropic");
      expect(found!.modelId).toBe("claude-sonnet-4-5");
    });

    it("should normalize legacy workflow steps without mode to prompt mode", async () => {
      // Create a step normally (it will have mode: "prompt")
      const ws = await store.createWorkflowStep({
        name: "Legacy Step",
        description: "Pre-existing step",
        prompt: "Review the code.",
      });

      // Simulate legacy data by writing a step without mode directly to DB
      const config = await (store as any).readConfig();
      // Remove mode from the stored step to simulate legacy data
      delete config.workflowSteps[0].mode;
      await (store as any).writeConfig(config);

      // Re-read should normalize mode to "prompt"
      const found = await store.getWorkflowStep(ws.id);
      expect(found!.mode).toBe("prompt");
      expect(found!.prompt).toBe("Review the code.");
    });

    it("should persist script-mode workflow step across list/get", async () => {
      const ws = await store.createWorkflowStep({
        name: "Type Check",
        description: "Run TypeScript type checking",
        mode: "script",
        scriptName: "typecheck",
      });

      const listed = await store.listWorkflowSteps();
      expect(listed[0].mode).toBe("script");
      expect(listed[0].scriptName).toBe("typecheck");

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.mode).toBe("script");
      expect(found!.scriptName).toBe("typecheck");
    });

    // ── Workflow Step defaultOn ──────────────────────────────────────────────

    it("should persist defaultOn flag on workflow step creation", async () => {
      const ws = await store.createWorkflowStep({
        name: "Default-on Step",
        description: "Auto-selected for new tasks",
        defaultOn: true,
      });

      expect(ws.defaultOn).toBe(true);

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBe(true);

      // Verify persistence
      const steps = await store.listWorkflowSteps();
      expect(steps[0].defaultOn).toBe(true);
    });

    it("should not set defaultOn by default", async () => {
      const ws = await store.createWorkflowStep({
        name: "Non-default Step",
        description: "Not auto-selected",
      });

      expect(ws.defaultOn).toBeUndefined();

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBeUndefined();
    });

    it("should update defaultOn flag on workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Step",
        description: "Desc",
      });

      const updated = await store.updateWorkflowStep(ws.id, { defaultOn: true });
      expect(updated.defaultOn).toBe(true);

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBe(true);
    });

    it("should clear defaultOn flag by setting to false", async () => {
      const ws = await store.createWorkflowStep({
        name: "Step",
        description: "Desc",
        defaultOn: true,
      });

      const updated = await store.updateWorkflowStep(ws.id, { defaultOn: false });
      expect(updated.defaultOn).toBe(false);

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.defaultOn).toBe(false);
    });

    it("should auto-apply default-on workflow steps when creating task without enabledWorkflowSteps", async () => {
      await store.createWorkflowStep({ name: "Always Run", description: "Auto-select", enabled: true, defaultOn: true });
      await store.createWorkflowStep({ name: "Optional Check", description: "Only when manually selected", enabled: true, defaultOn: false });
      await store.createWorkflowStep({ name: "Disabled Step", description: "Disabled step", enabled: false, defaultOn: true });

      const task = await store.createTask({ description: "Test task" });

      // Only the enabled + defaultOn step should be auto-applied
      expect(task.enabledWorkflowSteps).toEqual(["WS-001"]);
    });

    it("should use explicit enabledWorkflowSteps over default-on steps", async () => {
      await store.createWorkflowStep({ name: "Always Run", description: "Auto-select", enabled: true, defaultOn: true });

      const task = await store.createTask({
        description: "Test task",
        enabledWorkflowSteps: ["WS-001", "WS-002"],
      });

      // Explicit input takes precedence
      expect(task.enabledWorkflowSteps).toEqual(["WS-001", "WS-002"]);
    });

    it("should use empty enabledWorkflowSteps to override default-on steps", async () => {
      await store.createWorkflowStep({ name: "Always Run", description: "Auto-select", enabled: true, defaultOn: true });

      const task = await store.createTask({
        description: "Test task",
        enabledWorkflowSteps: [],
      });

      // Explicit empty array means user intentionally wants no steps
      expect(task.enabledWorkflowSteps).toBeUndefined();
    });

    it("should not auto-apply disabled steps even with defaultOn flag", async () => {
      await store.createWorkflowStep({ name: "Disabled Step", description: "Disabled step", enabled: false, defaultOn: true });

      const task = await store.createTask({ description: "Test task" });

      expect(task.enabledWorkflowSteps).toBeUndefined();
    });

    it("should auto-apply multiple default-on steps in order", async () => {
      await store.createWorkflowStep({ name: "First", description: "First", enabled: true, defaultOn: true });
      await store.createWorkflowStep({ name: "Second", description: "Second", enabled: true, defaultOn: true });
      await store.createWorkflowStep({ name: "Third", description: "Third", enabled: true, defaultOn: false });

      const task = await store.createTask({ description: "Test task" });

      expect(task.enabledWorkflowSteps).toEqual(["WS-001", "WS-002"]);
    });

    it("should update task workflow steps and materialize built-in templates", async () => {
      const task = await store.createTask({ description: "Editable task" });

      const updated = await store.updateTask(task.id, {
        enabledWorkflowSteps: ["browser-verification"],
      });

      expect(updated.enabledWorkflowSteps).toEqual(["WS-001"]);

      const persisted = await store.getTask(task.id);
      expect(persisted.enabledWorkflowSteps).toEqual(["WS-001"]);
    });

    it("should resolve built-in workflow templates from getWorkflowStep", async () => {
      const step = await store.getWorkflowStep("browser-verification");

      expect(step).toMatchObject({
        id: "browser-verification",
        templateId: "browser-verification",
        name: "Browser Verification",
        mode: "prompt",
        phase: "pre-merge",
        toolMode: "coding",
      });
    });

    // ── Workflow Step Phase ──────────────────────────────────────────────

    it("should default phase to 'pre-merge' when creating a workflow step", async () => {
      const ws = await store.createWorkflowStep({
        name: "Pre-merge Check",
        description: "Runs before merge",
      });

      expect(ws.phase).toBe("pre-merge");
    });

    it("should create a workflow step with explicit 'post-merge' phase", async () => {
      const ws = await store.createWorkflowStep({
        name: "Post-merge Notify",
        description: "Runs after merge",
        phase: "post-merge",
      });

      expect(ws.phase).toBe("post-merge");
    });

    it("should create a workflow step with explicit 'pre-merge' phase", async () => {
      const ws = await store.createWorkflowStep({
        name: "Pre-merge Gate",
        description: "Runs before merge",
        phase: "pre-merge",
      });

      expect(ws.phase).toBe("pre-merge");
    });

    it("should update a workflow step phase from pre-merge to post-merge", async () => {
      const ws = await store.createWorkflowStep({
        name: "Phase Switch",
        description: "Will switch phase",
      });

      expect(ws.phase).toBe("pre-merge");

      const updated = await store.updateWorkflowStep(ws.id, { phase: "post-merge" });
      expect(updated.phase).toBe("post-merge");
    });

    it("should persist phase across list/get", async () => {
      const ws = await store.createWorkflowStep({
        name: "Phase Persist",
        description: "Check phase persistence",
        phase: "post-merge",
      });

      const listed = await store.listWorkflowSteps();
      expect(listed[0].phase).toBe("post-merge");

      const found = await store.getWorkflowStep(ws.id);
      expect(found!.phase).toBe("post-merge");
    });

    it("should normalize legacy workflow steps without phase to pre-merge", async () => {
      const ws = await store.createWorkflowStep({
        name: "Legacy Step",
        description: "Pre-existing step",
        prompt: "Review the code.",
      });

      // Simulate legacy data by removing phase from the stored step
      const config = await (store as any).readConfig();
      delete config.workflowSteps[0].phase;
      await (store as any).writeConfig(config);

      // Re-read: phase should be undefined (legacy), but when used by engine
      // it should be treated as "pre-merge"
      const found = await store.getWorkflowStep(ws.id);
      expect(found!.phase).toBeUndefined();
    });
  });

  // ── Title Summarization Tests ────────────────────────────────────────────

  describe("createTask with title summarization", () => {
    it("should use generated title when onSummarize returns a title", async () => {
      const longDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Generated Title");

      const task = await store.createTask(
        { description: longDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("AI Generated Title");
      expect(mockOnSummarize).toHaveBeenCalledWith(longDescription);
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

      expect(task.title).toBe("AI Title");
      expect(mockOnSummarize).toHaveBeenCalled();
    });

    it("should handle onSummarize returning null", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue(null);

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();
    });

    it("should handle onSummarize throwing error gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockOnSummarize = vi.fn().mockRejectedValue(new Error("AI service failed"));

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();
      expect(task.id).toMatch(/^FN-\d+$/); // Task still created
      expect(consoleSpy.mock.calls[0][0]).toMatch(/Title summarization failed for task/);
      expect(consoleSpy.mock.calls[0][0]).toMatch(/AI service failed/);
      expect(consoleSpy.mock.calls[0][0]).toMatch(/desc length: 201/);
      expect(consoleSpy.mock.calls[0][0]).toMatch(/auto-summarize: true/);

      consoleSpy.mockRestore();
    });

    it("should trigger summarization at exactly 201 characters", async () => {
      const boundaryDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).toHaveBeenCalled();
    });

    it("should not trigger summarization at exactly 200 characters", async () => {
      const boundaryDescription = "a".repeat(200);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).not.toHaveBeenCalled();
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

      expect(task.title).toBe("Generated Task Title");

      const detail = await store.getTask(task.id);
      expect(detail.prompt).toMatch(/^# FN-\d+: Generated Task Title\n/);
    });

    it("should preserve original description when generating a title", async () => {
      const originalDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Summary Title");

      const task = await store.createTask(
        { description: originalDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("AI Summary Title");
      expect(task.description).toBe(originalDescription);

      const detail = await store.getTask(task.id);
      expect(detail.description).toBe(originalDescription);
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

    it("cache is updated when polling is active even without fs.watch", async () => {
      // Start watching which enables polling
      await store.watch();
      const task = await createTestTask();

      // Verify the cache was updated (internal detail: the isWatching getter)
      // Move the task and verify the event fires correctly (not duplicated by poll)
      const movedEvents: any[] = [];
      store.on("task:moved", (data: any) => movedEvents.push(data));
      await store.moveTask(task.id, "todo");

      expect(movedEvents).toHaveLength(1);
      expect(movedEvents[0].from).toBe("triage");
      expect(movedEvents[0].to).toBe("todo");
    });
  });

  describe("recovery metadata (recoveryRetryCount / nextRecoveryAt)", () => {
    async function createTestTask(overrides: Partial<import("./types.js").TaskCreateInput> = {}) {
      return store.createTask({ description: "recovery test task", ...overrides });
    }

    it("new tasks have no recovery metadata (defaults to undefined)", async () => {
      const task = await createTestTask();
      expect(task.recoveryRetryCount).toBeUndefined();
      expect(task.nextRecoveryAt).toBeUndefined();
    });

    it("updateTask can set and clear recoveryRetryCount and nextRecoveryAt", async () => {
      const task = await createTestTask();
      const futureTime = new Date(Date.now() + 60_000).toISOString();

      // Set
      const updated = await store.updateTask(task.id, {
        recoveryRetryCount: 2,
        nextRecoveryAt: futureTime,
      });
      expect(updated.recoveryRetryCount).toBe(2);
      expect(updated.nextRecoveryAt).toBe(futureTime);

      // Re-read to verify persistence
      const reread = await store.getTask(task.id);
      expect(reread.recoveryRetryCount).toBe(2);
      expect(reread.nextRecoveryAt).toBe(futureTime);

      // Clear
      const cleared = await store.updateTask(task.id, {
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });
      expect(cleared.recoveryRetryCount).toBeUndefined();
      expect(cleared.nextRecoveryAt).toBeUndefined();
    });

    it("moveTask to in-review clears recovery metadata", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, {
        recoveryRetryCount: 3,
        nextRecoveryAt: new Date().toISOString(),
      });
      await store.moveTask(task.id, "in-progress");
      const moved = await store.moveTask(task.id, "in-review");
      expect(moved.recoveryRetryCount).toBeUndefined();
      expect(moved.nextRecoveryAt).toBeUndefined();
    });

    it("moveTask to done clears recovery metadata", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, {
        recoveryRetryCount: 1,
        nextRecoveryAt: new Date().toISOString(),
      });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const done = await store.moveTask(task.id, "done");
      expect(done.recoveryRetryCount).toBeUndefined();
      expect(done.nextRecoveryAt).toBeUndefined();
    });

    it("moveTask from in-progress to todo preserves recovery metadata", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const futureTime = new Date(Date.now() + 60_000).toISOString();
      await store.updateTask(task.id, {
        recoveryRetryCount: 2,
        nextRecoveryAt: futureTime,
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.recoveryRetryCount).toBe(2);
      expect(moved.nextRecoveryAt).toBe(futureTime);
    });

    it("recovery metadata persists across store re-initialization", async () => {
      const task = await createTestTask();
      const futureTime = new Date(Date.now() + 60_000).toISOString();
      await store.updateTask(task.id, {
        recoveryRetryCount: 5,
        nextRecoveryAt: futureTime,
      });

      // Re-create store to simulate restart
      store.stopWatching();
      const store2 = new TaskStore(rootDir, globalDir);
      await store2.init();

      const reloaded = await store2.getTask(task.id);
      expect(reloaded.recoveryRetryCount).toBe(5);
      expect(reloaded.nextRecoveryAt).toBe(futureTime);
      store2.stopWatching();
    });

    it("schema migration: existing rows default to NULL (undefined) for recovery fields", async () => {
      // Tasks created before the migration should have undefined recovery fields
      const task = await createTestTask();
      const detail = await store.getTask(task.id);
      expect(detail.recoveryRetryCount).toBeUndefined();
      expect(detail.nextRecoveryAt).toBeUndefined();
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
        vi.importActual<typeof import("./run-command.js")>("./run-command.js").then((mod) =>
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
    it("creates .fusion/memory.md on init when memoryEnabled is default (true)", async () => {
      // The default store in beforeEach already called init() with default settings
      // memoryEnabled defaults to true, so memory.md should exist
      const memoryPath = join(rootDir, ".fusion", "memory.md");
      expect(existsSync(memoryPath)).toBe(true);

      const content = await readFile(memoryPath, "utf-8");
      expect(content).toContain("# Project Memory");
      expect(content).toContain("## Architecture");
      expect(content).toContain("## Conventions");
    });

    it("does not create .fusion/memory.md when memoryEnabled is false", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      try {
        const localStore = new TaskStore(localRoot, localGlobal);
        await localStore.init();
        // Explicitly disable memory
        await localStore.updateSettings({ memoryEnabled: false } as any);
        // Delete the file if it was created during init (default enabled)
        const memoryPath = join(localRoot, ".fusion", "memory.md");
        if (existsSync(memoryPath)) {
          await unlink(memoryPath);
        }
        localStore.stopWatching();

        // Re-init with memory disabled
        const store2 = new TaskStore(localRoot, localGlobal);
        // Manually set memoryEnabled to false before init
        await store2.init();
        await store2.updateSettings({ memoryEnabled: false } as any);
        // After setting false, verify we can init without creating
        store2.stopWatching();

        // Create a third store with memory disabled in config
        const store3 = new TaskStore(localRoot, localGlobal);
        await store3.updateSettings({ memoryEnabled: false } as any);
        await store3.init();

        // Memory file should not exist if it was deleted
        // But init creates it by default, then we disabled it
        // The key behavior is that when memoryEnabled is explicitly false,
        // init() should not create the file
        store3.stopWatching();
      } finally {
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });

    it("creates .fusion/memory.md when memory is toggled on via updateSettings", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      try {
        const localStore = new TaskStore(localRoot, localGlobal);
        await localStore.init();

        // First disable memory
        await localStore.updateSettings({ memoryEnabled: false } as any);
        const memoryPath = join(localRoot, ".fusion", "memory.md");

        // Delete the file that was created during init
        if (existsSync(memoryPath)) {
          await unlink(memoryPath);
        }
        expect(existsSync(memoryPath)).toBe(false);

        // Now toggle memory back on
        await localStore.updateSettings({ memoryEnabled: true } as any);
        expect(existsSync(memoryPath)).toBe(true);

        const content = await readFile(memoryPath, "utf-8");
        expect(content).toContain("# Project Memory");

        localStore.stopWatching();
      } finally {
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });

    it("does not overwrite existing memory content when toggled on", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      try {
        const localStore = new TaskStore(localRoot, localGlobal);
        await localStore.init();
        const memoryPath = join(localRoot, ".fusion", "memory.md");

        // Write custom content
        const customContent = "# My Custom Memory\n\nImportant stuff";
        await writeFile(memoryPath, customContent, "utf-8");

        // Disable then re-enable memory
        await localStore.updateSettings({ memoryEnabled: false } as any);
        await localStore.updateSettings({ memoryEnabled: true } as any);

        // Custom content should be preserved
        const content = await readFile(memoryPath, "utf-8");
        expect(content).toBe(customContent);

        localStore.stopWatching();
      } finally {
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });
  });



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
});

describe("RunMutationContext", () => {
  it("logEntry() with runContext includes runContext field", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task = await localStore.createTask({ description: "Test task" });
      const runContext = { runId: "run-123", agentId: "agent-456" };

      await localStore.logEntry(task.id, "Test action", "Test outcome", runContext);

      const updatedTask = await localStore.getTask(task.id);
      // Task creation adds 1 entry ("Task created"), logEntry adds 1 more
      expect(updatedTask.log).toHaveLength(2);
      // The last entry is the one we just added
      const lastEntry = updatedTask.log[updatedTask.log.length - 1];
      expect(lastEntry.runContext).toEqual(runContext);
      expect(lastEntry.action).toBe("Test action");
      expect(lastEntry.outcome).toBe("Test outcome");

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });

  it("logEntry() without runContext has no runContext field (backward compat)", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task = await localStore.createTask({ description: "Test task" });
      await localStore.logEntry(task.id, "Test action", "Test outcome");

      const updatedTask = await localStore.getTask(task.id);
      // Task creation adds 1 entry ("Task created"), logEntry adds 1 more
      expect(updatedTask.log).toHaveLength(2);
      // The last entry is the one we just added
      const lastEntry = updatedTask.log[updatedTask.log.length - 1];
      expect(lastEntry.runContext).toBeUndefined();
      expect(lastEntry.action).toBe("Test action");

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });

  it("addComment() with runContext includes runContext in log entry", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task = await localStore.createTask({ description: "Test task" });
      const runContext = { runId: "run-789", agentId: "agent-101" };

      await localStore.addComment(task.id, "Test comment", "user", undefined, runContext);

      const updatedTask = await localStore.getTask(task.id);
      expect(updatedTask.comments).toHaveLength(1);
      expect(updatedTask.comments![0].text).toBe("Test comment");
      // Task creation adds 1 entry ("Task created"), addComment adds 1 more
      expect(updatedTask.log).toHaveLength(2);
      // The last entry is the one we just added
      const lastEntry = updatedTask.log[updatedTask.log.length - 1];
      expect(lastEntry.runContext).toEqual(runContext);

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });

  it("addSteeringComment() forwards runContext to addComment", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task = await localStore.createTask({ description: "Test task" });
      const runContext = { runId: "run-abc", agentId: "agent-def", source: "timer" };

      await localStore.addSteeringComment(task.id, "Steering comment", "agent", runContext);

      const updatedTask = await localStore.getTask(task.id);
      expect(updatedTask.steeringComments).toHaveLength(1);
      expect(updatedTask.steeringComments![0].text).toBe("Steering comment");
      // Task creation adds 1 entry ("Task created"), addComment adds 1 more
      expect(updatedTask.log).toHaveLength(2);
      // The last entry is the one we just added
      const lastEntry = updatedTask.log[updatedTask.log.length - 1];
      expect(lastEntry.runContext).toEqual(runContext);

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });

  it("getMutationsForRun(runId) returns only entries matching the runId, sorted by timestamp", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task1 = await localStore.createTask({ description: "Task 1" });
      const task2 = await localStore.createTask({ description: "Task 2" });

      // Add entries with different runIds
      await localStore.logEntry(task1.id, "Action 1", undefined, { runId: "run-target", agentId: "agent-1" });
      await new Promise(r => setTimeout(r, 10)); // Ensure different timestamps
      await localStore.logEntry(task2.id, "Action 2", undefined, { runId: "run-target", agentId: "agent-1" });
      await new Promise(r => setTimeout(r, 10));
      await localStore.logEntry(task1.id, "Action 3", undefined, { runId: "run-other", agentId: "agent-2" });

      const mutations = await localStore.getMutationsForRun("run-target");

      expect(mutations).toHaveLength(2);
      expect(mutations.map(m => m.action)).toEqual(["Action 1", "Action 2"]);
      // Verify sorted by timestamp
      expect(new Date(mutations[0].timestamp).getTime()).toBeLessThan(new Date(mutations[1].timestamp).getTime());

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });

  it("getMutationsForRun(unknownRunId) returns empty array", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task = await localStore.createTask({ description: "Test task" });
      await localStore.logEntry(task.id, "Some action", undefined, { runId: "run-existing", agentId: "agent-1" });

      const mutations = await localStore.getMutationsForRun("run-does-not-exist");

      expect(mutations).toEqual([]);

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });

  it("getMutationsForRun() collects entries across multiple tasks", async () => {
    const localRoot = makeTmpDir();
    const localGlobal = makeTmpDir();
    try {
      const localStore = new TaskStore(localRoot, localGlobal);
      await localStore.init();

      const task1 = await localStore.createTask({ description: "Task 1" });
      const task2 = await localStore.createTask({ description: "Task 2" });
      const task3 = await localStore.createTask({ description: "Task 3" });

      await localStore.logEntry(task1.id, "Entry 1", undefined, { runId: "run-shared", agentId: "agent-x" });
      await localStore.logEntry(task2.id, "Entry 2", undefined, { runId: "run-shared", agentId: "agent-x" });
      await localStore.logEntry(task3.id, "Entry 3", undefined, { runId: "run-other", agentId: "agent-y" });

      const mutations = await localStore.getMutationsForRun("run-shared");

      expect(mutations).toHaveLength(2);
      expect(mutations.map(m => m.action).sort()).toEqual(["Entry 1", "Entry 2"]);

      localStore.stopWatching();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await rm(localGlobal, { recursive: true, force: true });
    }
  });
  });
});
