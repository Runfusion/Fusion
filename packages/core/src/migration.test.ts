/**
 * Tests for migration and first-run detection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FirstRunDetector,
  MigrationCoordinator,
  BackwardCompat,
  ProjectRequiredError,
  type ProjectSetupInput,
} from "./migration.js";
import { needsCentralMigration, autoMigrateToCentral, detectExistingProjects as detectExistingProjectsFromDbMigrate } from "./db-migrate.js";
import { CentralCore } from "./central-core.js";

// Helper to create temp directories
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Helper to create a fake kb project
function createFakeKbProject(dir: string): void {
  const kbDir = join(dir, ".kb");
  mkdirSync(kbDir, { recursive: true });
  // Create empty kb.db file (SQLite needs actual format, but for detection an empty file works)
  writeFileSync(join(kbDir, "kb.db"), "SQLite format 3\x00");
}

// Helper to create a fake git remote
async function initGitRepo(dir: string, remoteUrl?: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });

  if (remoteUrl) {
    await execFileAsync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  }
}

describe("FirstRunDetector", () => {
  let tempGlobalDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempGlobalDir = tempDir("kb-migration-test-");
    originalCwd = process.cwd();
  });

  afterEach(() => {
    // Cleanup
    try {
      rmSync(tempGlobalDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    process.chdir(originalCwd);
  });

  describe("detectFirstRunState", () => {
    it("should detect fresh-install when no central DB and no local .kb/", async () => {
      const tempProjectDir = tempDir("kb-fresh-");
      process.chdir(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("fresh-install");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should detect needs-migration when local .kb/ exists but no central DB", async () => {
      const tempProjectDir = tempDir("kb-needs-migration-");
      createFakeKbProject(tempProjectDir);
      process.chdir(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("needs-migration");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should detect needs-migration from nested directory inside an existing project", async () => {
      const tempProjectDir = tempDir("kb-needs-migration-nested-");
      createFakeKbProject(tempProjectDir);
      const nestedDir = join(tempProjectDir, "src", "features", "deep");
      mkdirSync(nestedDir, { recursive: true });
      process.chdir(nestedDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("needs-migration");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should detect setup-wizard when central DB exists but is empty", async () => {
      // Initialize central DB with no projects
      const central = new CentralCore(tempGlobalDir);
      await central.init();
      await central.close();

      const tempProjectDir = tempDir("kb-setup-wizard-");
      process.chdir(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("setup-wizard");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should detect normal-operation when central DB has projects", async () => {
      // Create a separate global dir for this test to avoid conflicts with beforeEach's tempGlobalDir
      const testGlobalDir = tempDir("kb-normal-op-global-");
      
      // Create and initialize central
      const testCentral = new CentralCore(testGlobalDir);
      await testCentral.init();
      
      // Register a project
      const projectDir = tempDir("kb-test-project-");
      await testCentral.registerProject({
        name: "Test Project",
        path: projectDir,
      });

      // Create a temp dir for the cwd
      const tempProjectDir = tempDir("kb-normal-op-");
      process.chdir(tempProjectDir);

      // Pass existing central to avoid concurrent connection issues
      const detector = new FirstRunDetector(testGlobalDir);
      const state = await detector.detectFirstRunState(testCentral);

      expect(state).toBe("normal-operation");

      // Cleanup
      await testCentral.close();
      rmSync(tempProjectDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(testGlobalDir, { recursive: true, force: true });
    });

    it("should fall back to needs-migration when central DB exists but is unreadable", async () => {
      const tempProjectDir = tempDir("kb-corrupt-central-");
      createFakeKbProject(tempProjectDir);
      process.chdir(tempProjectDir);

      mkdirSync(tempGlobalDir, { recursive: true });
      writeFileSync(join(tempGlobalDir, "kb-central.db"), "not a sqlite database");

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("needs-migration");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should return fresh-install when central DB exists but is unreadable and no local project is found", async () => {
      const tempProjectDir = tempDir("kb-corrupt-central-no-local-");
      process.chdir(tempProjectDir);

      mkdirSync(tempGlobalDir, { recursive: true });
      writeFileSync(join(tempGlobalDir, "kb-central.db"), "not a sqlite database");

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("fresh-install");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });

  describe("hasCentralDb", () => {
    it("should return false when central DB does not exist", () => {
      const detector = new FirstRunDetector(tempGlobalDir);
      expect(detector.hasCentralDb()).toBe(false);
    });

    it("should return true when central DB exists", async () => {
      const central = new CentralCore(tempGlobalDir);
      await central.init();
      await central.close();

      const detector = new FirstRunDetector(tempGlobalDir);
      expect(detector.hasCentralDb()).toBe(true);
    });
  });

  describe("detectExistingProjects", () => {
    it("should detect project in cwd", async () => {
      const tempProjectDir = tempDir("kb-detect-");
      createFakeKbProject(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(tempProjectDir);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(tempProjectDir);
      expect(projects[0].hasDb).toBe(true);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should walk up directory tree to find .kb/", async () => {
      const tempProjectDir = tempDir("kb-parent-");
      createFakeKbProject(tempProjectDir);
      const nestedDir = join(tempProjectDir, "src", "components");
      mkdirSync(nestedDir, { recursive: true });

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(nestedDir);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(tempProjectDir);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should stop safely at home/root boundaries when no project is found", async () => {
      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(tmpdir());

      expect(Array.isArray(projects)).toBe(true);
      expect(projects.length).toBe(0);
    });

    it("should still check the starting directory when cwd matches the stop boundary", async () => {
      const fakeHome = tempDir("kb-home-boundary-");
      createFakeKbProject(fakeHome);

      const detector = new FirstRunDetector(fakeHome);
      const projects = await detector.detectExistingProjects(fakeHome);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(fakeHome);

      rmSync(fakeHome, { recursive: true, force: true });
    });

    it("should return empty array when no project found", async () => {
      const emptyDir = tempDir("kb-empty-");

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(emptyDir);

      expect(projects).toHaveLength(0);

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe("generateProjectName", () => {
    it("should use directory basename when no git remote", async () => {
      const tempProjectDir = tempDir("my-awesome-project-");

      const detector = new FirstRunDetector(tempGlobalDir);
      const name = await detector.generateProjectName(tempProjectDir);

      expect(name).toContain("my-awesome-project");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should extract repo name from HTTPS git remote", async () => {
      const tempProjectDir = tempDir("kb-git-https-");
      await initGitRepo(tempProjectDir, "https://github.com/owner/my-repo.git");

      const detector = new FirstRunDetector(tempGlobalDir);
      const name = await detector.generateProjectName(tempProjectDir);

      expect(name).toBe("my-repo");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should extract repo name from SSH git remote", async () => {
      const tempProjectDir = tempDir("kb-git-ssh-");
      await initGitRepo(tempProjectDir, "git@github.com:owner/my-ssh-repo");

      const detector = new FirstRunDetector(tempGlobalDir);
      const name = await detector.generateProjectName(tempProjectDir);

      expect(name).toBe("my-ssh-repo");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });

  describe("getCentralDbPath", () => {
    it("should return correct path", () => {
      const detector = new FirstRunDetector(tempGlobalDir);
      expect(detector.getCentralDbPath()).toBe(join(tempGlobalDir, "kb-central.db"));
    });
  });
});

describe("db-migrate wrappers", () => {
  it("should forward detectExistingProjects through db-migrate wrapper", async () => {
    const tempGlobalDir = tempDir("kb-dbmigrate-detect-global-");
    const tempProjectDir = tempDir("kb-dbmigrate-detect-project-");
    createFakeKbProject(tempProjectDir);
    const nestedDir = join(tempProjectDir, "src", "nested");
    mkdirSync(nestedDir, { recursive: true });

    const detected = await detectExistingProjectsFromDbMigrate(nestedDir, tempGlobalDir);

    expect(detected).toHaveLength(1);
    expect(detected[0].path).toBe(tempProjectDir);

    rmSync(tempGlobalDir, { recursive: true, force: true });
    rmSync(tempProjectDir, { recursive: true, force: true });
  });

  it("should autoMigrateToCentral and register the project", async () => {
    const tempGlobalDir = tempDir("kb-dbmigrate-auto-global-");
    const tempProjectDir = tempDir("kb-dbmigrate-auto-project-");
    createFakeKbProject(tempProjectDir);

    const central = new CentralCore(tempGlobalDir);
    await central.init();

    try {
      const result = await autoMigrateToCentral(tempProjectDir, central);
      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(1);

      const project = await central.getProject(result.projectsRegistered[0]);
      expect(project).toBeDefined();
      expect(project!.path).toBe(tempProjectDir);
      expect(project!.status).toBe("active");
    } finally {
      await central.close();
      rmSync(tempGlobalDir, { recursive: true, force: true });
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });

  it("should autoMigrateToCentral idempotently on repeat runs", async () => {
    const tempGlobalDir = tempDir("kb-dbmigrate-idempotent-global-");
    const tempProjectDir = tempDir("kb-dbmigrate-idempotent-project-");
    createFakeKbProject(tempProjectDir);

    const central = new CentralCore(tempGlobalDir);
    await central.init();

    try {
      const result1 = await autoMigrateToCentral(tempProjectDir, central);
      const result2 = await autoMigrateToCentral(tempProjectDir, central);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.projectsRegistered[0]).toBe(result2.projectsRegistered[0]);
    } finally {
      await central.close();
      rmSync(tempGlobalDir, { recursive: true, force: true });
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });
});

describe("needsCentralMigration", () => {
  it("should detect migration need from nested directory inside a project", () => {
    const tempGlobalDir = tempDir("kb-needs-central-global-");
    const tempProjectDir = tempDir("kb-needs-central-project-");
    createFakeKbProject(tempProjectDir);
    const nestedDir = join(tempProjectDir, "src", "nested");
    mkdirSync(nestedDir, { recursive: true });

    expect(needsCentralMigration(nestedDir, tempGlobalDir)).toBe(true);

    rmSync(tempGlobalDir, { recursive: true, force: true });
    rmSync(tempProjectDir, { recursive: true, force: true });
  });

  it("should detect migration need from the project root itself", () => {
    const tempGlobalDir = tempDir("kb-needs-central-root-global-");
    const tempProjectDir = tempDir("kb-needs-central-root-project-");
    createFakeKbProject(tempProjectDir);

    expect(needsCentralMigration(tempProjectDir, tempGlobalDir)).toBe(true);

    rmSync(tempGlobalDir, { recursive: true, force: true });
    rmSync(tempProjectDir, { recursive: true, force: true });
  });
});

describe("MigrationCoordinator", () => {
  let tempGlobalDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    tempGlobalDir = tempDir("kb-coordinator-test-");
    central = new CentralCore(tempGlobalDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
    try {
      rmSync(tempGlobalDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("registerSingleProject", () => {
    it("should register a new project successfully", async () => {
      const tempProjectDir = tempDir("kb-register-");
      createFakeKbProject(tempProjectDir);

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.registerSingleProject(tempProjectDir);

      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      // Verify project was registered
      const project = await central.getProject(result.projectsRegistered[0]);
      expect(project).toBeDefined();
      expect(project!.path).toBe(tempProjectDir);
      expect(project!.status).toBe("active");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should be idempotent - return existing project if already registered", async () => {
      const tempProjectDir = tempDir("kb-idempotent-");
      createFakeKbProject(tempProjectDir);

      const coordinator = new MigrationCoordinator(central);

      // First registration
      const result1 = await coordinator.registerSingleProject(tempProjectDir);
      expect(result1.success).toBe(true);

      // Second registration - should be idempotent
      const result2 = await coordinator.registerSingleProject(tempProjectDir);
      expect(result2.success).toBe(true);
      expect(result2.projectsRegistered).toEqual(result1.projectsRegistered);
      expect(result2.errors).toHaveLength(0);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should reject relative paths", async () => {
      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.registerSingleProject("./relative/path");

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("must be absolute");
    });

    it("should reject absolute paths that are not valid kb projects", async () => {
      const tempProjectDir = tempDir("kb-invalid-project-");

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.registerSingleProject(tempProjectDir);

      expect(result.success).toBe(false);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.errors[0]).toContain("not a valid kb project");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should handle duplicate names by appending suffix", async () => {
      const tempRoot = tempDir("kb-duplicate-names-");
      const tempProjectDir1 = join(tempRoot, "same-project");
      const tempProjectDir2 = join(tempRoot, "group", "same-project");
      mkdirSync(tempProjectDir1, { recursive: true });
      mkdirSync(tempProjectDir2, { recursive: true });
      createFakeKbProject(tempProjectDir1);
      createFakeKbProject(tempProjectDir2);

      const coordinator = new MigrationCoordinator(central);
      const result1 = await coordinator.registerSingleProject(tempProjectDir1);
      const result2 = await coordinator.registerSingleProject(tempProjectDir2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      const project1 = await central.getProject(result1.projectsRegistered[0]);
      const project2 = await central.getProject(result2.projectsRegistered[0]);
      expect(project1!.name).toBe("same-project");
      expect(project2!.name).toBe("same-project-1");

      rmSync(tempRoot, { recursive: true, force: true });
    });

    it("should reject nested project registration when parent is already registered", async () => {
      const parentProjectDir = tempDir("kb-parent-project-");
      createFakeKbProject(parentProjectDir);
      const nestedProjectDir = join(parentProjectDir, "apps", "nested-project");
      mkdirSync(nestedProjectDir, { recursive: true });
      createFakeKbProject(nestedProjectDir);

      const coordinator = new MigrationCoordinator(central);
      const parentResult = await coordinator.registerSingleProject(parentProjectDir);
      const nestedResult = await coordinator.registerSingleProject(nestedProjectDir);

      expect(parentResult.success).toBe(true);
      expect(nestedResult.success).toBe(false);
      expect(nestedResult.errors[0]).toContain("overlaps an existing registered project");

      rmSync(parentProjectDir, { recursive: true, force: true });
    });

    it("should register the detected ancestor project root when called from a nested directory", async () => {
      const tempProjectDir = tempDir("kb-nested-register-");
      createFakeKbProject(tempProjectDir);
      const nestedDir = join(tempProjectDir, "packages", "feature");
      mkdirSync(nestedDir, { recursive: true });

      const detector = new FirstRunDetector(tempGlobalDir);
      const detected = await detector.detectExistingProjects(nestedDir);
      expect(detected).toHaveLength(1);

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.registerSingleProject(detected[0].path);

      expect(result.success).toBe(true);
      const projects = await central.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].path.endsWith(tempProjectDir)).toBe(true);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });

  describe("completeSetup", () => {
    it("should register multiple projects from wizard", async () => {
      const tempProjectDir1 = tempDir("kb-setup1-");
      const tempProjectDir2 = tempDir("kb-setup2-");
      createFakeKbProject(tempProjectDir1);
      createFakeKbProject(tempProjectDir2);

      const coordinator = new MigrationCoordinator(central);
      const inputs: ProjectSetupInput[] = [
        { path: tempProjectDir1, name: "Project One" },
        { path: tempProjectDir2, name: "Project Two" },
      ];

      const result = await coordinator.completeSetup(inputs);

      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(2);
      expect(result.errors).toHaveLength(0);

      rmSync(tempProjectDir1, { recursive: true, force: true });
      rmSync(tempProjectDir2, { recursive: true, force: true });
    });

    it("should skip already registered projects", async () => {
      const tempProjectDir = tempDir("kb-setup-existing-");
      createFakeKbProject(tempProjectDir);

      const coordinator = new MigrationCoordinator(central);

      // Register first
      const result1 = await coordinator.registerSingleProject(tempProjectDir);

      // Try to register again via completeSetup
      const inputs: ProjectSetupInput[] = [{ path: tempProjectDir, name: "Some Name" }];
      const result2 = await coordinator.completeSetup(inputs);

      expect(result2.success).toBe(true);
      expect(result2.projectsRegistered).toEqual(result1.projectsRegistered);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should reject invalid setup project paths", async () => {
      const validProjectDir = tempDir("kb-setup-valid-");
      const invalidProjectDir = tempDir("kb-setup-invalid-");
      createFakeKbProject(validProjectDir);

      const inputs: ProjectSetupInput[] = [
        { path: validProjectDir, name: "Valid Project" },
        { path: invalidProjectDir, name: "Invalid Project" },
      ];

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.completeSetup(inputs);

      expect(result.success).toBe(false);
      expect(result.projectsRegistered).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("not a valid kb project");

      rmSync(validProjectDir, { recursive: true, force: true });
      rmSync(invalidProjectDir, { recursive: true, force: true });
    });
  });

  describe("coordinateMigration", () => {
    it("should auto-register an existing local project when no projects are registered", async () => {
      const tempProjectDir = tempDir("kb-coordinate-migration-");
      createFakeKbProject(tempProjectDir);
      const nestedDir = join(tempProjectDir, "src", "feature");
      mkdirSync(nestedDir, { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(nestedDir);

      try {
        const coordinator = new MigrationCoordinator(central);
        const result = await coordinator.coordinateMigration();

        expect(result.success).toBe(true);
        expect(result.projectsRegistered).toHaveLength(1);
        expect(result.errors).toHaveLength(0);

        const registered = await central.listProjects();
        expect(registered).toHaveLength(1);
        expect(registered[0].path.endsWith(tempProjectDir)).toBe(true);
      } finally {
        process.chdir(originalCwd);
        rmSync(tempProjectDir, { recursive: true, force: true });
      }
    });

    it("should return success for fresh-install state", async () => {
      // Close and remove central to simulate fresh state
      await central.close();
      rmSync(join(tempGlobalDir, "kb-central.db"), { force: true });

      // Create fresh temp dir with no .kb/
      const tempFreshDir = tempDir("kb-fresh-coord-");

      central = new CentralCore(tempGlobalDir);
      await central.init();

      // Change to fresh dir (no .kb/)
      const originalCwd = process.cwd();
      process.chdir(tempFreshDir);

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.coordinateMigration();

      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.errors).toHaveLength(0);

      process.chdir(originalCwd);
      rmSync(tempFreshDir, { recursive: true, force: true });
    });

    it("should be a no-op in setup-wizard state when no local project exists", async () => {
      const tempFreshDir = tempDir("kb-setup-wizard-coord-");
      const originalCwd = process.cwd();
      process.chdir(tempFreshDir);

      try {
        const coordinator = new MigrationCoordinator(central);
        const result = await coordinator.coordinateMigration();

        expect(result.success).toBe(true);
        expect(result.projectsRegistered).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
      } finally {
        process.chdir(originalCwd);
        rmSync(tempFreshDir, { recursive: true, force: true });
      }
    });

    it("should be a no-op in normal-operation when projects already exist", async () => {
      const existingProjectDir = tempDir("kb-normal-op-existing-");
      await central.registerProject({
        name: "Existing Project",
        path: existingProjectDir,
      });

      const localProjectDir = tempDir("kb-normal-op-local-");
      createFakeKbProject(localProjectDir);
      const originalCwd = process.cwd();
      process.chdir(localProjectDir);

      try {
        const coordinator = new MigrationCoordinator(central);
        const result = await coordinator.coordinateMigration();

        expect(result.success).toBe(true);
        expect(result.projectsRegistered).toHaveLength(0);
        expect(result.errors).toHaveLength(0);

        const registered = await central.listProjects();
        expect(registered).toHaveLength(1);
      } finally {
        process.chdir(originalCwd);
        rmSync(existingProjectDir, { recursive: true, force: true });
        rmSync(localProjectDir, { recursive: true, force: true });
      }
    });
  });
});

describe("BackwardCompat", () => {
  let tempGlobalDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    tempGlobalDir = tempDir("kb-compat-test-");
    central = new CentralCore(tempGlobalDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
    try {
      rmSync(tempGlobalDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("resolveProjectContext", () => {
    it("should use explicit project ID when provided", async () => {
      const tempProjectDir = tempDir("kb-explicit-");
      const project = await central.registerProject({
        name: "Explicit Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/other/dir", project.id);

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);
      expect(context.isLegacy).toBe(false);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should auto-use single project when no explicit ID provided", async () => {
      const tempProjectDir = tempDir("kb-single-");
      const project = await central.registerProject({
        name: "Single Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/other/dir");

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);
      expect(context.isLegacy).toBe(false);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should throw ProjectRequiredError when multiple projects and no selection", async () => {
      const tempProjectDir1 = tempDir("kb-multi1-");
      const tempProjectDir2 = tempDir("kb-multi2-");
      await central.registerProject({ name: "Project 1", path: tempProjectDir1 });
      await central.registerProject({ name: "Project 2", path: tempProjectDir2 });

      const compat = new BackwardCompat(central);

      await expect(compat.resolveProjectContext("/some/dir")).rejects.toThrow(
        ProjectRequiredError
      );

      try {
        await compat.resolveProjectContext("/some/dir");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectRequiredError);
        expect((err as ProjectRequiredError).availableProjects).toHaveLength(2);
      }

      rmSync(tempProjectDir1, { recursive: true, force: true });
      rmSync(tempProjectDir2, { recursive: true, force: true });
    });

    it("should find project by name (case-insensitive)", async () => {
      const tempProjectDir = tempDir("kb-byname-");
      const project = await central.registerProject({
        name: "My Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/dir", "my project");

      expect(context.projectId).toBe(project.id);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should throw when project not found", async () => {
      const compat = new BackwardCompat(central);

      await expect(compat.resolveProjectContext("/some/dir", "nonexistent")).rejects.toThrow(
        ProjectRequiredError
      );
    });
  });

  describe("isLegacyMode", () => {
    it("should return false when central DB exists", async () => {
      const compat = new BackwardCompat(central);
      expect(await compat.isLegacyMode()).toBe(false);
    });

    it("should return true when no central DB", async () => {
      // Close and remove central DB
      await central.close();
      rmSync(join(tempGlobalDir, "kb-central.db"), { force: true });

      // Need to re-init CentralCore for it to work
      central = new CentralCore(tempGlobalDir);

      const compat = new BackwardCompat(central);
      expect(await compat.isLegacyMode()).toBe(true);
    });
  });
});

describe("CentralCore migration helpers", () => {
  let tempGlobalDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    tempGlobalDir = tempDir("kb-central-migration-test-");
    central = new CentralCore(tempGlobalDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
    try {
      rmSync(tempGlobalDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("autoRegisterProject", () => {
    it("should auto-register a project with generated name", async () => {
      const tempProjectDir = tempDir("kb-autoreg-");
      createFakeKbProject(tempProjectDir);

      const project = await central.autoRegisterProject(tempProjectDir);

      expect(project).toBeDefined();
      expect(project.path).toBe(tempProjectDir);
      expect(project.isolationMode).toBe("in-process");
      expect(project.status).toBe("active");
      expect(project.name).toContain("kb-autoreg"); // Based on directory name

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should reject nested auto-registration when parent project is already registered", async () => {
      const parentProjectDir = tempDir("kb-central-parent-");
      createFakeKbProject(parentProjectDir);
      const nestedProjectDir = join(parentProjectDir, "packages", "nested");
      mkdirSync(nestedProjectDir, { recursive: true });
      createFakeKbProject(nestedProjectDir);

      await central.autoRegisterProject(parentProjectDir);

      await expect(central.autoRegisterProject(nestedProjectDir)).rejects.toThrow(/overlaps an existing registered project/);

      rmSync(parentProjectDir, { recursive: true, force: true });
    });

    it("should be idempotent - return existing project if already registered", async () => {
      const tempProjectDir = tempDir("kb-autoreg-dup-");
      createFakeKbProject(tempProjectDir);

      const project1 = await central.autoRegisterProject(tempProjectDir);
      const project2 = await central.autoRegisterProject(tempProjectDir);

      expect(project1.id).toBe(project2.id);
      expect(project1.name).toBe(project2.name);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });

  describe("isProjectRegistered", () => {
    it("should return false for unregistered project", async () => {
      const tempProjectDir = tempDir("kb-unreg-");

      const isRegistered = await central.isProjectRegistered(tempProjectDir);

      expect(isRegistered).toBe(false);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should return true for registered project", async () => {
      const tempProjectDir = tempDir("kb-registered-");
      await central.registerProject({
        name: "Registered",
        path: tempProjectDir,
      });

      const isRegistered = await central.isProjectRegistered(tempProjectDir);

      expect(isRegistered).toBe(true);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });

  describe("getFirstRunState", () => {
    it("should return setup-wizard when no projects", async () => {
      const state = await central.getFirstRunState();
      expect(state).toBe("setup-wizard");
    });

    it("should return normal-operation when projects exist", async () => {
      const tempProjectDir = tempDir("kb-state-test-");
      await central.registerProject({
        name: "State Test",
        path: tempProjectDir,
      });

      const state = await central.getFirstRunState();

      expect(state).toBe("normal-operation");

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });
});

describe("ProjectRequiredError", () => {
  it("should include available projects in error", () => {
    const available = [
      { id: "proj_1", name: "Project One" },
      { id: "proj_2", name: "Project Two" },
    ];

    const error = new ProjectRequiredError("Test message", available);

    expect(error.message).toBe("Test message");
    expect(error.name).toBe("ProjectRequiredError");
    expect(error.availableProjects).toEqual(available);
  });
});
