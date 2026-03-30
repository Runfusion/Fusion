import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore } from "./store.js";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Task } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-test-"));
}

describe("TaskStore", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new TaskStore(rootDir);
    await store.init();
  });

  afterEach(async () => {
    store.stopWatching();
    await rm(rootDir, { recursive: true, force: true });
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

  // ── Prompt generation (no duplicate description) ───────────────

  describe("prompt generation", () => {
    it("triage task without title does not duplicate description in PROMPT.md", async () => {
      const task = await store.createTask({ description: "Fix the login bug" });
      const detail = await store.getTask(task.id);

      // Heading should be just the ID, not the description
      expect(detail.prompt).toMatch(/^# KB-001\n/);
      // Description appears exactly once
      const count = detail.prompt.split("Fix the login bug").length - 1;
      expect(count).toBe(1);
    });

    it("triage task with title uses title in heading and description in body", async () => {
      const task = await store.createTask({
        title: "Login bug",
        description: "Fix the login bug on the settings page",
      });
      const detail = await store.getTask(task.id);

      expect(detail.prompt).toMatch(/^# KB-001: Login bug\n/);
      expect(detail.prompt).toContain("Fix the login bug on the settings page");
    });

    it("generateSpecifiedPrompt does not duplicate when title is absent", async () => {
      const task = await store.createTask({
        description: "Implement caching layer",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      // Heading should be just the ID
      expect(detail.prompt).toMatch(/^# KB-001\n/);
      // Description appears exactly once (in Mission section)
      const count = detail.prompt.split("Implement caching layer").length - 1;
      expect(count).toBe(1);
    });

    it("generateSpecifiedPrompt uses title in heading when present", async () => {
      const task = await store.createTask({
        title: "Add caching",
        description: "Implement caching layer for API responses",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      expect(detail.prompt).toMatch(/^# KB-001: Add caching\n/);
      expect(detail.prompt).toContain("Implement caching layer for API responses");
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
    it("throws on corrupted task.json with trailing duplicate content (atomic writes prevent this)", async () => {
      const task = await createTestTask();
      const taskJsonPath = join(rootDir, ".kb", "tasks", task.id, "task.json");

      // Corrupt the file: append duplicate trailing content
      const validJson = await readFile(taskJsonPath, "utf-8");
      const corrupted = validJson + validJson.slice(validJson.length / 2);
      await writeFile(taskJsonPath, corrupted);

      // With atomic writes, corruption indicates a real bug — should throw
      await expect(store.getTask(task.id)).rejects.toThrow("Failed to parse task.json");
    });

    it("throws a clear error when JSON is completely unrecoverable", async () => {
      const task = await createTestTask();
      const taskJsonPath = join(rootDir, ".kb", "tasks", task.id, "task.json");

      // Write completely invalid content
      await writeFile(taskJsonPath, "not json at all {{{");

      await expect(store.getTask(task.id)).rejects.toThrow("Failed to parse task.json");
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

      // IDs should be sequential (KB-001 through KB-005)
      const sortedIds = [...ids].sort();
      expect(sortedIds).toEqual(["KB-001", "KB-002", "KB-003", "KB-004", "KB-005"]);

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
    it("persists defaultProvider and defaultModelId and returns them via getSettings", async () => {
      await store.updateSettings({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" });
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

      const updated = await store.updateTask(task.id, { dependencies: ["KB-001", "KB-002"] });
      expect(updated.dependencies).toEqual(["KB-001", "KB-002"]);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual(["KB-001", "KB-002"]);
    });

    it("replaces existing dependencies", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-001"] });
      expect(task.dependencies).toEqual(["KB-001"]);

      const updated = await store.updateTask(task.id, { dependencies: ["KB-002", "KB-003"] });
      expect(updated.dependencies).toEqual(["KB-002", "KB-003"]);
    });

    it("clears dependencies with empty array", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-001"] });
      expect(task.dependencies).toEqual(["KB-001"]);

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.dependencies).toEqual([]);
    });

    it("leaves dependencies unchanged when not provided", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-001"] });

      const updated = await store.updateTask(task.id, { title: "New title" });
      expect(updated.dependencies).toEqual(["KB-001"]);
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
      const task = await store.createTask({ description: "Todo task", column: "todo", dependencies: ["KB-001"] });

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.column).toBe("todo");
    });

    it("does NOT move when dependencies are replaced with same set", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo", dependencies: ["KB-001"] });

      const updated = await store.updateTask(task.id, { dependencies: ["KB-001"] });
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
    it("default prefix produces KB-001 IDs", async () => {
      const task = await store.createTask({ description: "Default prefix" });
      expect(task.id).toBe("KB-001");
    });

    it("custom prefix produces PROJ-001 IDs", async () => {
      await store.updateSettings({ taskPrefix: "PROJ" });
      const task = await store.createTask({ description: "Custom prefix" });
      expect(task.id).toBe("PROJ-001");
    });

    it("prefix change mid-stream continues sequence", async () => {
      const t1 = await store.createTask({ description: "First" });
      const t2 = await store.createTask({ description: "Second" });
      expect(t1.id).toBe("KB-001");
      expect(t2.id).toBe("KB-002");

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
      expect(tasks.map((t) => t.id).sort()).toEqual(["KB-001", "PROJ-002"]);
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
  });

  describe("parseDependenciesFromPrompt", () => {
    it("returns single dependency from PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with dep" });
      const dir = join(rootDir, ".kb", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with dep

## Dependencies

- **Task:** KB-001 (must be complete first)

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual(["KB-001"]);
    });

    it("returns multiple dependencies in order", async () => {
      const task = await store.createTask({ description: "Task with deps" });
      const dir = join(rootDir, ".kb", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with deps

## Dependencies

- **Task:** KB-010 (first dep)
- **Task:** KB-020 (second dep)
- **Task:** PROJ-003 (third dep)

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual(["KB-010", "KB-020", "PROJ-003"]);
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
      const { unlink } = await import("node:fs/promises");
      await unlink(join(dir, "PROMPT.md"));

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
      const { unlink } = await import("node:fs/promises");
      await unlink(join(dir, "PROMPT.md"));

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
});
