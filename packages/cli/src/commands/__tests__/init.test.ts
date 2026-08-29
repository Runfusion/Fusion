/**
 * Tests for the init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../init.js";
import { installShippedSkillsIntoProject, SHIPPED_SKILL_NAMES, type ShippedSkillName } from "../claude-skills.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ensureProjectGitReadiness, GitRepositoryInitializationError } from "@fusion/core";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const execAsync = promisify(exec);

const mockCentralInit = vi.fn();
const mockCentralClose = vi.fn();
const mockGetProjectByPath = vi.fn();
const mockRegisterProject = vi.fn();
const mockEnsureProjectForPath = vi.fn();
const mockUpdateProject = vi.fn().mockResolvedValue({});
const { mockIsValidSqliteDatabaseFile, mockInstallSkillsForProject } = vi.hoisted(() => ({
  mockIsValidSqliteDatabaseFile: vi.fn(),
  mockInstallSkillsForProject: vi.fn(() => []),
}));

vi.mock("../claude-skills-runner.js", () => ({
  maybeInstallClaudeSkillForNewProject: mockInstallSkillsForProject,
  ensureClaudeSkillsForAllProjectsOnStartup: vi.fn(() => []),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: makeConstructibleMock(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
      getProjectByPath: mockGetProjectByPath,
      registerProject: mockRegisterProject,
      ensureProjectForPath: mockEnsureProjectForPath,
      updateProject: mockUpdateProject,
    })),
    isQmdAvailable: vi.fn(() => Promise.resolve(true)),
    QMD_INSTALL_COMMAND: "bun install -g @tobilu/qmd",
    resolveGlobalDir: vi.fn(),
    isValidSqliteDatabaseFile: (...args: Parameters<typeof mockIsValidSqliteDatabaseFile>) =>
      mockIsValidSqliteDatabaseFile(...args),
  };
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function git(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, timeout: 10_000 });
  return stdout.trim();
}

const localStorageGitignoreEntries = [
  ".fusion/",
  ".pi/",
  ".worktrees/",
  "fusion.db",
  "fusion.db-wal",
  "fusion.db-shm",
] as const;

function toLines(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.length > 0);
}

describe("init command", () => {
  let tempProjectDir: string;
  let tempHomeDir: string;
  const isolatedHome = process.env.HOME;
  const isolatedUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    tempProjectDir = tempDir("fn-init-test-");
    tempHomeDir = tempDir("fn-init-home-");
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    mockInstallSkillsForProject.mockClear();
    mockCentralInit.mockResolvedValue(undefined);
    mockCentralClose.mockResolvedValue(undefined);
    mockGetProjectByPath.mockResolvedValue(undefined);
    mockRegisterProject.mockResolvedValue({
      id: "proj_1234567890abcdef",
      name: "test-project",
      path: tempProjectDir,
      isolationMode: "in-process",
      status: "initializing",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "",
    });
    mockEnsureProjectForPath.mockImplementation(async ({ path }: { path: string }) => {
      const gitReadiness = await ensureProjectGitReadiness(path);
      return {
        outcome: "registered" as const,
        gitRepository: gitReadiness.outcome,
        integrationBranches: gitReadiness.integrationBranches,
        project: {
          id: "proj_1234567890abcdef",
          name: "test-project",
          path,
          isolationMode: "in-process" as const,
          status: "initializing" as const,
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "",
        },
      };
    });
    mockIsValidSqliteDatabaseFile.mockImplementation((dbPath: string) => {
      if (!existsSync(dbPath)) {
        return false;
      }

      const content = readFileSync(dbPath);
      return content.subarray(0, 15).toString("utf8") === "SQLite format 3";
    });
  });

  afterEach(() => {
    if (isolatedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = isolatedHome;
    }
    if (isolatedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = isolatedUserProfile;
    }

    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
    if (existsSync(tempHomeDir)) {
      rmSync(tempHomeDir, { recursive: true, force: true });
    }
  });

  it("should create .fusion/ directory when initializing", async () => {
    const fusionDir = join(tempProjectDir, ".fusion");
    expect(existsSync(fusionDir)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(fusionDir)).toBe(true);
  });

  it("should create project.json without creating fusion.db when initializing", async () => {
    const markerPath = join(tempProjectDir, ".fusion", "project.json");
    const dbPath = join(tempProjectDir, ".fusion", "fusion.db");
    expect(existsSync(markerPath)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(markerPath)).toBe(true);
    expect(statSync(markerPath).size).toBeGreaterThan(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("should repair a missing project identity for an existing central registration", async () => {
    const markerPath = join(tempProjectDir, ".fusion", "project.json");
    mkdirSync(join(tempProjectDir, ".fusion"), { recursive: true });
    mockGetProjectByPath.mockResolvedValueOnce({
      id: "proj_1234567890abcdef",
      name: "registered-project",
      path: tempProjectDir,
      isolationMode: "in-process",
      status: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    mockEnsureProjectForPath.mockClear();

    await runInit({ path: tempProjectDir });

    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      id: "proj_1234567890abcdef",
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    expect(mockEnsureProjectForPath).toHaveBeenCalledWith(expect.objectContaining({ path: tempProjectDir }));
  });

  it("should reject existing invalid fusion.db files", async () => {
    const fusionDir = join(tempProjectDir, ".fusion");
    const dbPath = join(fusionDir, "fusion.db");
    mkdirSync(fusionDir, { recursive: true });
    writeFileSync(dbPath, "not a sqlite database");

    await expect(runInit({ path: tempProjectDir })).rejects.toThrow(
      `Existing database at ${dbPath} is not a valid SQLite database.`,
    );
  });

  it("propagates Git initialization failures instead of reporting local init success", async () => {
    const error = new GitRepositoryInitializationError(tempProjectDir, "git is not installed");
    mockEnsureProjectForPath.mockRejectedValueOnce(error);

    await expect(runInit({ path: tempProjectDir })).rejects.toBe(error);
    expect(mockCentralClose).toHaveBeenCalled();
  });

  it("should be idempotent - report already initialized", async () => {
    // First init
    await runInit({ path: tempProjectDir });
    mockGetProjectByPath.mockResolvedValue({
      id: "proj_1234567890abcdef",
      name: "registered-project",
      path: tempProjectDir,
      isolationMode: "in-process",
    });

    // Capture console output for second run
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      // Second init - should report already initialized
      await runInit({ path: tempProjectDir });

      const logString = logs.join("\n");
      expect(logString).toContain("already initialized");
    } finally {
      console.log = originalLog;
    }
  });

  it("should use provided name option", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runInit({ path: tempProjectDir, name: "custom-name" });

      const logString = logs.join("\n");
      expect(logString).toContain("custom-name");
    } finally {
      console.log = originalLog;
    }
  });

  it("should not require .fusion directory to exist before init", async () => {
    const fusionDir = join(tempProjectDir, ".fusion");
    expect(existsSync(fusionDir)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(fusionDir)).toBe(true);
    expect(existsSync(join(fusionDir, "project.json"))).toBe(true);
    expect(existsSync(join(fusionDir, "fusion.db"))).toBe(false);
  });

  it("should add local storage directories to .gitignore when it doesn't exist", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(gitignorePath)).toBe(true);
    const lines = toLines(readFileSync(gitignorePath, "utf-8"));
    for (const entry of localStorageGitignoreEntries) {
      expect(lines).toContain(entry);
    }
  });

  it("should append local storage directories to existing .gitignore", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\ndist\n");

    await runInit({ path: tempProjectDir });

    const lines = toLines(readFileSync(gitignorePath, "utf-8"));
    expect(lines).toContain("node_modules");
    expect(lines).toContain("dist");
    for (const entry of localStorageGitignoreEntries) {
      expect(lines).toContain(entry);
    }
  });

  it("should not duplicate local storage directories in .gitignore (idempotent)", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    writeFileSync(
      gitignorePath,
      `node_modules\n${localStorageGitignoreEntries.join("\n")}\n`,
    );

    await runInit({ path: tempProjectDir });

    const lines = toLines(readFileSync(gitignorePath, "utf-8"));
    for (const entry of localStorageGitignoreEntries) {
      expect(lines.filter((line) => line === entry)).toHaveLength(1);
    }
  });

  it("C1: fn init reconciles every shipped skill for its new project", async () => {
    /* FNXC:ComputerUseSkill 2026-08-11-14:30: The init call-site contract is
     * outcomes, not just delegation: both shipped skills must reconcile. */
    const sources = Object.fromEntries(SHIPPED_SKILL_NAMES.map((skillName) => {
      const source = join(tempProjectDir, "sources", skillName);
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "SKILL.md"), `name: ${skillName}`);
      return [skillName, source];
    })) as Record<ShippedSkillName, string>;
    mockInstallSkillsForProject.mockImplementationOnce((path: string) =>
      installShippedSkillsIntoProject(path, { enabled: true, sources }));

    await runInit({ path: tempProjectDir });

    expect(mockInstallSkillsForProject).toHaveBeenCalledWith(tempProjectDir);
    expect(mockInstallSkillsForProject.mock.results[0]?.value.map((result: { outcome: string }) => result.outcome)).toEqual(["installed", "installed"]);
    for (const skillName of SHIPPED_SKILL_NAMES) {
      expect(existsSync(join(tempProjectDir, ".claude", "skills", skillName, "SKILL.md"))).toBe(true);
    }
  });

  it("installs both bundled skills into Claude, Codex, and Gemini homes", async () => {
    await runInit({ path: tempProjectDir });

    for (const client of [".claude", ".codex", ".gemini"]) {
      for (const skillName of ["fusion", "computer-use"]) {
        expect(existsSync(join(tempHomeDir, client, "skills", skillName, "SKILL.md"))).toBe(true);
      }
    }
    const fusionTarget = join(tempHomeDir, ".claude", "skills", "fusion");
    expect(existsSync(join(fusionTarget, "references", "extension-tools.md"))).toBe(true);
    expect(existsSync(join(fusionTarget, "workflows", "task-management.md"))).toBe(true);
  });

  it("preserves existing Fusion skill directories instead of overwriting", async () => {
    const existingSkillDir = join(tempHomeDir, ".claude", "skills", "fusion");
    mkdirSync(existingSkillDir, { recursive: true });
    writeFileSync(join(existingSkillDir, "SKILL.md"), "custom skill content\n");

    await runInit({ path: tempProjectDir });

    expect(readFileSync(join(existingSkillDir, "SKILL.md"), "utf-8")).toBe("custom skill content\n");
    expect(existsSync(join(existingSkillDir, "references", "extension-tools.md"))).toBe(false);
  });

  it("logs skill install warnings without aborting init", async () => {
    const blockedClaudePath = join(tempHomeDir, ".claude");
    writeFileSync(blockedClaudePath, "blocked");

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      await runInit({ path: tempProjectDir });
    } finally {
      console.warn = originalWarn;
    }

    expect(existsSync(join(tempProjectDir, ".fusion", "project.json"))).toBe(true);
    expect(existsSync(join(tempProjectDir, ".fusion", "fusion.db"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("Could not install bundled Fusion skill for Claude"))).toBe(true);
    expect(existsSync(join(tempHomeDir, ".codex", "skills", "fusion", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tempHomeDir, ".gemini", "skills", "fusion", "SKILL.md"))).toBe(true);
  });

  it("should add .pi and fusion.db entries when .fusion is already ignored", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.fusion\n");

    await runInit({ path: tempProjectDir });

    const lines = toLines(readFileSync(gitignorePath, "utf-8"));
    expect(lines.filter((line) => line === ".fusion")).toHaveLength(1);
    for (const entry of [".pi/", ".worktrees/", "fusion.db", "fusion.db-wal", "fusion.db-shm"]) {
      expect(lines.filter((line) => line === entry)).toHaveLength(1);
    }
  });

  it("does not modify .gitignore when all local storage entries are already present", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    const existingContent = `node_modules\n${localStorageGitignoreEntries.join("\n")}\n`;
    writeFileSync(gitignorePath, existingContent);

    await runInit({ path: tempProjectDir });

    const contentAfterInit = readFileSync(gitignorePath, "utf-8");
    expect(contentAfterInit).toBe(existingContent);
  });

  it.each([false, true])("creates execution-ready Git state by default and with --git=%s", async (compatibilityFlag) => {
    expect(existsSync(join(tempProjectDir, ".git"))).toBe(false);

    await runInit({ path: tempProjectDir, ...(compatibilityFlag ? { git: true } : {}) });

    expect(existsSync(join(tempProjectDir, ".git"))).toBe(true);
    await expect(git("git rev-parse --verify HEAD^{commit}", tempProjectDir)).resolves.toMatch(/^[0-9a-f]+$/);
    const tree = await git("git ls-tree -r --name-only HEAD", tempProjectDir);
    expect(tree).toBe(".gitignore");
    const worktree = join(tempProjectDir, "task-worktree");
    await git(`git worktree add -b fusion/init-${compatibilityFlag ? "git" : "default"} ${worktree} HEAD`, tempProjectDir);
    await git(`git worktree remove --force ${worktree}`, tempProjectDir);
    for (const entry of localStorageGitignoreEntries) {
      expect(toLines(readFileSync(join(tempProjectDir, ".gitignore"), "utf8"))).toContain(entry);
    }
  });

  it("creates an initial commit when --git initializes a repository", async () => {
    await runInit({ path: tempProjectDir, git: true });

    const commitCount = await git("git rev-list --count HEAD", tempProjectDir);
    expect(Number(commitCount)).toBeGreaterThanOrEqual(1);
  });

  it("does not reinitialize git when repository already exists", async () => {
    await git("git init", tempProjectDir);
    await git("git checkout -b main", tempProjectDir);
    await git('git config user.name "Existing User"', tempProjectDir);
    await git('git config user.email "existing@example.com"', tempProjectDir);
    writeFileSync(join(tempProjectDir, "README.md"), "# Existing Repo\n");
    await git("git add README.md", tempProjectDir);
    await git('git commit -m "existing commit"', tempProjectDir);

    await runInit({ path: tempProjectDir, git: true });

    const commitCount = await git("git rev-list --count HEAD", tempProjectDir);
    expect(Number(commitCount)).toBe(1);
  });

  it("delegates registration without --git and does not log a manual git hint", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runInit({ path: tempProjectDir });
    } finally {
      console.log = originalLog;
    }

    expect(existsSync(join(tempProjectDir, ".git"))).toBe(true);
    expect(mockEnsureProjectForPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tempProjectDir,
      }),
    );
    expect(logs.join("\n")).not.toContain("Not a git repository");
  });

  it("logs when shared registration initializes git without --git", async () => {
    mockEnsureProjectForPath.mockResolvedValueOnce({
      outcome: "registered",
      gitRepository: "initialized",
      integrationBranches: [{ repoRelPath: ".", branch: "master", source: "well-known-local", action: "existing" }],
      project: {
        id: "proj_1234567890abcdef",
        name: "test-project",
        path: tempProjectDir,
        isolationMode: "in-process",
        status: "initializing",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "",
      },
    });

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runInit({ path: tempProjectDir });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("Initialized git repository");
    expect(logs.join("\n")).toContain("Integration branch: master (existing)");
  });

  it("reports an unavailable integration-branch reconciliation without failing init", async () => {
    mockEnsureProjectForPath.mockResolvedValueOnce({
      outcome: "registered",
      gitRepository: "existing",
      integrationBranches: [{
        repoRelPath: ".",
        branch: "release/9.9",
        source: "configured",
        action: "unavailable",
        reason: "test branch write failure",
      }],
      project: {
        id: "proj_1234567890abcdef",
        name: "test-project",
        path: tempProjectDir,
        isolationMode: "in-process",
        status: "initializing",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "",
      },
    });
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runInit({ path: tempProjectDir });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("Integration branch: release/9.9 (unavailable)");
  });
});
