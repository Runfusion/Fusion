import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../store.js";
import { CentralCore } from "../central-core.js";

// Helper to create a temp directory
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-compat-test-"));
}

// Helper to create a fake kb project structure
function createFakeKbProject(dir: string): void {
  mkdirSync(join(dir, ".kb"), { recursive: true });
  writeFileSync(join(dir, ".kb", "kb.db"), "");
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

    it("should find project by name when ID not found", async () => {
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


    it("should fall back to legacy mode when no projects registered", async () => {
      // No projects registered in central core
      process.chdir(tempDir);

      const store = await TaskStore.getOrCreateForProject(undefined, centralCore);

      expect(store).toBeInstanceOf(TaskStore);
    });

    it("should throw when project ID not found", async () => {
      await expect(
        TaskStore.getOrCreateForProject("non-existent-project", centralCore)
      ).rejects.toThrow('Project "non-existent-project" not found');
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
