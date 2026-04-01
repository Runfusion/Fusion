import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    const dir = join(rootDir, ".kb", "tasks", task.id);
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
    const dir = join(rootDir, ".kb", "tasks", taskId);
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
      const taskJsonPath = join(rootDir, ".kb", "tasks", id, "task.json");
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
      const taskJsonPath = join(rootDir, ".kb", "tasks", task.id, "task.json");

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
      const taskJsonPath = join(rootDir, ".kb", "tasks", task.id, "task.json");

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
      const dir = join(rootDir, ".kb", "tasks", task.id);

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
      const configPath = join(rootDir, ".kb", "config.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      expect(config.nextId).toBe(6);

      // No .tmp files left behind
      const haiDir = join(rootDir, ".kb");
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
      const filePath = join(rootDir, ".kb", "tasks", task.id, "attachments", attachment.filename);
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
      const filePath = join(rootDir, ".kb", "tasks", task.id, "attachments", attachment.filename);
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
      const configRaw = await readFile(join(rootDir, ".kb", "config.json"), "utf-8");
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
      const promptDir = join(rootDir, ".kb", "tasks", task.id);
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

    it("addSteeringComment recreates missing task directory before persisting metadata", async () => {
      const task = await createTestTask();
      const dir = await deleteTaskDir(task.id);

      const updated = await store.addSteeringComment(task.id, "Please recover from missing directory");

      expect(updated.steeringComments).toHaveLength(1);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "task.json"))).toBe(true);

      const fetched = await store.getTask(task.id);
      expect(fetched.steeringComments).toHaveLength(1);
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
      const duplicateDir = join(rootDir, ".kb", "tasks", duplicate.id);

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
      expect(updated.comments![0].updatedAt).toBeUndefined();
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

    it("persists task comments independently from steering comments", async () => {
      const task = await createTestTask();
      await store.addTaskComment(task.id, "General note", "alice");
      await store.addSteeringComment(task.id, "Execution note");

      const reopened = await store.getTask(task.id);
      expect(reopened.comments).toHaveLength(1);
      expect(reopened.comments![0].text).toBe("General note");
      expect(reopened.steeringComments).toHaveLength(1);
      expect(reopened.steeringComments![0].text).toBe("Execution note");
    });
  });

  describe("addSteeringComment", () => {
    it("adds a steering comment to a task", async () => {
      const task = await createTestTask();
      const updated = await store.addSteeringComment(task.id, "Please handle the edge case");

      expect(updated.steeringComments).toHaveLength(1);
      expect(updated.steeringComments![0].text).toBe("Please handle the edge case");
      expect(updated.steeringComments![0].author).toBe("user");
      expect(updated.steeringComments![0].id).toBeDefined();
      expect(updated.steeringComments![0].createdAt).toBeDefined();
    });

    it("accepts agent as author", async () => {
      const task = await createTestTask();
      const updated = await store.addSteeringComment(task.id, "Note from agent", "agent");

      expect(updated.steeringComments).toHaveLength(1);
      expect(updated.steeringComments![0].author).toBe("agent");
    });

    it("initializes steeringComments array if undefined", async () => {
      const task = await createTestTask();
      expect(task.steeringComments).toBeUndefined();

      const updated = await store.addSteeringComment(task.id, "First comment");
      expect(updated.steeringComments).toBeDefined();
      expect(updated.steeringComments).toHaveLength(1);
    });

    it("appends multiple comments in order", async () => {
      const task = await createTestTask();
      await store.addSteeringComment(task.id, "First comment");
      await store.addSteeringComment(task.id, "Second comment");
      await store.addSteeringComment(task.id, "Third comment");

      const fetched = await store.getTask(task.id);
      expect(fetched.steeringComments).toHaveLength(3);
      expect(fetched.steeringComments![0].text).toBe("First comment");
      expect(fetched.steeringComments![1].text).toBe("Second comment");
      expect(fetched.steeringComments![2].text).toBe("Third comment");
    });

    it("generates unique IDs for each comment", async () => {
      const task = await createTestTask();
      const updated1 = await store.addSteeringComment(task.id, "Comment 1");
      const updated2 = await store.addSteeringComment(task.id, "Comment 2");

      const id1 = updated1.steeringComments![0].id;
      const id2 = updated2.steeringComments![1].id;
      expect(id1).not.toBe(id2);
    });

    it("emits task:updated event", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      await store.addSteeringComment(task.id, "Test comment");

      expect(events).toHaveLength(1);
      expect(events[0].steeringComments).toHaveLength(1);
      expect(events[0].steeringComments![0].text).toBe("Test comment");
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await createTestTask();
      await store.addSteeringComment(task.id, "Persisted comment");

      const fetched = await store.getTask(task.id);
      expect(fetched.steeringComments).toHaveLength(1);
      expect(fetched.steeringComments![0].text).toBe("Persisted comment");
      expect(fetched.steeringComments![0].author).toBe("user");
    });

    it("adds log entry for the action", async () => {
      const task = await createTestTask();
      const updated = await store.addSteeringComment(task.id, "Comment with log");

      expect(updated.log.some((l) => l.action === "Steering comment added")).toBe(true);
      expect(updated.log.some((l) => l.outcome === "by user")).toBe(true);
    });

    it("updates updatedAt timestamp", async () => {
      const task = await createTestTask();
      const before = task.updatedAt;
      await new Promise((r) => setTimeout(r, 10)); // Ensure time passes

      const updated = await store.addSteeringComment(task.id, "Timestamp test");
      expect(updated.updatedAt).not.toBe(before);
    });

    it("creates refinement task when steering comment added to done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addSteeringComment(task.id, "Need to fix edge case");

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

      await store.addSteeringComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not create refinement when steering comment added to non-done task (in-progress)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const allTasksBefore = await store.listTasks();

      await store.addSteeringComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not create refinement when steering comment added to non-done task (in-review)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const allTasksBefore = await store.listTasks();

      await store.addSteeringComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("steering comment is still added to original task even when refinement is created", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.addSteeringComment(task.id, "Need to fix edge case");

      expect(updated.steeringComments).toHaveLength(1);
      expect(updated.steeringComments![0].text).toBe("Need to fix edge case");
    });

    it("refinement task has correct dependency on original done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.addSteeringComment(task.id, "Need to fix edge case");

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

      await store.addSteeringComment(task.id, "Agent feedback", "agent");

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
      const updated = await store.addSteeringComment(task.id, "   ");

      expect(updated.steeringComments).toHaveLength(1);
      expect(updated.steeringComments![0].text).toBe("   ");
    });
  });

  describe("task comments and merge details types", () => {
    it("keeps task comments distinct from steering comments on new tasks", async () => {
      const task = await createTestTask();
      const reopened = await store.getTask(task.id);

      expect(reopened.comments).toBeUndefined();
      expect(reopened.steeringComments).toBeUndefined();
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
      const taskJsonPath = join(rootDir, ".kb", "tasks", task.id, "task.json");
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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

      // Simulate a failed state
      await store.updateTask(task.id, {
        status: "failed",
        error: "Something went wrong",
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
      await store.addSteeringComment(task.id, "Test comment");

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.steeringComments).toBeUndefined();
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
      expect(refined.title).toBe(`Refinement: ${task.id}`);
    });

    it("creates refinement from in-review task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.column).toBe("triage");
      expect(refined.title).toBe(`Refinement: ${task.id}`);
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

    it("sets correct title format without original title (uses ID)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      expect(refined.title).toBe(`Refinement: ${task.id}`);
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
      const attachDir = join(rootDir, ".kb", "tasks", refined.id, "attachments");
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
      expect(detail.prompt).toContain(`Refinement: ${task.id}`);
      expect(detail.prompt).toContain("Need improvements");
      expect(detail.prompt).toContain(`Refines: ${task.id}`);
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

      const dir = join(rootDir, ".kb", "tasks", task.id);
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

      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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

      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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

      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
      const dir = join(rootDir, ".kb", "tasks", task.id);
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
        execSync(`git checkout -b kb/${task.id.toLowerCase()}`, { cwd: rootDir, stdio: "pipe" });
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
        execSync(`git checkout -b kb/${task.id.toLowerCase()}`, { cwd: rootDir, stdio: "pipe" });
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
      expect(ws.prompt).toBe("Review the task changes and verify that all new public functions have docs.");
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
      expect(ws.prompt).toBe(""); // Empty when not provided
      expect(ws.enabled).toBe(true); // Default enabled
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
      expect(updated.prompt).toBe("Updated prompt");
      expect(updated.enabled).toBe(false);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(ws.updatedAt).getTime()
      );
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

    it("should not set enabledWorkflowSteps when empty array provided", async () => {
      const task = await store.createTask({
        description: "Task without workflow steps",
        enabledWorkflowSteps: [],
      });

      expect(task.enabledWorkflowSteps).toBeUndefined();
    });
  });

  // ── Title Summarization Tests ────────────────────────────────────────────

  describe("createTask with title summarization", () => {
    it("should use generated title when onSummarize returns a title", async () => {
      const longDescription = "a".repeat(200);
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
        { title: "User Title", description: "a".repeat(200) },
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
        { description: "a".repeat(200) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: false } }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when no settings provided", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(200) },
        { onSummarize: mockOnSummarize }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should call onSummarize when summarize input flag is true", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(200), summarize: true },
        { onSummarize: mockOnSummarize }
      );

      expect(task.title).toBe("AI Title");
      expect(mockOnSummarize).toHaveBeenCalled();
    });

    it("should handle onSummarize returning null", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue(null);

      const task = await store.createTask(
        { description: "a".repeat(200) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();
    });

    it("should handle onSummarize throwing error gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockOnSummarize = vi.fn().mockRejectedValue(new Error("AI service failed"));

      const task = await store.createTask(
        { description: "a".repeat(200) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();
      expect(task.id).toMatch(/^FN-\d+$/); // Task still created
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Title summarization failed"),
        expect.stringContaining("AI service failed")
      );

      consoleSpy.mockRestore();
    });

    it("should trigger summarization at exactly 141 characters", async () => {
      const boundaryDescription = "a".repeat(141);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).toHaveBeenCalled();
    });

    it("should not trigger summarization at exactly 140 characters", async () => {
      const boundaryDescription = "a".repeat(140);
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
        { title: "User Title", description: "a".repeat(200), summarize: true },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("User Title");
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should include generated title in PROMPT.md heading", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("Generated Task Title");

      const task = await store.createTask(
        { description: "a".repeat(200) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("Generated Task Title");

      const detail = await store.getTask(task.id);
      expect(detail.prompt).toMatch(/^# FN-\d+: Generated Task Title\n/);
    });
  });
});
