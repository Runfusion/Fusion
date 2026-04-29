/**
 * Tests for project-context.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  resolveProject,
  getDefaultProject,
  setDefaultProject,
  clearDefaultProject,
  detectProjectFromCwd,
  formatProjectLine,
  getStoreForProject,
  clearStoreCache,
} from "../project-context.js";
import { CentralCore, GlobalSettingsStore, type RegisteredProject } from "@fusion/core";

describe("project-context", () => {
  let tempDir: string;
  let homeDir: string;
  let central: CentralCore;
  const createdProjectIds: string[] = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-test-"));
    homeDir = mkdtempSync(join(tmpdir(), "kb-home-"));
    central = new CentralCore(homeDir);
    await central.init();
  });

  afterEach(async () => {
    // Teardown order: entity cleanup first, then infrastructure, then filesystem
    // Unregister all tracked projects first
    for (const projectId of createdProjectIds) {
      try {
        await central.unregisterProject(projectId);
      } catch {
        // Ignore cleanup errors for already-removed entities
      }
    }
    createdProjectIds.length = 0;

    // Close CentralCore before filesystem cleanup
    try {
      await central.close();
    } catch {
      // Ignore close errors
    }
    clearStoreCache();

    // Filesystem cleanup last
    try {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createMockProject(name: string, parentDir: string = tempDir): string {
    const projectPath = join(parentDir, name);
    mkdirSync(join(projectPath, ".fusion"), { recursive: true });
    writeFileSync(join(projectPath, ".fusion", "fusion.db"), "");
    return projectPath;
  }

  describe("detectProjectFromCwd", () => {
    it("should find project from CWD when .fusion/fusion.db exists", async () => {
      const projectPath = createMockProject("my-project");
      const project = await central.registerProject({
        name: "my-project",
        path: resolve(projectPath),
      });
      createdProjectIds.push(project.id);

      const found = await detectProjectFromCwd(projectPath, central);

      expect(found).toBeDefined();
      expect(found?.id).toBe(project.id);
      expect(found?.name).toBe("my-project");
    });

    it("should walk up directory tree to find project", async () => {
      const projectPath = createMockProject("my-project");
      const subDir = join(projectPath, "src", "components");
      mkdirSync(subDir, { recursive: true });

      const project = await central.registerProject({
        name: "my-project",
        path: resolve(projectPath),
      });
      createdProjectIds.push(project.id);

      const found = await detectProjectFromCwd(subDir, central);

      expect(found).toBeDefined();
      expect(found?.id).toBe(project.id);
    });

    it("should return undefined when no project found", async () => {
      const randomDir = join(tempDir, "random");
      mkdirSync(randomDir, { recursive: true });

      const found = await detectProjectFromCwd(randomDir, central);

      expect(found).toBeUndefined();
    });

    it("should detect unregistered local project for legacy single-project usage", async () => {
      const projectPath = createMockProject("legacy-project");

      const found = await detectProjectFromCwd(projectPath, central);

      expect(found).toBeDefined();
      expect(found?.path).toBe(resolve(projectPath));
      expect(found?.name).toBe("legacy-project");
    });

    it("should ignore invalid fusion.db files in the cwd", async () => {
      const projectPath = join(tempDir, "invalid-project");
      mkdirSync(join(projectPath, ".fusion"), { recursive: true });
      writeFileSync(join(projectPath, ".fusion", "fusion.db"), "SQLite format 3\x00");

      const found = await detectProjectFromCwd(projectPath, central);

      expect(found).toBeUndefined();
    });
  });

  describe("formatProjectLine", () => {
    it("should format default project with asterisk", () => {
      const project: RegisteredProject = {
        id: "proj_123",
        name: "my-app",
        path: "/path/to/app",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      const line = formatProjectLine(project, true);

      expect(line).toContain("* ");
      expect(line).toContain("my-app");
      expect(line).toContain("/path/to/app");
      expect(line).toContain("[active]");
    });

    it("should format non-default project without asterisk", () => {
      const project: RegisteredProject = {
        id: "proj_456",
        name: "other-app",
        path: "/path/to/other",
        status: "paused",
        isolationMode: "child-process",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      const line = formatProjectLine(project, false);

      expect(line).not.toContain("*");
      expect(line).toContain("other-app");
      expect(line).toContain("[paused]");
    });
  });

  describe("resolveProject", () => {
    it("should throw for unknown project name", async () => {
      await expect(resolveProject("unknown-project", tempDir, homeDir)).rejects.toThrow(
        "not found"
      );
    });

    it("should resolve unregistered local project from cwd", async () => {
      const projectPath = createMockProject("legacy-project");

      const context = await resolveProject(undefined, projectPath, homeDir);

      expect(context.projectPath).toBe(resolve(projectPath));
      expect(context.projectName).toBe("legacy-project");
      expect(context.isRegistered).toBe(false);
    });

    it("should throw when no project can be resolved", async () => {
      const randomDir = join(tempDir, "no-project-here");
      mkdirSync(randomDir, { recursive: true });

      await expect(resolveProject(undefined, randomDir, homeDir)).rejects.toThrow(
        "No fusion project found"
      );
    });
  });
});
