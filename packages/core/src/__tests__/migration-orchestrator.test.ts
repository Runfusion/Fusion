import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { MigrationOrchestrator, createMigrationOrchestrator, MAX_AUTO_REGISTER_PROJECTS } from "../migration-orchestrator.js";
import { CentralCore } from "../central-core.js";

// Helper to create a temp directory
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-migration-test-"));
}

// Helper to create a fake kb project structure
function createFakeKbProject(dir: string): void {
  mkdirSync(join(dir, ".kb"), { recursive: true });
  // Create an empty file as the database (enough for detection)
  writeFileSync(join(dir, ".kb", "kb.db"), "");
}

describe("MigrationOrchestrator", () => {
  let tempDir: string;
  let centralCore: CentralCore;
  let orchestrator: MigrationOrchestrator;

  beforeEach(async () => {
    tempDir = createTempDir();
    centralCore = new CentralCore(tempDir);
    await centralCore.init();
    orchestrator = new MigrationOrchestrator(centralCore);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("detectExistingProjects", () => {
    it("should detect a single kb project", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const detected = await orchestrator.detectExistingProjects(projectDir);

      expect(detected).toHaveLength(1);
      expect(detected[0].path).toBe(projectDir);
      expect(detected[0].name).toBe("my-project");
      expect(detected[0].hasDb).toBe(true);
    });

    it("should detect multiple kb projects in subdirectories", async () => {
      const project1 = join(tempDir, "project-a");
      const project2 = join(tempDir, "project-b");
      mkdirSync(project1, { recursive: true });
      mkdirSync(project2, { recursive: true });
      createFakeKbProject(project1);
      createFakeKbProject(project2);

      const detected = await orchestrator.detectExistingProjects(tempDir);

      expect(detected).toHaveLength(2);
      expect(detected.map((p) => p.name).sort()).toEqual(["project-a", "project-b"]);
    });

    it("should skip node_modules directories", async () => {
      const projectDir = join(tempDir, "my-project");
      const nodeModules = join(projectDir, "node_modules", "some-package");
      mkdirSync(nodeModules, { recursive: true });
      createFakeKbProject(nodeModules);
      createFakeKbProject(projectDir);

      const detected = await orchestrator.detectExistingProjects(tempDir);

      // Should only find the main project, not the one in node_modules
      expect(detected).toHaveLength(1);
      expect(detected[0].name).toBe("my-project");
    });

    it("should skip hidden directories", async () => {
      const projectDir = join(tempDir, "my-project");
      const hiddenDir = join(tempDir, ".hidden-project");
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(hiddenDir, { recursive: true });
      createFakeKbProject(projectDir);
      createFakeKbProject(hiddenDir);

      const detected = await orchestrator.detectExistingProjects(tempDir);

      // Should not detect the hidden directory
      expect(detected).toHaveLength(1);
      expect(detected[0].name).toBe("my-project");
    });

    it("should skip build and cache directories", async () => {
      const projectDir = join(tempDir, "my-project");
      const distDir = join(tempDir, "dist", "some-project");
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      createFakeKbProject(projectDir);
      createFakeKbProject(distDir);

      const detected = await orchestrator.detectExistingProjects(tempDir);

      // Should not detect the one in dist
      expect(detected).toHaveLength(1);
      expect(detected[0].name).toBe("my-project");
    });

    it("should respect maxDepth parameter", async () => {
      // Create nested structure: temp/a/b/c/project
      const nested = join(tempDir, "a", "b", "c", "project");
      mkdirSync(nested, { recursive: true });
      createFakeKbProject(nested);

      // With maxDepth=2, should not find the project at depth 4
      const detected = await orchestrator.detectExistingProjects(tempDir, 2);

      expect(detected).toHaveLength(0);

      // With maxDepth=5, should find it
      const detectedDeep = await orchestrator.detectExistingProjects(tempDir, 5);
      expect(detectedDeep).toHaveLength(1);
    });

    it("should stop recursion at a project root (don't look inside projects)", async () => {
      const projectDir = join(tempDir, "my-project");
      const nestedProject = join(projectDir, "packages", "sub-project");
      mkdirSync(nestedProject, { recursive: true });
      createFakeKbProject(projectDir);
      createFakeKbProject(nestedProject);

      const detected = await orchestrator.detectExistingProjects(tempDir);

      // Should only detect the top-level project, not the nested one
      // (because we stop recursing when we find a project)
      expect(detected).toHaveLength(1);
      expect(detected[0].name).toBe("my-project");
    });

    it("should return empty array when no projects found", async () => {
      const detected = await orchestrator.detectExistingProjects(tempDir);

      expect(detected).toHaveLength(0);
    });

    it("should throw on non-existent path", async () => {
      await expect(
        orchestrator.detectExistingProjects("/non/existent/path")
      ).rejects.toThrow("Scan path does not exist");
    });

    it("should throw on relative path", async () => {
      // A path starting with './' is relative - after resolve() it becomes absolute
      // but we need to check before resolving
      await expect(
        orchestrator.detectExistingProjects("./relative/path")
      ).rejects.toThrow("Scan path must be absolute");
    });

    it("should detect projects without valid database as hasDb=false", async () => {
      const projectDir = join(tempDir, "incomplete-project");
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(projectDir, ".fusion"), { recursive: true });
      // Create directory but no kb.db file

      const detected = await orchestrator.detectExistingProjects(projectDir);

      expect(detected).toHaveLength(0);
    });
  });

  describe("autoRegisterProjects", () => {
    it("should register detected projects", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const detected = [{ path: projectDir, name: "my-project", hasDb: true }];
      const registered = await orchestrator.autoRegisterProjects(detected);

      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe("my-project");
      expect(registered[0].path).toBe(projectDir);
      expect(registered[0].isolationMode).toBe("in-process");
      expect(registered[0].status).toBe("active");
    });

    it("should skip projects without valid database", async () => {
      const validProject = join(tempDir, "valid");
      const invalidProject = join(tempDir, "invalid");
      mkdirSync(validProject, { recursive: true });
      mkdirSync(join(invalidProject, ".fusion"), { recursive: true });
      createFakeKbProject(validProject);

      const detected = [
        { path: validProject, name: "valid", hasDb: true },
        { path: invalidProject, name: "invalid", hasDb: false },
      ];

      const registered = await orchestrator.autoRegisterProjects(detected);

      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe("valid");
    });

    it("should skip already registered projects", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      // Register first
      await centralCore.registerProject({
        name: "my-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      // Try to register again
      const detected = [{ path: projectDir, name: "my-project", hasDb: true }];
      const registered = await orchestrator.autoRegisterProjects(detected);

      expect(registered).toHaveLength(0);
    });

    it("should generate unique names for duplicate basenames", async () => {
      const project1 = join(tempDir, "repos", "my-project");
      const project2 = join(tempDir, "other", "my-project");
      mkdirSync(project1, { recursive: true });
      mkdirSync(project2, { recursive: true });
      createFakeKbProject(project1);
      createFakeKbProject(project2);

      // Register first project directly
      await centralCore.registerProject({
        name: "my-project",
        path: project1,
        isolationMode: "in-process",
      });

      // Auto-register should use name-2 for second project
      const detected = [
        { path: project1, name: "my-project", hasDb: true },
        { path: project2, name: "my-project", hasDb: true },
      ];
      const registered = await orchestrator.autoRegisterProjects(detected);

      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe("my-project-2");
    });

    it("should skip projects that would create circular references", async () => {
      const parent = join(tempDir, "parent-project");
      const child = join(parent, "child-project");
      mkdirSync(parent, { recursive: true });
      mkdirSync(child, { recursive: true });
      createFakeKbProject(parent);
      createFakeKbProject(child);

      // Register parent first
      await centralCore.registerProject({
        name: "parent-project",
        path: parent,
        isolationMode: "in-process",
      });

      // Try to register child (should be skipped as circular)
      const detected = [
        { path: parent, name: "parent-project", hasDb: true },
        { path: child, name: "child-project", hasDb: true },
      ];
      const registered = await orchestrator.autoRegisterProjects(detected);

      expect(registered).toHaveLength(0); // Both skipped (parent already registered, child circular)
    });

    it("should throw when exceeding MAX_AUTO_REGISTER_PROJECTS", async () => {
      // Create too many projects
      const detected: Array<{ path: string; name: string; hasDb: boolean }> = [];
      for (let i = 0; i < MAX_AUTO_REGISTER_PROJECTS + 1; i++) {
        detected.push({ path: `/project/${i}`, name: `project-${i}`, hasDb: true });
      }

      await expect(orchestrator.autoRegisterProjects(detected)).rejects.toThrow(
        "Too many projects detected"
      );
    });
  });

  describe("needsMigration", () => {
    it("should return true when no projects registered and projects exist", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const needsMigration = await orchestrator.needsMigration(tempDir);

      expect(needsMigration).toBe(true);
    });

    it("should return false when projects already registered", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      await centralCore.registerProject({
        name: "my-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      const needsMigration = await orchestrator.needsMigration(tempDir);

      expect(needsMigration).toBe(false);
    });

    it("should return false when no projects exist on filesystem", async () => {
      // No projects created
      const needsMigration = await orchestrator.needsMigration(tempDir);

      expect(needsMigration).toBe(false);
    });
  });

  describe("runMigration", () => {
    it("should run full migration with autoRegister", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const result = await orchestrator.runMigration({ startPath: tempDir, autoRegister: true });

      expect(result.projectsDetected).toHaveLength(1);
      expect(result.projectsRegistered).toHaveLength(1);
      expect(result.projectsRegistered[0].name).toBe("my-project");
      expect(result.errors).toHaveLength(0);
    });

    it("should run detection only without autoRegister", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const result = await orchestrator.runMigration({ startPath: tempDir, autoRegister: false });

      expect(result.projectsDetected).toHaveLength(1);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.projectsSkipped).toHaveLength(1);
    });

    it("should support dry-run mode", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const result = await orchestrator.runMigration({ startPath: tempDir, dryRun: true });

      expect(result.projectsDetected).toHaveLength(1);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.projectsSkipped[0].reason).toContain("DRY RUN");
    });

    it("should call progress callback", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      const onProgress = vi.fn();
      await orchestrator.runMigration({ autoRegister: true, onProgress });

      expect(onProgress).toHaveBeenCalled();
    });

    it("should handle detection errors gracefully", async () => {
      // Pass a non-existent directory to cause an error
      const nonExistentPath = join(tempDir, "does-not-exist");

      const result = await orchestrator.runMigration({ startPath: nonExistentPath });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("Detection failed");
    });
  });

  describe("createMigrationOrchestrator", () => {
    it("should create an orchestrator instance", () => {
      const instance = createMigrationOrchestrator(centralCore);

      expect(instance).toBeInstanceOf(MigrationOrchestrator);
    });
  });
});
