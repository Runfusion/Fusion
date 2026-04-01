/**
 * Tests for backward compatibility layer
 *
 * Ensures single-project workflows continue working without --project flags.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackwardCompat, ProjectRequiredError } from "./migration.js";
import { CentralCore } from "./central-core.js";

// Helper to create temp directories
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Helper to create a fake kb project
function createFakeKbProject(dir: string): void {
  const kbDir = join(dir, ".kb");
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, "kb.db"), "SQLite format 3\x00");
}

describe("Backward Compatibility Layer", () => {
  let tempGlobalDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    tempGlobalDir = tempDir("kb-backward-compat-test-");
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

  describe("single project auto-resolution", () => {
    it("should auto-resolve single project without --project flag", async () => {
      const tempProjectDir = tempDir("kb-single-compat-");
      const project = await central.registerProject({
        name: "Single Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      // No projectId provided - should auto-resolve to single project
      const context = await compat.resolveProjectContext("/any/dir");

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);
      expect(context.isLegacy).toBe(false);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should auto-resolve the single registered project even when cwd is unrelated", async () => {
      const tempProjectDir = tempDir("kb-single-path-match-");
      const unrelatedDir = tempDir("kb-single-unrelated-");
      const project = await central.registerProject({
        name: "Path Match Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext(unrelatedDir);

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);

      rmSync(tempProjectDir, { recursive: true, force: true });
      rmSync(unrelatedDir, { recursive: true, force: true });
    });

    it("should use explicit project ID when provided", async () => {
      const tempProjectDir = tempDir("kb-explicit-compat-");
      const project = await central.registerProject({
        name: "Explicit Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/dir", project.id);

      expect(context.projectId).toBe(project.id);
      expect(context.workingDirectory).toBe(tempProjectDir);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });

    it("should find project by name (case-insensitive)", async () => {
      const tempProjectDir = tempDir("kb-name-compat-");
      const project = await central.registerProject({
        name: "My Awesome Project",
        path: tempProjectDir,
      });

      const compat = new BackwardCompat(central);
      // Use lowercase name - should still find it
      const context = await compat.resolveProjectContext("/some/dir", "my awesome project");

      expect(context.projectId).toBe(project.id);

      rmSync(tempProjectDir, { recursive: true, force: true });
    });
  });

  describe("multiple projects requires explicit selection", () => {
    it("should throw ProjectRequiredError when multiple projects and no selection", async () => {
      const tempProjectDir1 = tempDir("kb-multi-compat1-");
      const tempProjectDir2 = tempDir("kb-multi-compat2-");
      const project1 = await central.registerProject({
        name: "Project One",
        path: tempProjectDir1,
      });
      const project2 = await central.registerProject({
        name: "Project Two",
        path: tempProjectDir2,
      });

      const compat = new BackwardCompat(central);

      await expect(compat.resolveProjectContext("/some/dir")).rejects.toThrow(
        ProjectRequiredError
      );

      try {
        await compat.resolveProjectContext("/some/dir");
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectRequiredError);
        // Should provide list of available projects
        expect((err as ProjectRequiredError).availableProjects).toHaveLength(2);
        const ids = (err as ProjectRequiredError).availableProjects.map((p) => p.id);
        expect(ids).toContain(project1.id);
        expect(ids).toContain(project2.id);
      }

      rmSync(tempProjectDir1, { recursive: true, force: true });
      rmSync(tempProjectDir2, { recursive: true, force: true });
    });

    it("should resolve correctly when explicit project provided with multiple projects", async () => {
      const tempProjectDir1 = tempDir("kb-multi-explicit1-");
      const tempProjectDir2 = tempDir("kb-multi-explicit2-");
      const project1 = await central.registerProject({
        name: "Project One",
        path: tempProjectDir1,
      });
      await central.registerProject({
        name: "Project Two",
        path: tempProjectDir2,
      });

      const compat = new BackwardCompat(central);
      // Explicitly select project1
      const context = await compat.resolveProjectContext("/some/dir", project1.id);

      expect(context.projectId).toBe(project1.id);
      expect(context.workingDirectory).toBe(tempProjectDir1);

      rmSync(tempProjectDir1, { recursive: true, force: true });
      rmSync(tempProjectDir2, { recursive: true, force: true });
    });

    it("should require explicit selection when cwd is inside one of multiple projects", async () => {
      const tempProjectDir1 = tempDir("kb-multi-cwd1-");
      const tempProjectDir2 = tempDir("kb-multi-cwd2-");
      const nestedDir = join(tempProjectDir1, "src", "nested");
      mkdirSync(nestedDir, { recursive: true });
      await central.registerProject({
        name: "Project One",
        path: tempProjectDir1,
      });
      await central.registerProject({
        name: "Project Two",
        path: tempProjectDir2,
      });

      const compat = new BackwardCompat(central);
      await expect(compat.resolveProjectContext(nestedDir)).rejects.toThrow(ProjectRequiredError);

      rmSync(tempProjectDir1, { recursive: true, force: true });
      rmSync(tempProjectDir2, { recursive: true, force: true });
    });

    it("should require explicit selection when cwd is outside all registered projects", async () => {
      const tempProjectDir1 = tempDir("kb-multi-outside1-");
      const tempProjectDir2 = tempDir("kb-multi-outside2-");
      const unrelatedDir = tempDir("kb-multi-outside-unrelated-");
      await central.registerProject({
        name: "Project One",
        path: tempProjectDir1,
      });
      await central.registerProject({
        name: "Project Two",
        path: tempProjectDir2,
      });

      const compat = new BackwardCompat(central);
      await expect(compat.resolveProjectContext(unrelatedDir)).rejects.toThrow(ProjectRequiredError);

      rmSync(tempProjectDir1, { recursive: true, force: true });
      rmSync(tempProjectDir2, { recursive: true, force: true });
      rmSync(unrelatedDir, { recursive: true, force: true });
    });
  });

  describe("legacy mode without central database", () => {
    it("should return legacy mode when no central DB", async () => {
      // Close and remove central DB
      await central.close();
      rmSync(join(tempGlobalDir, "kb-central.db"), { force: true });

      // Re-create central but don't init
      central = new CentralCore(tempGlobalDir);

      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext("/some/legacy/dir");

      expect(context.isLegacy).toBe(true);
      expect(context.projectId).toBe("legacy");
      expect(context.workingDirectory).toBe("/some/legacy/dir");
    });

    it("should report legacy mode correctly", async () => {
      // Close and remove central DB
      await central.close();
      rmSync(join(tempGlobalDir, "kb-central.db"), { force: true });

      central = new CentralCore(tempGlobalDir);

      const compat = new BackwardCompat(central);
      expect(await compat.isLegacyMode()).toBe(true);
    });

    it("should report non-legacy mode when central DB exists", async () => {
      const compat = new BackwardCompat(central);
      expect(await compat.isLegacyMode()).toBe(false);
    });
  });

  describe("no implicit mutation during resolve", () => {
    it("should not auto-register a project found in cwd when no projects are registered", async () => {
      const projectDir = tempDir("kb-no-auto-migrate-compat-");
      createFakeKbProject(projectDir);

      const compat = new BackwardCompat(central);

      await expect(compat.resolveProjectContext(projectDir)).rejects.toThrow(ProjectRequiredError);

      const isRegistered = await central.isProjectRegistered(projectDir);
      expect(isRegistered).toBe(false);

      rmSync(projectDir, { recursive: true, force: true });
    });
  });

  describe("error messages", () => {
    it("should provide helpful error when project not found", async () => {
      const compat = new BackwardCompat(central);

      await expect(
        compat.resolveProjectContext("/some/dir", "nonexistent-project")
      ).rejects.toThrow(/not found/i);
    });

    it("should provide helpful error when no projects registered", async () => {
      const compat = new BackwardCompat(central);

      await expect(compat.resolveProjectContext("/some/dir")).rejects.toThrow(
        /no projects registered/i
      );
    });
  });
});

describe("ProjectRequiredError backward compat", () => {
  it("should include both id and name for each available project", () => {
    const available = [
      { id: "proj_abc123", name: "Frontend" },
      { id: "proj_def456", name: "Backend" },
      { id: "proj_ghi789", name: "Docs" },
    ];

    const error = new ProjectRequiredError(
      "Multiple projects available",
      available
    );

    expect(error.availableProjects).toHaveLength(3);
    expect(error.availableProjects[0]).toHaveProperty("id");
    expect(error.availableProjects[0]).toHaveProperty("name");
  });

  it("should be catchable as ProjectRequiredError", async () => {
    const error = new ProjectRequiredError("test", []);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProjectRequiredError);
    expect(error.name).toBe("ProjectRequiredError");
  });
});
