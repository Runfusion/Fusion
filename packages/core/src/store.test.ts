import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore } from "./store.js";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Task } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hai-store-test-"));
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
    const dir = join(rootDir, ".hai", "tasks", task.id);
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
      expect(detail.prompt).toMatch(/^# HAI-001\n/);
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

      expect(detail.prompt).toMatch(/^# HAI-001: Login bug\n/);
      expect(detail.prompt).toContain("Fix the login bug on the settings page");
    });

    it("generateSpecifiedPrompt does not duplicate when title is absent", async () => {
      const task = await store.createTask({
        description: "Implement caching layer",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      // Heading should be just the ID
      expect(detail.prompt).toMatch(/^# HAI-001\n/);
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

      expect(detail.prompt).toMatch(/^# HAI-001: Add caching\n/);
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
      const taskJsonPath = join(rootDir, ".hai", "tasks", id, "task.json");
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
      const taskJsonPath = join(rootDir, ".hai", "tasks", task.id, "task.json");

      // Corrupt the file: append duplicate trailing content
      const validJson = await readFile(taskJsonPath, "utf-8");
      const corrupted = validJson + validJson.slice(validJson.length / 2);
      await writeFile(taskJsonPath, corrupted);

      // With atomic writes, corruption indicates a real bug — should throw
      await expect(store.getTask(task.id)).rejects.toThrow("Failed to parse task.json");
    });

    it("throws a clear error when JSON is completely unrecoverable", async () => {
      const task = await createTestTask();
      const taskJsonPath = join(rootDir, ".hai", "tasks", task.id, "task.json");

      // Write completely invalid content
      await writeFile(taskJsonPath, "not json at all {{{");

      await expect(store.getTask(task.id)).rejects.toThrow("Failed to parse task.json");
    });
  });

  // ── Atomic write test ────────────────────────────────────────────

  describe("atomic writes", () => {
    it("produces valid JSON after write with no .tmp files left behind", async () => {
      const task = await createTestTask();
      const dir = join(rootDir, ".hai", "tasks", task.id);

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

      // IDs should be sequential (HAI-001 through HAI-005)
      const sortedIds = [...ids].sort();
      expect(sortedIds).toEqual(["HAI-001", "HAI-002", "HAI-003", "HAI-004", "HAI-005"]);

      // config.json should be valid JSON with nextId = 6
      const configPath = join(rootDir, ".hai", "config.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      expect(config.nextId).toBe(6);

      // No .tmp files left behind
      const haiDir = join(rootDir, ".hai");
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
      const filePath = join(rootDir, ".hai", "tasks", task.id, "attachments", attachment.filename);
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
      const filePath = join(rootDir, ".hai", "tasks", task.id, "attachments", attachment.filename);
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

      const updated = await store.updateTask(task.id, { dependencies: ["HAI-001", "HAI-002"] });
      expect(updated.dependencies).toEqual(["HAI-001", "HAI-002"]);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual(["HAI-001", "HAI-002"]);
    });

    it("replaces existing dependencies", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["HAI-001"] });
      expect(task.dependencies).toEqual(["HAI-001"]);

      const updated = await store.updateTask(task.id, { dependencies: ["HAI-002", "HAI-003"] });
      expect(updated.dependencies).toEqual(["HAI-002", "HAI-003"]);
    });

    it("clears dependencies with empty array", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["HAI-001"] });
      expect(task.dependencies).toEqual(["HAI-001"]);

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.dependencies).toEqual([]);
    });

    it("leaves dependencies unchanged when not provided", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["HAI-001"] });

      const updated = await store.updateTask(task.id, { title: "New title" });
      expect(updated.dependencies).toEqual(["HAI-001"]);
    });
  });

  describe("updateTask — blockedBy", () => {
    it("sets blockedBy to a string value", async () => {
      const task = await store.createTask({ title: "Blocked task", description: "A task" });
      const updated = await store.updateTask(task.id, { blockedBy: "HAI-999" });
      expect(updated.blockedBy).toBe("HAI-999");
    });

    it("clears blockedBy when set to null", async () => {
      const task = await store.createTask({ title: "Blocked task", description: "A task" });
      await store.updateTask(task.id, { blockedBy: "HAI-999" });
      const updated = await store.updateTask(task.id, { blockedBy: null });
      expect(updated.blockedBy).toBeUndefined();
    });
  });
});
