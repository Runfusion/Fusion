/**
 * Tests for migration and first-run detection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempWorkspace, useIsolatedCwd } from "@fusion/test-utils";
import {
  FirstRunDetector,
  MigrationCoordinator,
  BackwardCompat,
  ProjectRequiredError,
  type ProjectSetupInput,
} from "../migration.js";
import { CentralCore } from "../central-core.js";

// Helper to create a fake kb project
function createFakeKbProject(dir: string): void {
  const kbDir = join(dir, ".fusion");
  mkdirSync(kbDir, { recursive: true });
  // A zero-byte file is a valid SQLite bootstrap database.
  writeFileSync(join(kbDir, "fusion.db"), "");
}

function createInvalidKbProject(dir: string): void {
  const kbDir = join(dir, ".fusion");
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, "fusion.db"), "SQLite format 3\x00");
}

async function withDefaultFirstRunDetector<T>(
  homeDir: string,
  fn: (detector: FirstRunDetector) => Promise<T> | T,
): Promise<T> {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const savedVitest = process.env.VITEST;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.VITEST;

  try {
    return await fn(new FirstRunDetector());
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    if (savedVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = savedVitest;
    }
  }
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

  beforeEach(() => {
    tempGlobalDir = tempWorkspace("kb-migration-test-");
  });

  describe("detectFirstRunState", () => {
    it("should detect fresh-install when no central DB and no local .fusion/", async () => {
      useIsolatedCwd("kb-fresh-");

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("fresh-install");
    });

    it("should detect setup-wizard when local .fusion/ exists but no central DB", async () => {
      const tempProjectDir = useIsolatedCwd("kb-needs-migration-");
      createFakeKbProject(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("setup-wizard");
    });

    it("should detect setup-wizard from nested directory inside an existing project with no central DB", async () => {
      const tempProjectDir = tempWorkspace("kb-needs-migration-nested-");
      createFakeKbProject(tempProjectDir);
      const nestedDir = join(tempProjectDir, "src", "features", "deep");
      mkdirSync(nestedDir, { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(nestedDir);

      try {
        const detector = new FirstRunDetector(tempGlobalDir);
        const state = await detector.detectFirstRunState();

        expect(state).toBe("setup-wizard");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("should detect setup-wizard when central DB exists but is empty", async () => {
      // Initialize central DB with no projects
      const central = new CentralCore(tempGlobalDir);
      await central.init();
      await central.close();

      useIsolatedCwd("kb-setup-wizard-");

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("setup-wizard");
    });

    it("should detect normal-operation when central DB has projects", async () => {
      // Create a separate global dir for this test to avoid conflicts with beforeEach's tempGlobalDir
      const testGlobalDir = tempWorkspace("kb-normal-op-global-");

      // Create and initialize central
      const testCentral = new CentralCore(testGlobalDir);
      await testCentral.init();

      // Register a project
      const projectDir = tempWorkspace("kb-test-project-");
      await testCentral.registerProject({
        name: "Test Project",
        path: projectDir,
      });

      // Create a temp dir for the cwd
      useIsolatedCwd("kb-normal-op-");

      try {
        // Pass existing central to avoid concurrent connection issues
        const detector = new FirstRunDetector(testGlobalDir);
        const state = await detector.detectFirstRunState(testCentral);

        expect(state).toBe("normal-operation");
      } finally {
        await testCentral.close();
      }
    }, 15_000);

    it("should return fresh-install when central DB exists but is unreadable", async () => {
      const tempProjectDir = useIsolatedCwd("kb-corrupt-central-");
      createFakeKbProject(tempProjectDir);

      mkdirSync(tempGlobalDir, { recursive: true });
      writeFileSync(join(tempGlobalDir, "fusion-central.db"), "not a sqlite database");

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("fresh-install");
    });

    it("should return fresh-install when central DB exists but is unreadable and no local project is found", async () => {
      useIsolatedCwd("kb-corrupt-central-no-local-");

      mkdirSync(tempGlobalDir, { recursive: true });
      writeFileSync(join(tempGlobalDir, "fusion-central.db"), "not a sqlite database");

      const detector = new FirstRunDetector(tempGlobalDir);
      const state = await detector.detectFirstRunState();

      expect(state).toBe("fresh-install");
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
      const tempProjectDir = tempWorkspace("kb-detect-");
      createFakeKbProject(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(tempProjectDir);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(tempProjectDir);
      expect(projects[0].hasDb).toBe(true);
    });

    it("should walk up directory tree to find .fusion/", async () => {
      const tempProjectDir = tempWorkspace("kb-parent-");
      createFakeKbProject(tempProjectDir);
      const nestedDir = join(tempProjectDir, "src", "components");
      mkdirSync(nestedDir, { recursive: true });

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(nestedDir);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(tempProjectDir);
    });

    it("should stop safely at home/root boundaries when no project is found", async () => {
      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(tmpdir());

      expect(Array.isArray(projects)).toBe(true);
      expect(projects.length).toBe(0);
    });

    it("should still check the starting directory when cwd matches the stop boundary", async () => {
      const fakeHome = tempWorkspace("kb-home-boundary-");
      createFakeKbProject(fakeHome);

      const detector = new FirstRunDetector(fakeHome);
      const projects = await detector.detectExistingProjects(fakeHome);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(fakeHome);
    });

    it("should return empty array when no project found", async () => {
      const emptyDir = tempWorkspace("kb-empty-");

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(emptyDir);

      expect(projects).toHaveLength(0);
    });

    it("should ignore invalid fusion.db files when scanning for local projects", async () => {
      const tempProjectDir = tempWorkspace("kb-invalid-detect-");
      createInvalidKbProject(tempProjectDir);

      const detector = new FirstRunDetector(tempGlobalDir);
      const projects = await detector.detectExistingProjects(tempProjectDir);

      expect(projects).toHaveLength(0);
    });
  });

  describe("generateProjectName", () => {
    it("should use directory basename when no git remote", async () => {
      const tempProjectDir = tempWorkspace("my-awesome-project-");

      const detector = new FirstRunDetector(tempGlobalDir);
      const name = await detector.generateProjectName(tempProjectDir);

      expect(name).toContain("my-awesome-project");
    });

    it("should extract repo name from HTTPS git remote", async () => {
      const tempProjectDir = tempWorkspace("kb-git-https-");
      await initGitRepo(tempProjectDir, "https://github.com/owner/my-repo.git");

      const detector = new FirstRunDetector(tempGlobalDir);
      const name = await detector.generateProjectName(tempProjectDir);

      expect(name).toBe("my-repo");
    });

    it("should extract repo name from SSH git remote", async () => {
      const tempProjectDir = tempWorkspace("kb-git-ssh-");
      await initGitRepo(tempProjectDir, "git@github.com:owner/my-ssh-repo");

      const detector = new FirstRunDetector(tempGlobalDir);
      const name = await detector.generateProjectName(tempProjectDir);

      expect(name).toBe("my-ssh-repo");
    });
  });

  describe("getCentralDbPath", () => {
    it("should return correct path", () => {
      const detector = new FirstRunDetector(tempGlobalDir);
      expect(detector.getCentralDbPath()).toBe(join(tempGlobalDir, "fusion-central.db"));
    });

    it("should default to ~/.fusion when no explicit global dir is provided", async () => {
      const homeDir = tempWorkspace("kb-default-global-dir-");

      try {
        await withDefaultFirstRunDetector(homeDir, (detector) => {
          expect(detector.getCentralDbPath()).toBe(join(homeDir, ".fusion", "fusion-central.db"));
        });
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });
});

describe("MigrationCoordinator", () => {
  let tempGlobalDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    tempGlobalDir = tempWorkspace("kb-coordinator-test-");
    central = new CentralCore(tempGlobalDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
  });

  describe("registerSingleProject", () => {
    it("should register a new project successfully", async () => {
      const tempProjectDir = tempWorkspace("kb-register-");
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
    });

    it("should be idempotent - return existing project if already registered", async () => {
      const tempProjectDir = tempWorkspace("kb-idempotent-");
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
    });

    it("should reject relative paths", async () => {
      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.registerSingleProject("./relative/path");

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("must be absolute");
    });

    it("should reject absolute paths that are not valid kb projects", async () => {
      const tempProjectDir = tempWorkspace("kb-invalid-project-");

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.registerSingleProject(tempProjectDir);

      expect(result.success).toBe(false);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.errors[0]).toContain("not a valid kb project");
    });

    it("should handle duplicate names by appending suffix", async () => {
      const tempRoot = tempWorkspace("kb-duplicate-names-");
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
    });

    it("should reject nested project registration when parent is already registered", async () => {
      const parentProjectDir = tempWorkspace("kb-parent-project-");
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
    });

    it("should register the detected ancestor project root when called from a nested directory", async () => {
      const tempProjectDir = tempWorkspace("kb-nested-register-");
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
    });
  });

  describe("completeSetup", () => {
    it("should register multiple projects from wizard", async () => {
      const tempProjectDir1 = tempWorkspace("kb-setup1-");
      const tempProjectDir2 = tempWorkspace("kb-setup2-");
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
    });

    it("should skip already registered projects", async () => {
      const tempProjectDir = tempWorkspace("kb-setup-existing-");
      createFakeKbProject(tempProjectDir);

      const coordinator = new MigrationCoordinator(central);

      // Register first
      const result1 = await coordinator.registerSingleProject(tempProjectDir);

      // Try to register again via completeSetup
      const inputs: ProjectSetupInput[] = [{ path: tempProjectDir, name: "Some Name" }];
      const result2 = await coordinator.completeSetup(inputs);

      expect(result2.success).toBe(true);
      expect(result2.projectsRegistered).toEqual(result1.projectsRegistered);
    });

    it("should reject invalid setup project paths", async () => {
      const validProjectDir = tempWorkspace("kb-setup-valid-");
      const invalidProjectDir = tempWorkspace("kb-setup-invalid-");
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
    });
  });

  describe("coordinateMigration", () => {
    it("should auto-register an existing local project when no projects are registered", async () => {
      const tempProjectDir = tempWorkspace("kb-coordinate-migration-");
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
      }
    });

    it("should return success for fresh-install state", async () => {
      // Close and remove central to simulate fresh state
      await central.close();
      const { rmSync } = await import("node:fs");
      rmSync(join(tempGlobalDir, "fusion-central.db"), { force: true });

      central = new CentralCore(tempGlobalDir);
      await central.init();

      // Change to fresh dir (no .fusion/)
      useIsolatedCwd("kb-fresh-coord-");

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.coordinateMigration();

      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should be a no-op in setup-wizard state when no local project exists", async () => {
      useIsolatedCwd("kb-setup-wizard-coord-");

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.coordinateMigration();

      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should be a no-op in normal-operation when projects already exist", async () => {
      const existingProjectDir = tempWorkspace("kb-normal-op-existing-");
      await central.registerProject({
        name: "Existing Project",
        path: existingProjectDir,
      });

      const localProjectDir = useIsolatedCwd("kb-normal-op-local-");
      createFakeKbProject(localProjectDir);

      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.coordinateMigration();

      expect(result.success).toBe(true);
      expect(result.projectsRegistered).toHaveLength(0);
      expect(result.errors).toHaveLength(0);

      const registered = await central.listProjects();
      expect(registered).toHaveLength(1);
    });
  });
});

describe("BackwardCompat", () => {
  let tempGlobalDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    tempGlobalDir = tempWorkspace("kb-compat-test-");
    central = new CentralCore(tempGlobalDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
  });

  describe("resolveProjectContext", () => {
    it("should use explicit project ID when provided", async () => {
      const tempProjectDir = tempWorkspace("kb-explicit-");
      const project = await central.registerProject({
        name: "Explicit Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/other/dir", project.id);

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);
      expect(context.isLegacy).toBe(false);
    });

    it("should auto-use single project when no explicit ID provided", async () => {
      const tempProjectDir = tempWorkspace("kb-single-");
      const project = await central.registerProject({
        name: "Single Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/other/dir");

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);
      expect(context.isLegacy).toBe(false);
    });

    it("should throw ProjectRequiredError when multiple projects and no selection", async () => {
      const tempProjectDir1 = tempWorkspace("kb-multi1-");
      const tempProjectDir2 = tempWorkspace("kb-multi2-");
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
    });

    it("should find project by name (case-insensitive)", async () => {
      const tempProjectDir = tempWorkspace("kb-byname-");
      const project = await central.registerProject({
        name: "My Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/dir", "my project");

      expect(context.projectId).toBe(project.id);
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
      const { rmSync } = await import("node:fs");
      rmSync(join(tempGlobalDir, "fusion-central.db"), { force: true });

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
    tempGlobalDir = tempWorkspace("kb-central-migration-test-");
    central = new CentralCore(tempGlobalDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
  });

  describe("autoRegisterProject", () => {
    it("should auto-register a project with generated name", async () => {
      const tempProjectDir = tempWorkspace("kb-autoreg-");
      createFakeKbProject(tempProjectDir);

      const project = await central.autoRegisterProject(tempProjectDir);

      expect(project).toBeDefined();
      expect(project.path).toBe(tempProjectDir);
      expect(project.isolationMode).toBe("in-process");
      expect(project.status).toBe("active");
      expect(project.name).toContain("kb-autoreg"); // Based on directory name
    });

    it("should reject nested auto-registration when parent project is already registered", async () => {
      const parentProjectDir = tempWorkspace("kb-central-parent-");
      createFakeKbProject(parentProjectDir);
      const nestedProjectDir = join(parentProjectDir, "packages", "nested");
      mkdirSync(nestedProjectDir, { recursive: true });
      createFakeKbProject(nestedProjectDir);

      await central.autoRegisterProject(parentProjectDir);

      await expect(central.autoRegisterProject(nestedProjectDir)).rejects.toThrow(/overlaps an existing registered project/);
    });

    it("should be idempotent - return existing project if already registered", async () => {
      const tempProjectDir = tempWorkspace("kb-autoreg-dup-");
      createFakeKbProject(tempProjectDir);

      const project1 = await central.autoRegisterProject(tempProjectDir);
      const project2 = await central.autoRegisterProject(tempProjectDir);

      expect(project1.id).toBe(project2.id);
      expect(project1.name).toBe(project2.name);
    });
  });

  describe("isProjectRegistered", () => {
    it("should return false for unregistered project", async () => {
      const tempProjectDir = tempWorkspace("kb-unreg-");

      const isRegistered = await central.isProjectRegistered(tempProjectDir);

      expect(isRegistered).toBe(false);
    });

    it("should return true for registered project", async () => {
      const tempProjectDir = tempWorkspace("kb-registered-");
      await central.registerProject({
        name: "Registered",
        path: tempProjectDir,
      });

      const isRegistered = await central.isProjectRegistered(tempProjectDir);

      expect(isRegistered).toBe(true);
    });
  });

  describe("getFirstRunState", () => {
    it("should return setup-wizard when no projects", async () => {
      const state = await central.getFirstRunState();
      expect(state).toBe("setup-wizard");
    });

    it("should return normal-operation when projects exist", async () => {
      const tempProjectDir = tempWorkspace("kb-state-test-");
      await central.registerProject({
        name: "State Test",
        path: tempProjectDir,
      });

      const state = await central.getFirstRunState();

      expect(state).toBe("normal-operation");
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
