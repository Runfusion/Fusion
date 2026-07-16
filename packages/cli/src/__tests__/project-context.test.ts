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
  closeProjectStore,
  clearStoreCache,
} from "../project-context.js";
import { CentralCore, GlobalSettingsStore, type RegisteredProject } from "@fusion/core";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { beforeAll, afterAll } from "vitest";

/*
FNXC:ProjectContextTests 2026-07-16-09:00:
CentralCore tests require PostgreSQL, but booting its embedded postmaster for every test races other forked CLI files under load. Use the shared external pg test harness and skip only CentralCore coverage when PostgreSQL is unavailable; pure formatting coverage remains ungated below.
*/
pgDescribe("project-context (PostgreSQL-backed detection)", () => {
  let h: PgTestHarness;
  let tempDir: string;
  let homeDir: string;
  let central: CentralCore;
  let previousDatabaseUrl: string | undefined;
  const createdProjectIds: string[] = [];

  beforeAll(async () => {
    h = await createTaskStoreForTest({ prefix: "fusion_cli_project_ctx_detection" });
  });

  afterAll(async () => {
    await h.teardown();
  });

  beforeEach(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = h.testUrl;
    tempDir = mkdtempSync(join(tmpdir(), "kb-test-"));
    homeDir = mkdtempSync(join(tmpdir(), "kb-home-"));
    central = new CentralCore(homeDir, { asyncLayer: h.layer });
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
    await clearStoreCache();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }

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
    // FNXC:PostgresCutover 2026-07-05-17:30: the registerProject-dependent
    // detect tests moved to the PostgreSQL-backed block at the bottom of this
    // file — CentralCore writes require an AsyncDataLayer (legacy SQLite
    // CentralDatabase was removed under VAL-REMOVAL-005).

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

    it("detects an unregistered project.json marker without fusion.db", async () => {
      const projectPath = join(tempDir, "postgres-project");
      mkdirSync(join(projectPath, ".fusion"), { recursive: true });
      writeFileSync(join(projectPath, ".fusion", "project.json"), JSON.stringify({
        id: "proj_1234567890abcdef",
        createdAt: "2026-07-14T00:00:00.000Z",
      }));

      const found = await detectProjectFromCwd(projectPath, central);

      expect(found).toMatchObject({ path: resolve(projectPath), name: "postgres-project" });
    });

    it("should not inherit an unregistered parent project from a nested cwd", async () => {
      const projectPath = createMockProject("legacy-project");
      const nestedDir = join(projectPath, "src", "components");
      mkdirSync(nestedDir, { recursive: true });

      const found = await detectProjectFromCwd(nestedDir, central);

      expect(found).toBeUndefined();
    });

    it("should ignore invalid fusion.db files in the cwd", async () => {
      const projectPath = join(tempDir, "invalid-project");
      mkdirSync(join(projectPath, ".fusion"), { recursive: true });
      writeFileSync(join(projectPath, ".fusion", "fusion.db"), "SQLite format 3\x00");

      const found = await detectProjectFromCwd(projectPath, central);

      expect(found).toBeUndefined();
    });
  });

  describe("resolveProject", () => {
    it("should throw for unknown project name", async () => {
      await expect(resolveProject("unknown-project", tempDir, homeDir)).rejects.toThrow(
        "not found"
      );
    });

    // FNXC:PostgresCutover 2026-07-05-17:30: "resolves unregistered local
    // project from cwd" moved to the PostgreSQL-backed block below — it boots
    // a real project store through the startup factory, which must target the
    // test cluster (DATABASE_URL) instead of spawning embedded PostgreSQL
    // inside a unit-test worker.

    it("should throw when no project can be resolved", async () => {
      const randomDir = join(tempDir, "no-project-here");
      mkdirSync(randomDir, { recursive: true });

      await expect(resolveProject(undefined, randomDir, homeDir)).rejects.toThrow(
        "No fusion project found"
      );
    });
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

/*
FNXC:PostgresCutover 2026-07-05-17:30:
PostgreSQL-backed CentralCore coverage for project-context. The legacy SQLite
CentralDatabase was removed (VAL-REMOVAL-005): registerProject and the
factory-booted store paths need a real AsyncDataLayer. Auto-skipped when
PostgreSQL is unreachable (pgDescribe), matching the core pg suites.
*/
pgDescribe("project-context (PostgreSQL-backed CentralCore)", () => {
  let h: PgTestHarness;
  let tempDir: string;
  let homeDir: string;
  let central: CentralCore;
  const createdProjectIds: string[] = [];

  beforeAll(async () => {
    h = await createTaskStoreForTest({ prefix: "fusion_cli_project_ctx" });
  });

  afterAll(async () => {
    await h.teardown();
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-test-pg-"));
    homeDir = mkdtempSync(join(tmpdir(), "kb-home-pg-"));
    central = new CentralCore(homeDir, { asyncLayer: h.layer });
    await central.init();
  });

  afterEach(async () => {
    for (const projectId of createdProjectIds) {
      try {
        await central.unregisterProject(projectId);
      } catch {
        // Ignore cleanup errors for already-removed entities
      }
    }
    createdProjectIds.length = 0;
    try {
      await central.close();
    } catch {
      // Ignore close errors
    }
    await clearStoreCache();
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

  it("should resolve unregistered local project from cwd", async () => {
    const projectPath = createMockProject("legacy-project");
    // Point the startup factory at the test cluster so createLocalStore
    // connects externally instead of spawning an embedded PostgreSQL
    // subprocess inside the test worker.
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = h.testUrl;
    try {
      const context = await resolveProject(undefined, projectPath, homeDir);

      expect(context.projectPath).toBe(resolve(projectPath));
      expect(context.projectName).toBe("legacy-project");
      expect(context.isRegistered).toBe(false);
      /*
      FNXC:PostgresCliLifecycle 2026-07-14-22:25:
      A resolved ProjectContext owns both its factory-backed TaskStore and the CentralCore retained during resolution. Tests and commands must close that aggregate through closeProjectStore so the central PostgreSQL pool cannot outlive the context and block database teardown.
      */
      await closeProjectStore(context);
    } finally {
      if (prevDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDatabaseUrl;
      }
    }
  });
});
