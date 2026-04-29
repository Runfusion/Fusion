/**
 * Tests for the init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../init.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const mockCentralInit = vi.fn();
const mockCentralClose = vi.fn();
const mockGetProjectByPath = vi.fn();
const mockRegisterProject = vi.fn();
const mockUpdateProject = vi.fn().mockResolvedValue({});
const { mockIsValidSqliteDatabaseFile } = vi.hoisted(() => ({
  mockIsValidSqliteDatabaseFile: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
      getProjectByPath: mockGetProjectByPath,
      registerProject: mockRegisterProject,
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

describe("init command", () => {
  let tempProjectDir: string;
  let tempHomeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tempProjectDir = tempDir("fn-init-test-");
    tempHomeDir = tempDir("fn-init-home-");
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    mockCentralInit.mockResolvedValue(undefined);
    mockCentralClose.mockResolvedValue(undefined);
    mockGetProjectByPath.mockResolvedValue(undefined);
    mockRegisterProject.mockResolvedValue({
      id: "proj_test",
      name: "test-project",
      path: tempProjectDir,
      isolationMode: "in-process",
    });
    mockIsValidSqliteDatabaseFile.mockImplementation((dbPath: string) => {
      if (!existsSync(dbPath)) {
        return false;
      }

      return readFileSync(dbPath).length === 0;
    });
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
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

  it("should create fusion.db when initializing", async () => {
    const dbPath = join(tempProjectDir, ".fusion", "fusion.db");
    expect(existsSync(dbPath)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBe(0);
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

  it("should be idempotent - report already initialized", async () => {
    // First init
    await runInit({ path: tempProjectDir });
    mockGetProjectByPath.mockResolvedValue({
      id: "proj_test",
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
    expect(existsSync(join(fusionDir, "fusion.db"))).toBe(true);
  });

  it("should add local storage directories to .gitignore when it doesn't exist", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toContain(".fusion");
    expect(content).toContain(".pi");
  });

  it("should append local storage directories to existing .gitignore", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\ndist\n");

    await runInit({ path: tempProjectDir });

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain("dist");
    expect(content).toContain(".fusion");
    expect(content).toContain(".pi");
  });

  it("should not duplicate local storage directories in .gitignore (idempotent)", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.fusion\n.pi\n");

    await runInit({ path: tempProjectDir });

    const content = readFileSync(gitignorePath, "utf-8");
    const fusionMatches = content.match(/\.fusion/g);
    const piMatches = content.match(/\.pi/g);
    expect(fusionMatches).toHaveLength(1);
    expect(piMatches).toHaveLength(1);
  });

  it("installs the bundled Fusion skill into Claude, Codex, and Gemini homes", async () => {
    await runInit({ path: tempProjectDir });

    const skillTargets = [
      join(tempHomeDir, ".claude", "skills", "fusion"),
      join(tempHomeDir, ".codex", "skills", "fusion"),
      join(tempHomeDir, ".gemini", "skills", "fusion"),
    ];

    for (const target of skillTargets) {
      expect(existsSync(join(target, "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "references", "extension-tools.md"))).toBe(true);
      expect(existsSync(join(target, "workflows", "task-management.md"))).toBe(true);
    }
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

    expect(existsSync(join(tempProjectDir, ".fusion", "fusion.db"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("Could not install bundled Fusion skill for Claude"))).toBe(true);
    expect(existsSync(join(tempHomeDir, ".codex", "skills", "fusion", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tempHomeDir, ".gemini", "skills", "fusion", "SKILL.md"))).toBe(true);
  });

  it("should add .pi when .fusion is already ignored", async () => {
    const gitignorePath = join(tempProjectDir, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.fusion\n");

    await runInit({ path: tempProjectDir });

    const content = readFileSync(gitignorePath, "utf-8");
    const fusionMatches = content.match(/\.fusion/g);
    const piMatches = content.match(/\.pi/g);
    expect(fusionMatches).toHaveLength(1);
    expect(piMatches).toHaveLength(1);
  });

  it("initializes git when --git is enabled in a non-git directory", async () => {
    expect(existsSync(join(tempProjectDir, ".git"))).toBe(false);

    await runInit({ path: tempProjectDir, git: true });

    expect(existsSync(join(tempProjectDir, ".git"))).toBe(true);
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

  it("does not create git repository without --git and logs a hint", async () => {
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

    expect(existsSync(join(tempProjectDir, ".git"))).toBe(false);
    expect(logs.join("\n")).toContain("Not a git repository. Run 'fn init --git' to auto-initialize one.");
  });
});
