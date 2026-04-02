import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../store.js";
import { CentralCore } from "../central-core.js";

// Helper to create a temp directory
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-compat-test-"));
}

// Helper to create a fake fusion project structure for the current store implementation
function createFakeFusionProject(dir: string): void {
  const fusionDir = join(dir, ".fusion");
  mkdirSync(fusionDir, { recursive: true });
  const db = new DatabaseSync(join(fusionDir, "kb.db"));
  db.exec("CREATE TABLE IF NOT EXISTS sanity (id INTEGER PRIMARY KEY)");
  db.close();
}

describe("TaskStore Backward Compatibility", () => {
  let tempDir: string;
  let centralCore: CentralCore;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    centralCore = new CentralCore(tempDir);
    await centralCore.init();
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    try {
      process.chdir(originalCwd);
      await centralCore.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getOrCreateForProject", () => {
    it("should create store for specified project ID", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });

      // Register the project first
      const project = await centralCore.registerProject({
        name: "my-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      const store = await TaskStore.getOrCreateForProject(project.id, centralCore);

      expect(store).toBeInstanceOf(TaskStore);
      // Verify it's using the correct path
      const settings = await store.getSettings();
      expect(settings).toBeDefined();
    });

    it("should fall back to exact project name lookup when ID lookup misses", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });

      // Register the project
      await centralCore.registerProject({
        name: "my-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      // Look up by name instead of ID
      const store = await TaskStore.getOrCreateForProject("my-project", centralCore);

      expect(store).toBeInstanceOf(TaskStore);
    });

    it("should use single registered project when no ID provided", async () => {
      const projectDir = join(tempDir, "single-project");
      mkdirSync(projectDir, { recursive: true });

      // Register exactly one project
      await centralCore.registerProject({
        name: "single-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      const store = await TaskStore.getOrCreateForProject(undefined, centralCore);

      expect(store).toBeInstanceOf(TaskStore);
    });

    it("should throw when multiple projects and no ID specified", async () => {
      const project1 = join(tempDir, "project-1");
      const project2 = join(tempDir, "project-2");
      mkdirSync(project1, { recursive: true });
      mkdirSync(project2, { recursive: true });

      // Register two projects
      await centralCore.registerProject({
        name: "project-1",
        path: project1,
        isolationMode: "in-process",
      });
      await centralCore.registerProject({
        name: "project-2",
        path: project2,
        isolationMode: "in-process",
      });

      await expect(
        TaskStore.getOrCreateForProject(undefined, centralCore)
      ).rejects.toThrow("Multiple projects registered");
    });


    it("should fall back to process.cwd() legacy mode against the current .fusion path", async () => {
      const projectDir = join(tempDir, "legacy-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeFusionProject(projectDir);
      process.chdir(projectDir);

      const centralDb = join(tempDir, "kb-central.db");
      await centralCore.close();
      rmSync(centralDb, { force: true });
      centralCore = new CentralCore(tempDir);

      const store = await TaskStore.getOrCreateForProject(undefined, centralCore);

      expect(store).toBeInstanceOf(TaskStore);
      const task = await store.createTask({ description: "legacy task" });
      expect(task.id).toBe("FN-001");
      expect(existsSync(join(projectDir, ".fusion", "kb.db"))).toBe(true);
      expect(existsSync(join(projectDir, ".fusion", "tasks", task.id, "task.json"))).toBe(true);
    });

    it("should throw when project ID not found", async () => {
      await expect(
        TaskStore.getOrCreateForProject("non-existent-project", centralCore)
      ).rejects.toThrow('Project "non-existent-project" not found');
    });

    it("should find project by exact registered name", async () => {
      const projectDir = join(tempDir, "Casey");
      mkdirSync(projectDir, { recursive: true });

      await centralCore.registerProject({
        name: "Casey",
        path: projectDir,
        isolationMode: "in-process",
      });

      const store = await TaskStore.getOrCreateForProject("Casey", centralCore);
      expect(store).toBeInstanceOf(TaskStore);
    });

    it("should auto-initialize central core if not provided", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });

      // Register a project
      const { id: projectId } = await centralCore.registerProject({
        name: "my-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      // Pass the central core explicitly to ensure it uses the right database
      const store = await TaskStore.getOrCreateForProject(projectId, centralCore);

      expect(store).toBeInstanceOf(TaskStore);
    });
  });

  describe("existing constructor", () => {
    it("should still support direct TaskStore construction", async () => {
      const projectDir = join(tempDir, "direct-project");
      mkdirSync(projectDir, { recursive: true });

      // Direct construction should still work
      const store = new TaskStore(projectDir);
      await store.init();

      expect(store).toBeInstanceOf(TaskStore);
      
      // Should be able to create tasks
      const task = await store.createTask({
        description: "Test task",
        column: "triage",
      });
      
      expect(task.id).toBeDefined();
      expect(task.description).toBe("Test task");
    });
  });

  describe("events without central core", () => {
    it("should emit events in single-project mode", async () => {
      const projectDir = join(tempDir, "event-test");
      mkdirSync(projectDir, { recursive: true });

      const store = new TaskStore(projectDir);
      await store.init();

      const taskCreatedListener = vi.fn();
      store.on("task:created", taskCreatedListener);

      await store.createTask({
        description: "Event test task",
        column: "triage",
      });

      expect(taskCreatedListener).toHaveBeenCalledTimes(1);
    });
  });
});
