import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { FirstRunExperience, createFirstRunExperience } from "../first-run.js";
import { CentralCore } from "../central-core.js";

// Helper to create a temp directory
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-first-run-test-"));
}

// Helper to create a fake kb project structure
function createFakeKbProject(dir: string): void {
  mkdirSync(join(dir, ".kb"), { recursive: true });
  writeFileSync(join(dir, ".kb", "kb.db"), "");
}

describe("FirstRunExperience", () => {
  let tempDir: string;
  let centralCore: CentralCore;
  let firstRun: FirstRunExperience;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    centralCore = new CentralCore(tempDir);
    await centralCore.init();
    // Create GlobalSettingsStore with temp directory for isolation
    const { GlobalSettingsStore } = await import("../global-settings.js");
    const globalSettingsStore = new GlobalSettingsStore(tempDir);
    await globalSettingsStore.init();
    firstRun = new FirstRunExperience(centralCore, globalSettingsStore);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("isFirstRun", () => {
    it("should return true when no projects registered", async () => {
      const result = await firstRun.isFirstRun();
      expect(result).toBe(true);
    });

    it("should return false when projects are registered", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });

      await centralCore.registerProject({
        name: "my-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      const result = await firstRun.isFirstRun();
      expect(result).toBe(false);
    });

    it("should return true when central core is not initialized", async () => {
      const uninitializedCore = new CentralCore(tempDir);
      const uninitializedFirstRun = new FirstRunExperience(uninitializedCore);

      const result = await uninitializedFirstRun.isFirstRun();
      expect(result).toBe(true);
    });
  });

  describe("detectOrCreateInitialProject", () => {
    it("should detect and register project from cwd", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      // Change to the project directory
      process.chdir(projectDir);

      const result = await firstRun.detectOrCreateInitialProject();

      expect(result.type).toBe("detected");
      if (result.type === "detected") {
        expect(result.project.name).toBe("my-project");
        // Use realpath comparison to handle macOS /private prefix
        const realProjectDir = await realpath(projectDir);
        expect(result.project.path).toBe(realProjectDir);
      }
    });

    it("should return manual-setup when no project in cwd", async () => {
      // Stay in tempDir which has no kb project
      process.chdir(tempDir);

      const result = await firstRun.detectOrCreateInitialProject();

      expect(result.type).toBe("manual-setup");
    });

    it("should return manual-setup with detected projects", async () => {
      // Create a project in a subdirectory
      const projectDir = join(tempDir, "sub-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      process.chdir(tempDir);

      const result = await firstRun.detectOrCreateInitialProject();

      expect(result.type).toBe("manual-setup");
      if (result.type === "manual-setup") {
        expect(result.detectedFromCwd).toBeDefined();
        expect(result.detectedFromCwd!.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getSetupState", () => {
    it("should return complete setup state for first run", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });
      createFakeKbProject(projectDir);

      process.chdir(tempDir);

      const state = await firstRun.getSetupState();

      expect(state.isFirstRun).toBe(true);
      expect(state.hasDetectedProjects).toBe(true);
      expect(state.detectedProjects.length).toBeGreaterThan(0);
      expect(state.registeredProjects).toHaveLength(0);
      expect(state.recommendedAction).toBe("auto-detect");
    });

    it("should return create-new when no projects detected", async () => {
      process.chdir(tempDir);

      const state = await firstRun.getSetupState();

      expect(state.isFirstRun).toBe(true);
      expect(state.hasDetectedProjects).toBe(false);
      expect(state.recommendedAction).toBe("create-new");
    });

    it("should return manual-setup when not first run and no projects", async () => {
      // Register a project first
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      await centralCore.registerProject({
        name: "existing",
        path: projectDir,
        isolationMode: "in-process",
      });

      process.chdir(tempDir);

      const state = await firstRun.getSetupState();

      expect(state.isFirstRun).toBe(false);
      expect(state.registeredProjects).toHaveLength(1);
      expect(state.recommendedAction).toBe("manual-setup");
    });
  });

  describe("completeSetup", () => {
    it("should register projects and return success", async () => {
      const projectDir = join(tempDir, "new-project");
      mkdirSync(projectDir, { recursive: true });

      const result = await firstRun.completeSetup([
        { path: projectDir, name: "new-project" },
      ]);

      expect(result.success).toBe(true);
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].name).toBe("new-project");
      expect(result.nextSteps.length).toBeGreaterThan(0);
    });

    it("should handle multiple projects", async () => {
      const project1 = join(tempDir, "project-1");
      const project2 = join(tempDir, "project-2");
      mkdirSync(project1, { recursive: true });
      mkdirSync(project2, { recursive: true });

      const result = await firstRun.completeSetup([
        { path: project1, name: "project-1" },
        { path: project2, name: "project-2" },
      ]);

      expect(result.success).toBe(true);
      expect(result.projects).toHaveLength(2);
    });

    it("should skip already registered projects", async () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });

      // Register first
      await centralCore.registerProject({
        name: "existing-project",
        path: projectDir,
        isolationMode: "in-process",
      });

      const result = await firstRun.completeSetup([
        { path: projectDir, name: "existing-project" },
      ]);

      expect(result.success).toBe(true);
      expect(result.projects).toHaveLength(1);
      // Should use the existing registration
      expect(result.projects[0].path).toBe(projectDir);
    });

    it("should handle invalid paths gracefully", async () => {
      const result = await firstRun.completeSetup([
        { path: "/non/existent/path", name: "invalid" },
      ]);

      expect(result.success).toBe(false);
      expect(result.projects).toHaveLength(0);
    });

    it("should set projects to active status", async () => {
      const projectDir = join(tempDir, "new-project");
      mkdirSync(projectDir, { recursive: true });

      const result = await firstRun.completeSetup([
        { path: projectDir, name: "new-project" },
      ]);

      expect(result.projects[0].status).toBe("active");
    });

    it("should be idempotent (running twice doesn't duplicate)", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });

      // First call
      const result1 = await firstRun.completeSetup([
        { path: projectDir, name: "my-project" },
      ]);
      expect(result1.success).toBe(true);

      // Second call - should not error or duplicate
      const result2 = await firstRun.completeSetup([
        { path: projectDir, name: "my-project" },
      ]);
      expect(result2.success).toBe(true);

      // Should still only have 1 project
      const projects = await centralCore.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("my-project");
    });

    it("should persist setupComplete in global settings", async () => {
      const projectDir = join(tempDir, "new-project");
      mkdirSync(projectDir, { recursive: true });

      // Before setup, setupComplete should not be set
      const settingsBefore = await firstRun["globalSettingsStore"].getSettings();
      expect(settingsBefore.setupComplete).toBeUndefined();

      // Complete setup
      await firstRun.completeSetup([{ path: projectDir, name: "new-project" }]);

      // After successful setup, setupComplete should be true
      const settingsAfter = await firstRun["globalSettingsStore"].getSettings();
      expect(settingsAfter.setupComplete).toBe(true);
    });

    it("should check setupComplete flag in isFirstRun", async () => {
      const projectDir = join(tempDir, "my-project");
      mkdirSync(projectDir, { recursive: true });

      // Initially should be first run
      expect(await firstRun.isFirstRun()).toBe(true);

      // Complete setup
      await firstRun.completeSetup([{ path: projectDir, name: "my-project" }]);

      // After setup, should NOT be first run (due to setupComplete flag)
      expect(await firstRun.isFirstRun()).toBe(false);
    });
  });

  describe("createFirstRunExperience", () => {
    it("should create a FirstRunExperience instance", () => {
      const instance = createFirstRunExperience(centralCore);
      expect(instance).toBeInstanceOf(FirstRunExperience);
    });
  });
});
